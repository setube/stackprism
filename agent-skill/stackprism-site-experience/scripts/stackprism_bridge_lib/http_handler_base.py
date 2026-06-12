from http.server import BaseHTTPRequestHandler
import time

from .body import read_json_body
from .protocol import error_body, json_bytes
from .security import auth_api, auth_capture, bad_shell_error, cross_origin_error, rate_limited


JSON_BODY_LIMIT = 5 * 1024 * 1024


class BaseBridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, _format, *args):
        return

    def send_json(self, status, body, extra_headers=None):
        payload = json_bytes(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def fail(self, status, code, message, details=None, extra_headers=None):
        self.send_json(status, error_body(code, message, details), extra_headers)

    def method_not_allowed(self, allow):
        self.send_json(405, error_body("METHOD_NOT_ALLOWED", "Method is not supported."), {"Allow": allow})

    def reject_bad_shell(self):
        if error := bad_shell_error(self):
            self.fail(*error)
            return True
        return False

    def reject_cross_origin_sensitive_request(self):
        if error := cross_origin_error(self):
            self.fail(*error)
            return True
        return False

    def auth_api(self):
        return auth_api(self)

    def auth_capture(self, capture, scope):
        return auth_capture(self, capture, scope)

    def rate_limited(self, token, bucket_name):
        return rate_limited(self, token, bucket_name, int(time.time() // 60))

    def read_json(self, limit=JSON_BODY_LIMIT, too_large_code="REQUEST_TOO_LARGE"):
        return read_json_body(self, limit, too_large_code)
