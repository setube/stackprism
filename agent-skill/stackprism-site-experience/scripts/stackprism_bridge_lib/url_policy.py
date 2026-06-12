import ipaddress
import re
import socket
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from urllib.parse import urlparse, urlunparse

from .protocol import PROTOCOL_VERSION


REQUEST_KEYS = {"url", "mode", "waitMs", "include", "viewports", "options"}
OPTION_KEYS = {
    "forceRefresh", "captureScreenshotMetadata", "captureScreenshot", "keepTabOpen",
    "allowPrivateNetworkTarget", "targetMode", "maxResourceUrls",
}
BOOLEAN_OPTION_KEYS = {"forceRefresh", "captureScreenshotMetadata", "captureScreenshot", "keepTabOpen", "allowPrivateNetworkTarget"}
INCLUDE_ORDER = ["tech", "visual", "layout", "components", "interaction", "ux", "assets"]
TARGET_MODES = {"reuse_or_new_tab", "new_tab", "active_tab"}
DNS_LOOKUP_TIMEOUT_SECONDS = 2.0
_DNS_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="stackprism-dns")
PRIVATE_IP_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
        "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
        "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
        "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
        "::/128", "::1/128", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32",
        "2002::/16", "3fff::/20", "fc00::/7", "fe80::/10", "ff00::/8",
    )
)
PROXY_RESERVED_IP_NETWORKS = tuple(ipaddress.ip_network(network) for network in ("198.18.0.0/15",))
PUBLIC_IP_EXCEPTIONS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "192.0.0.9/32",
        "192.0.0.10/32",
        "2001:1::1/128",
        "2001:1::2/128",
        "2001:3::/32",
        "2001:4:112::/48",
        "2001:20::/28",
        "2001:30::/28",
    )
)


def is_strict_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def parse_ip_address(hostname):
    host = (hostname or "").strip("[]")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        try:
            address = ipaddress.ip_address(socket.inet_aton(host))
        except OSError:
            return None
    if getattr(address, "ipv4_mapped", None):
        address = address.ipv4_mapped
    elif address.version == 6 and address.packed.startswith(b"\x00" * 12) and int(address) > 0xFFFF:
        address = ipaddress.ip_address(address.packed[-4:])
    return address


def is_private_host(hostname):
    if (hostname or "").strip("[]").lower() == "localhost":
        return True
    address = parse_ip_address(hostname)
    if address is None:
        return False
    return any(address in network for network in PRIVATE_IP_NETWORKS) and not any(address in network for network in PUBLIC_IP_EXCEPTIONS)


def is_proxy_reserved_host(hostname):
    address = parse_ip_address(hostname)
    if address is None:
        return False
    return any(address in network for network in PROXY_RESERVED_IP_NETWORKS)


def is_ip_literal(hostname):
    return parse_ip_address(hostname) is not None


def default_resolve_hostname(hostname):
    future = _DNS_EXECUTOR.submit(socket.getaddrinfo, hostname, None, 0, socket.SOCK_STREAM)
    try:
        return [item[4][0] for item in future.result(timeout=DNS_LOOKUP_TIMEOUT_SECONDS)]
    except TimeoutError as exc:
        future.cancel()
        raise TimeoutError("DNS lookup timed out.") from exc


def validate_dns_policy(hostname, allow_private_network_target, resolver):
    if allow_private_network_target or is_ip_literal(hostname):
        return None, None
    try:
        addresses = resolver(hostname)
    except Exception:
        return "TARGET_DNS_LOOKUP_FAILED", {"reason": "dns_lookup_failed"}
    if not isinstance(addresses, list) or not addresses:
        return "TARGET_DNS_LOOKUP_FAILED", {"reason": "dns_lookup_failed"}
    if any(is_private_host(str(address)) and not is_proxy_reserved_host(str(address)) for address in addresses):
        return "PRIVATE_NETWORK_TARGET_BLOCKED", {"reason": "private_network_address"}
    return None, None


def valid_viewports(viewports):
    if not isinstance(viewports, list) or len(viewports) > 3:
        return False
    for viewport in viewports:
        if not isinstance(viewport, dict) or not set(viewport.keys()).issubset({"name", "width", "height", "deviceScaleFactor"}):
            return False
        name = viewport.get("name")
        if name is not None and (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name)):
            return False
        if not is_strict_int(viewport.get("width")) or not 320 <= viewport["width"] <= 3840:
            return False
        if not is_strict_int(viewport.get("height")) or not 320 <= viewport["height"] <= 2160:
            return False
        scale = viewport.get("deviceScaleFactor")
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not 1 <= scale <= 4:
            return False
    return True


def normalize_options(options):
    if not isinstance(options, dict) or not set(options.keys()).issubset(OPTION_KEYS):
        return None, "Unknown capture option field."
    for key in BOOLEAN_OPTION_KEYS:
        if key in options and not isinstance(options[key], bool):
            return None, "Capture options are invalid."
    target_mode = options.get("targetMode", "reuse_or_new_tab")
    max_resource_urls = options.get("maxResourceUrls", 300)
    if target_mode not in TARGET_MODES:
        return None, "Capture targetMode is invalid."
    if not is_strict_int(max_resource_urls) or not 0 <= max_resource_urls <= 1000:
        return None, "Capture maxResourceUrls is invalid."
    normalized = {key: options.get(key) is True for key in BOOLEAN_OPTION_KEYS}
    return {**normalized, "targetMode": target_mode, "maxResourceUrls": max_resource_urls}, None


def invalid_request(message):
    return None, "INVALID_REQUEST", None, message


def parse_capture_url(value):
    try:
        parsed = urlparse(str(value).strip())
        parsed.port
    except Exception:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        return None
    return parsed


def normalized_netloc(parsed):
    host = (parsed.hostname or "").lower()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    default_port = (parsed.scheme == "http" and parsed.port == 80) or (parsed.scheme == "https" and parsed.port == 443)
    return host if parsed.port is None or default_port else f"{host}:{parsed.port}"


def normalized_capture_url(parsed):
    return urlunparse((parsed.scheme.lower(), normalized_netloc(parsed), parsed.path or "/", "", parsed.query, ""))


def effective_port(parsed):
    if parsed.port is not None:
        return parsed.port
    return 80 if parsed.scheme == "http" else 443 if parsed.scheme == "https" else None


def is_bridge_loopback_alias(hostname, bridge_hostname):
    host = (hostname or "").strip("[]").lower()
    bridge_host = (bridge_hostname or "").strip("[]").lower()
    if host == bridge_host:
        return True
    if bridge_host != "127.0.0.1":
        return False
    if host in {"localhost", "::1", "0:0:0:0:0:0:0:1"}:
        return True
    address = parse_ip_address(host)
    return bool(address and str(address) == "127.0.0.1")


def is_bridge_origin(parsed, bridge_origin):
    bridge = urlparse(bridge_origin)
    return (
        parsed.scheme.lower() == bridge.scheme.lower()
        and effective_port(parsed) == effective_port(bridge)
        and is_bridge_loopback_alias(parsed.hostname, bridge.hostname)
    )


def validate_capture_policy(parsed, bridge_origin, options, resolver):
    if is_bridge_origin(parsed, bridge_origin):
        return "BRIDGE_SELF_TARGET_BLOCKED", None, "Bridge origin cannot be captured."
    if is_private_host(parsed.hostname or "") and options["allowPrivateNetworkTarget"] is not True:
        return "PRIVATE_NETWORK_TARGET_BLOCKED", {"reason": "private_network_address"}, "Private network targets are disabled."
    dns_code, dns_details = validate_dns_policy(parsed.hostname or "", options["allowPrivateNetworkTarget"] is True, resolver)
    if dns_code == "TARGET_DNS_LOOKUP_FAILED":
        return dns_code, dns_details, "Target hostname could not be resolved."
    if dns_code:
        return dns_code, dns_details, "Private network targets are disabled."
    return None, None, None


def normalize_capture_request(body, bridge_origin, resolver=default_resolve_hostname):
    if not isinstance(body, dict) or not set(body.keys()).issubset(REQUEST_KEYS):
        return invalid_request("Unknown capture request field.")
    if body.get("mode") != "experience":
        return invalid_request("Capture mode is invalid.")
    url_value = str(body.get("url", "")).strip()
    if not 1 <= len(url_value) <= 4096:
        return invalid_request("Capture url is invalid.")
    parsed = parse_capture_url(url_value)
    if parsed is None:
        return invalid_request("Capture url is invalid.")
    include = body.get("include")
    wait_ms = body["waitMs"] if "waitMs" in body else 3000
    viewports = body["viewports"] if "viewports" in body else []
    options_input = body["options"] if "options" in body else {}
    options, option_message = normalize_options(options_input)
    if not isinstance(include, list) or not include or any(item not in INCLUDE_ORDER for item in include):
        return invalid_request("Capture include is invalid.")
    if not is_strict_int(wait_ms) or not 0 <= wait_ms <= 30000:
        return invalid_request("Capture waitMs is invalid.")
    if not valid_viewports(viewports):
        return invalid_request("Capture viewports are invalid.")
    if options is None:
        return invalid_request(option_message)
    policy_code, policy_details, policy_message = validate_capture_policy(parsed, bridge_origin, options, resolver)
    if policy_code:
        return None, policy_code, policy_details, policy_message
    return {
        "url": normalized_capture_url(parsed),
        "mode": "experience",
        "waitMs": wait_ms,
        "include": [item for item in INCLUDE_ORDER if item in include],
        "viewports": viewports,
        "options": options,
        "protocolVersion": PROTOCOL_VERSION,
    }, None, None, None


def validate_final_url(value, bridge_origin, request):
    final_request = {
        "url": value,
        "mode": request["mode"],
        "waitMs": request.get("waitMs", 3000),
        "include": request.get("include", []),
        "viewports": request.get("viewports", []),
        "options": {**request.get("options", {}), "allowPrivateNetworkTarget": request.get("options", {}).get("allowPrivateNetworkTarget") is True},
    }
    normalized, code, details, _message = normalize_capture_request(final_request, bridge_origin)
    if normalized:
        return normalized["url"], None, None
    reason = "dns_lookup_failed" if code == "TARGET_DNS_LOOKUP_FAILED" else "invalid_final_url"
    return None, "FINAL_URL_BLOCKED", details or {"reason": reason}


def validate_target_network_address(value, request, from_cache=False, final_url=None):
    if request.get("options", {}).get("allowPrivateNetworkTarget") is True:
        return None, None
    if value is None:
        return None, None
    if not isinstance(value, str):
        return "INVALID_REQUEST", {"reason": "invalid_network_address"}
    address = value.strip().strip("[]")
    if not address:
        return None, None
    try:
        ipaddress.ip_address(address)
    except ValueError:
        return "INVALID_REQUEST", {"reason": "invalid_network_address"}
    try:
        parsed_final_url = urlparse(final_url or request.get("url", ""))
    except Exception:
        parsed_final_url = None
    final_hostname = parsed_final_url.hostname if parsed_final_url else ""
    if is_private_host(address) and not (
        is_proxy_reserved_host(address) and final_hostname and not is_ip_literal(final_hostname) and not is_private_host(final_hostname)
    ):
        return "FINAL_URL_BLOCKED", {"reason": "private_network_address"}
    return None, None
