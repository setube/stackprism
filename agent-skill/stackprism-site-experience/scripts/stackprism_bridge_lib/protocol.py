import base64
import hmac
import json
import re
import secrets

SERVICE = "stackprism-agent-bridge"
VERSION = "0.1.0"
PROTOCOL_VERSION = 1

BRIDGE_ERROR_CODES = {
    "NOT_FOUND",
    "METHOD_NOT_ALLOWED",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "ORIGIN_NOT_ALLOWED",
    "UNSUPPORTED_MEDIA_TYPE",
    "UNSUPPORTED_TRANSFER_ENCODING",
    "INVALID_JSON",
    "INVALID_REQUEST",
    "REQUEST_TOO_LARGE",
    "REQUEST_TIMEOUT",
    "SERVER_BUSY",
    "STALE_STATUS_UPDATE",
    "PORT_IN_USE",
    "BRIDGE_INVALID_ENV",
    "BRIDGE_START_FAILED",
    "BRIDGE_START_TIMEOUT",
    "BRIDGE_READY_PARSE_FAILED",
    "BRIDGE_PROTOCOL_UNSUPPORTED",
    "BRIDGE_PAGE_RENDER_FAILED",
    "BRIDGE_REQUEST_TIMEOUT",
    "BRIDGE_REQUEST_MISMATCH",
    "AGENT_BRIDGE_DISABLED",
    "CAPTURE_BUSY",
    "CAPTURE_TIMEOUT",
    "EXTENSION_NOT_CONNECTED",
    "BROWSER_OPEN_FAILED",
    "BRIDGE_TOKEN_CANNOT_READ_PROFILE",
    "PRIVATE_NETWORK_TARGET_BLOCKED",
    "TARGET_DNS_LOOKUP_FAILED",
    "BRIDGE_SELF_TARGET_BLOCKED",
    "FINAL_URL_BLOCKED",
    "ACTIVE_TAB_UNAVAILABLE",
    "ACTIVE_TAB_MISMATCH",
    "INCOGNITO_NOT_SUPPORTED",
    "TARGET_LOAD_TIMEOUT",
    "TARGET_LOAD_FAILED",
    "TARGET_INJECTION_FAILED",
    "TARGET_TAB_CLOSED",
    "BRIDGE_TAB_CLOSED",
    "TARGET_NAVIGATED_AWAY",
    "SERVICE_WORKER_RESTARTED",
    "BRIDGE_TRANSPORT_DISCONNECTED",
    "PROFILE_TRANSPORT_FAILED",
    "PROFILE_CHUNK_MISSING",
    "PROFILE_HASH_MISMATCH",
    "PROFILE_TOO_LARGE",
    "RATE_LIMITED",
    "NONCE_REUSED",
    "CAPTURE_ALREADY_COMPLETED",
    "CAPTURE_RESULT_EXPIRED",
    "NOT_SUPPORTED",
}

SENSITIVE_DETAIL_KEY = re.compile(r"authorization|cookie|token|nonce|secret", re.I)
ID_PATTERN = re.compile(r"\b(?:spbt?_|cap_|s_|n_|xfer_|shot_)[A-Za-z0-9_-]{8,}\b")
URL_PATTERN = re.compile(r"https?://[^\s\"')\]}]+")
SENSITIVE_PATH_WORD_PATTERN = re.compile(r"^(?:token|secret|session|auth|authorization|signature|password|cookie|passcode)$", re.I)
SENSITIVE_PATH_SHORT_TOKEN_PATTERN = re.compile(r"(?:^|[-_.])(?:key|pass)(?:$|[-_.])", re.I)
SENSITIVE_PATH_COMPOUND_PATTERN = re.compile(
    r"^(?:(?:api|access|private|public|secret|session|auth)[-_.]?(?:key|pass|token|secret|signature|code|id)|(?:key|pass)[-_.]?(?:token|secret|signature|code|id)|(?:reset|verify|access|auth|session|csrf|xsrf)[-_.]?(?:token|code|secret|key|signature))$",
    re.I,
)
SENSITIVE_PATH_CAMEL_PATTERN = re.compile(
    r"^(?:apiKey|privateKey|publicKey|accessToken|refreshToken|sessionId|secretToken|authToken|csrfToken|xsrfToken)$",
    re.I,
)
HIGH_ENTROPY_PATH_SEGMENT_PATTERN = re.compile(r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9_-]{24,}$")
MAX_ERROR_TEXT_LENGTH = 512
MAX_ERROR_DETAIL_DEPTH = 4
MAX_ERROR_DETAIL_KEYS = 50
MAX_ERROR_DETAIL_ARRAY_ITEMS = 20

ID_PATTERNS = {
    "apiToken": re.compile(r"^spb_[A-Za-z0-9_-]{43}$"),
    "bridgeToken": re.compile(r"^spbt_[A-Za-z0-9_-]{43}$"),
    "captureId": re.compile(r"^cap_[A-Za-z0-9_-]{22}$"),
    "sessionId": re.compile(r"^s_[A-Za-z0-9_-]{22}$"),
    "nonce": re.compile(r"^n_[A-Za-z0-9_-]{22}$"),
    "screenshotDownloadId": re.compile(r"^shot_[A-Za-z0-9_-]{43}$"),
    "profileTransferId": re.compile(r"^xfer_[A-Za-z0-9_-]{22}$"),
    "cspNonce": re.compile(r"^[A-Za-z0-9_-]{22}$"),
}


def random_id(prefix, size):
    return prefix + base64.urlsafe_b64encode(secrets.token_bytes(size)).decode("ascii").rstrip("=")


def new_api_token():
    return random_id("spb_", 32)


def new_bridge_token():
    return random_id("spbt_", 32)


def new_capture_id():
    return random_id("cap_", 16)


def new_session_id():
    return random_id("s_", 16)


def new_nonce():
    return random_id("n_", 16)


def new_screenshot_download_id():
    return random_id("shot_", 32)


def new_csp_nonce():
    return base64.urlsafe_b64encode(secrets.token_bytes(16)).decode("ascii").rstrip("=")


def valid_id(kind, value):
    pattern = ID_PATTERNS.get(kind)
    return isinstance(value, str) and pattern is not None and bool(pattern.match(value))


def is_known_bridge_error_code(value):
    return isinstance(value, str) and value in BRIDGE_ERROR_CODES


def safe_equal(left, right):
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    left_bytes = left.encode("utf-8")
    right_bytes = right.encode("utf-8")
    comparison_length = max(len(left_bytes), len(right_bytes))
    padded_left = left_bytes.ljust(comparison_length, b"\0")
    padded_right = right_bytes.ljust(comparison_length, b"\0")
    return hmac.compare_digest(padded_left, padded_right) and len(left_bytes) == len(right_bytes)


def html_escape_script_json(value):
    return (
        json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def is_sensitive_path_segment(segment):
    text = str(segment or "")
    return (
        bool(SENSITIVE_PATH_WORD_PATTERN.search(text))
        or bool(SENSITIVE_PATH_SHORT_TOKEN_PATTERN.search(text))
        or bool(SENSITIVE_PATH_COMPOUND_PATTERN.search(text))
        or bool(SENSITIVE_PATH_CAMEL_PATTERN.search(text))
        or bool(re.match(r"^[0-9a-f]{16,}$", text, re.I))
        or bool(HIGH_ENTROPY_PATH_SEGMENT_PATTERN.match(text))
        or "=" in text
    )


def redact_pathname(pathname):
    return "/".join("[redacted]" if segment and is_sensitive_path_segment(segment) else segment for segment in str(pathname or "").split("/"))


def redact_url(value):
    from urllib.parse import urlparse, urlunparse

    parsed = urlparse(str(value or ""))
    host = parsed.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = f"{host}:{parsed.port}" if parsed.port else host
    query = "[redacted]" if parsed.query else ""
    return urlunparse((parsed.scheme, netloc, redact_pathname(parsed.path), parsed.params, query, ""))


def redact_error_text(value):
    text = str(value or "")
    text = URL_PATTERN.sub(lambda match: redact_url(match.group(0)) or "[redacted-url]", text)
    text = ID_PATTERN.sub("[redacted-id]", text)
    return text[:MAX_ERROR_TEXT_LENGTH]


def sanitize_error_value(key, value, depth=0):
    if SENSITIVE_DETAIL_KEY.search(str(key or "")):
        return "[redacted]"
    if isinstance(value, str):
        return redact_error_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if depth >= MAX_ERROR_DETAIL_DEPTH:
        return "[redacted-object]"
    if isinstance(value, list):
        return [sanitize_error_value("", item, depth + 1) for item in value[:MAX_ERROR_DETAIL_ARRAY_ITEMS]]
    if isinstance(value, dict):
        sanitized = {}
        for child_key, child in list(value.items())[:MAX_ERROR_DETAIL_KEYS]:
            sanitized_key = redact_error_text(child_key)[:64] or "field"
            sanitized[sanitized_key] = sanitize_error_value(child_key, child, depth + 1)
        return sanitized
    return redact_error_text(value)


def sanitize_bridge_error(error):
    source = error if isinstance(error, dict) else {}
    raw_code = source.get("code") if isinstance(source.get("code"), str) else ""
    code = raw_code if is_known_bridge_error_code(raw_code) else "INVALID_REQUEST"
    message = redact_error_text(source.get("message") or code or "Capture status failed.") or "Capture status failed."
    details = sanitize_error_value("details", source.get("details") or {})
    return {"code": code, "message": message, "details": details}


def error_body(code, message, details=None):
    return {"error": {"code": code, "message": message, "details": details or {}}}


def json_bytes(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
