import json
import re


def read_exact(stream, length):
    chunks = []
    remaining = length
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("Request body ended before Content-Length bytes were read.")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_json_body(handler, limit, too_large_code):
    if not re.fullmatch(r"application/json(?:;\s*charset=utf-8)?", handler.headers.get("Content-Type", ""), re.IGNORECASE):
        close_request_connection(handler)
        handler.fail(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json.")
        return None
    try:
        length = int(handler.headers.get("Content-Length", "0"))
        if length > limit:
            close_request_connection(handler)
            handler.fail(413, too_large_code, "Request body is too large.")
            return None
        return json.loads(read_exact(handler.rfile, length).decode("utf-8"))
    except (EOFError, UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError):
        close_request_connection(handler)
        handler.fail(400, "INVALID_JSON", "Request body is not valid JSON.")
        return None


def close_request_connection(handler):
    handler.close_connection = True
