from urllib.parse import urlparse

from .protocol import safe_equal, valid_id


SENSITIVE_DUPLICATE_HEADERS = {"Host", "Authorization", "Content-Type", "Content-Length"}
BRIDGE_QUERY_KINDS = {
    "session": "sessionId",
    "capture": "captureId",
    "nonce": "nonce",
}


def parse_bridge_query(parsed_query):
    parts = parsed_query.split("&") if parsed_query else []
    if len(parts) != 3:
        return None
    values = {}
    for part in parts:
        if not part or part.count("=") != 1:
            return None
        name, value = part.split("=", 1)
        kind = BRIDGE_QUERY_KINDS.get(name)
        if not kind or name in values or not valid_id(kind, value):
            return None
        values[name] = value
    return values if set(values.keys()) == set(BRIDGE_QUERY_KINDS.keys()) else None


def valid_bridge_query(parsed_query):
    return parse_bridge_query(parsed_query) is not None


def bridge_query_value(parsed_query, name):
    return (parse_bridge_query(parsed_query) or {}).get(name, "")


def bad_shell_error(handler):
    for name in SENSITIVE_DUPLICATE_HEADERS:
        if len(handler.headers.get_all(name, [])) > 1:
            return 400, "INVALID_REQUEST", "Ambiguous request headers are not allowed."
    content_length = handler.headers.get("Content-Length")
    if content_length is not None and (not content_length.isdecimal()):
        return 400, "INVALID_REQUEST", "Content-Length is invalid."
    if handler.headers.get("Host") != urlparse(handler.server.store.base_url).netloc:
        return 400, "INVALID_REQUEST", "Host is not allowed."
    path = handler.path
    if not path.startswith("/") or path.startswith("//"):
        return 400, "INVALID_REQUEST", "Only origin-form request targets are allowed."
    raw_path, _, raw_query = path.partition("?")
    if any(value in path.lower() for value in ("%2e", "%2f", "%5c")) or "\\" in path:
        return 400, "INVALID_REQUEST", "Encoded path separators or dot segments are not allowed."
    if raw_path != "/" and any(segment in {"", ".", ".."} for segment in raw_path.split("/")[1:]):
        return 400, "INVALID_REQUEST", "Ambiguous path segments are not allowed."
    if raw_query and raw_path != "/bridge":
        return 400, "INVALID_REQUEST", "Query string is not allowed for this endpoint."
    content_encoding = handler.headers.get("Content-Encoding")
    if content_encoding and content_encoding.lower() != "identity":
        return 415, "UNSUPPORTED_MEDIA_TYPE", "Content-Encoding is not supported."
    transfer_encoding = handler.headers.get("Transfer-Encoding")
    if transfer_encoding and handler.headers.get("Content-Length"):
        return 400, "INVALID_REQUEST", "Content-Length and Transfer-Encoding cannot be combined."
    if transfer_encoding:
        return 400, "UNSUPPORTED_TRANSFER_ENCODING", "Transfer-Encoding is not supported."
    return None


def cross_origin_error(handler):
    base_url = handler.server.store.base_url
    origin = handler.headers.get("Origin")
    if origin and origin != base_url:
        return 403, "ORIGIN_NOT_ALLOWED", "Origin is not allowed."
    if referer := handler.headers.get("Referer"):
        parsed = urlparse(referer)
        if not parsed.scheme or not parsed.netloc or f"{parsed.scheme}://{parsed.netloc}" != base_url:
            return 403, "ORIGIN_NOT_ALLOWED", "Referer is not allowed."
    if handler.headers.get("Sec-Fetch-Site") not in {None, "same-origin", "none"}:
        return 403, "ORIGIN_NOT_ALLOWED", "Sec-Fetch-Site is not allowed."
    return None


def bearer_token(handler):
    value = handler.headers.get("Authorization", "")
    return value.removeprefix("Bearer ") if value.startswith("Bearer ") else ""


def auth_api(handler):
    token = bearer_token(handler)
    if not token:
        handler.fail(401, "UNAUTHORIZED", "Bearer token is required.")
        return False
    if not safe_equal(token, handler.server.api_token):
        handler.fail(403, "FORBIDDEN", "Token is not allowed for this endpoint.")
        return False
    return True


def auth_capture(handler, capture, scope):
    token = bearer_token(handler)
    if not token:
        handler.fail(401, "UNAUTHORIZED", "Bearer token is required.")
        return None
    if scope in {"api", "status", "download"} and safe_equal(token, handler.server.api_token):
        return "api"
    if scope in {"bridge", "status", "download"} and safe_equal(token, capture["bridgeToken"]):
        return "bridge"
    handler.fail(403, "FORBIDDEN", "Token is not allowed for this endpoint.")
    return None


def rate_limited(handler, token, bucket_name, now_window):
    key = f"{token}:{bucket_name}"
    with handler.server.rate_lock:
        bucket = handler.server.rate_buckets.get(key)
        if bucket is None or bucket["window"] != now_window:
            handler.server.rate_buckets[key] = {"window": now_window, "count": 1}
            return False
        if bucket["count"] >= handler.server.rate_limits[bucket_name]:
            return True
        bucket["count"] += 1
        return False
