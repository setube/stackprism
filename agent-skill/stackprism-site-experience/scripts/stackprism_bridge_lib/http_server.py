from urllib.parse import urlparse
import re

from .bridge_page import render_bridge_page
from .http_handler_base import BaseBridgeHandler
from .protocol import (
    PROTOCOL_VERSION,
    SERVICE,
    VERSION,
    error_body,
    sanitize_bridge_error,
    safe_equal,
    valid_id,
)
from .profile_response import get_profile, get_profile_download, get_screenshot_download
from .security import bridge_query_value, valid_bridge_query
from .status import FINAL_STATES, public_status, validate_status_update
from .url_policy import normalize_capture_request, validate_final_url, validate_target_network_address


PROFILE_BODY_LIMIT = 8 * 1024 * 1024
DEFAULT_REQUEST_TIMEOUT_SECONDS = 35


class BridgeHandler(BaseBridgeHandler):
    server_version = "StackPrismBridge/0.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(DEFAULT_REQUEST_TIMEOUT_SECONDS)
        self.connection_accepted = False
        with self.server.connection_lock:
            if self.server.active_connections >= self.server.max_open_connections:
                self.close_connection = True
                self.connection.close()
                return
            self.server.active_connections += 1
            self.connection_accepted = True

    def finish(self):
        try:
            if self.connection_accepted:
                super().finish()
        finally:
            if self.connection_accepted:
                with self.server.connection_lock:
                    self.server.active_connections = max(0, self.server.active_connections - 1)

    def capture_route(self, path):
        match = re.match(r"^/v1/captures/([^/]+)(?:/(request|control|status|profile|profile-download)|/(screenshot-download)/([^/]+))?$", path)
        if not match or not valid_id("captureId", match[1]):
            return None
        return self.server.store.get(match[1]), match[2] or match[3] or "", match[4] or ""

    def do_GET(self):
        if self.reject_bad_shell():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"ok": True, "service": SERVICE, "version": VERSION, "protocolVersion": PROTOCOL_VERSION, "bound": "127.0.0.1", "activeCaptures": self.server.store.active_count()})
            return
        if parsed.path == "/bridge":
            if self.reject_cross_origin_sensitive_request():
                return
            if not valid_bridge_query(parsed.query):
                self.fail(400, "INVALID_REQUEST", "Bridge query is invalid.")
                return
            capture = self.server.store.get(bridge_query_value(parsed.query, "capture"))
            if not capture or capture["sessionId"] != bridge_query_value(parsed.query, "session") or capture["nonce"] != bridge_query_value(parsed.query, "nonce"):
                self.fail(404, "NOT_FOUND", "Capture bridge page was not found.")
                return
            render_bridge_page(self, capture)
            return
        if parsed.path == "/v1/captures":
            self.method_not_allowed("POST")
            return
        routed = self.capture_route(parsed.path)
        if not routed:
            self.fail(404, "NOT_FOUND", "Endpoint was not found.")
            return
        self.handle_capture_get(*routed)

    def handle_capture_get(self, capture, endpoint, screenshot_download_id=""):
        if not capture:
            self.fail(404, "NOT_FOUND", "Capture was not found.")
            return
        if self.reject_cross_origin_sensitive_request():
            return
        if endpoint == "":
            token_type = self.auth_capture(capture, "status")
            if token_type and not (token_type == "api" and self.rate_limited(self.server.api_token, "query")):
                self.send_json(200, public_status(capture))
            elif token_type == "api":
                self.fail(429, "RATE_LIMITED", "Agent bridge rate limit exceeded.")
            return
        if endpoint == "request" and self.auth_capture(capture, "bridge"):
            with self.server.store._lock:
                capture["bridgeTokenClaimedAt"] = self.server.store.now()
                body = {
                    "captureId": capture["id"],
                    "sessionId": capture["sessionId"],
                    "nonce": capture["nonce"],
                    "protocolVersion": PROTOCOL_VERSION,
                    "request": capture["request"],
                }
            self.send_json(200, body)
            return
        if endpoint == "control" and self.auth_capture(capture, "bridge"):
            command = "cancel" if capture["status"] in {"cancel_requested", "completed", "cancelled", "failed", "expired"} else "continue"
            self.send_json(200, {"id": capture["id"], "command": command, "status": capture["status"]})
            return
        if endpoint == "profile":
            get_profile(self, capture)
            return
        if endpoint == "profile-download":
            get_profile_download(self, capture)
            return
        if endpoint == "screenshot-download":
            if not (valid_id("screenshotDownloadId", screenshot_download_id) and safe_equal(screenshot_download_id, capture.get("screenshotDownloadId"))):
                self.fail(403, "FORBIDDEN", "Screenshot download URL is not valid for this capture.", extra_headers={"Referrer-Policy": "no-referrer"})
                return
            get_screenshot_download(self, capture, require_auth=False)
            return
        self.method_not_allowed("GET, POST" if endpoint == "profile" else "GET")

    def do_OPTIONS(self):
        if self.reject_bad_shell():
            return
        self.method_not_allowed("GET, POST, DELETE")

    def do_CONNECT(self):
        self.close_connection = True
        if self.reject_bad_shell():
            return
        self.method_not_allowed("GET, POST, DELETE")

    def do_POST(self):
        if self.reject_bad_shell() or self.reject_cross_origin_sensitive_request():
            return
        if self.path in {"/health", "/bridge"}:
            self.method_not_allowed("GET")
            return
        if self.path == "/v1/captures":
            self.create_capture()
            return
        routed = self.capture_route(urlparse(self.path).path)
        if not routed:
            self.fail(404, "NOT_FOUND", "Endpoint was not found.")
            return
        capture, endpoint, _screenshot_download_id = routed
        if not capture:
            self.fail(404, "NOT_FOUND", "Capture was not found.")
        elif endpoint == "profile":
            self.post_profile(capture)
        elif endpoint == "status":
            self.post_status(capture)
        else:
            self.method_not_allowed("GET, DELETE" if endpoint == "" else "GET")

    def create_capture(self):
        if not self.auth_api():
            return
        if self.rate_limited(self.server.api_token, "create"):
            self.fail(429, "RATE_LIMITED", "Agent bridge rate limit exceeded.")
            return
        body = self.read_json()
        if body is None:
            return
        request, code, details, message = normalize_capture_request(body, self.server.store.base_url)
        if not request:
            self.fail(400, code, message or "Capture request is invalid.", details)
            return
        capture, status, err = self.server.store.create(request)
        if err:
            self.send_json(status, err)
            return
        self.send_json(200, {"id": capture["id"], "status": capture["status"], "bridgeUrl": capture["bridgeUrl"], "profileUrl": capture["profileUrl"]})

    def post_profile(self, capture):
        if not self.auth_capture(capture, "bridge"):
            return
        with self.server.store._lock:
            if capture["status"] in FINAL_STATES:
                code = "CAPTURE_ALREADY_COMPLETED" if capture["status"] == "completed" else "STALE_STATUS_UPDATE"
                response = ("fail", 409, code, "Capture is already terminal.", {"status": capture["status"]})
            elif not capture.get("finalUrl"):
                response = ("fail", 409, "INVALID_REQUEST", "Capture final URL has not been accepted.", None)
            else:
                response = None
        if response and response[0] == "fail":
            self.fail(response[1], response[2], response[3], response[4])
        elif response:
            self.send_json(200, response[1])
        else:
            body = self.read_json(PROFILE_BODY_LIMIT, "PROFILE_TOO_LARGE")
            if body is None:
                return
            with self.server.store._lock:
                if capture["status"] in FINAL_STATES:
                    code = "CAPTURE_ALREADY_COMPLETED" if capture["status"] == "completed" else "STALE_STATUS_UPDATE"
                    response = ("fail", 409, code, "Capture is already terminal.", {"status": capture["status"]})
                elif body.get("schema") != "stackprism.site_experience_profile.v1" or body.get("captureId") != capture["id"]:
                    response = ("fail", 400, "INVALID_REQUEST", "Profile schema or capture id is invalid.", None)
                else:
                    self.server.store.mark_profile(capture, body)
                    response = ("json", public_status(capture))
            if response[0] == "fail":
                self.fail(response[1], response[2], response[3], response[4])
            else:
                self.send_json(200, response[1])

    def post_status(self, capture):
        if not self.auth_capture(capture, "bridge"):
            return
        body = self.read_json()
        if body is None:
            return
        final_url_result = None
        network_result = (None, None)
        if body.get("finalUrl"):
            final_url_result = validate_final_url(body["finalUrl"], self.server.store.base_url, capture["request"])
            from_cache = body.get("targetNetworkFromCache") is True
            network_result = validate_target_network_address(body.get("targetNetworkAddress"), capture["request"], from_cache, final_url_result[0] if final_url_result else None)
        with self.server.store._lock:
            valid, code, message = validate_status_update(capture, body)
            if not valid:
                response = ("fail", 400 if code == "INVALID_REQUEST" else 409, code, message, None)
            elif body.get("status") == "running" and body.get("phase") == "target_loaded" and not body.get("finalUrl") and not capture.get("finalUrl"):
                response = ("fail", 400, "INVALID_REQUEST", "target_loaded status requires finalUrl.", None)
            elif body.get("finalUrl"):
                final_url, code, details = final_url_result
                network_code, network_details = network_result
                if code:
                    capture["status"] = "failed"
                    capture["phase"] = body["phase"]
                    capture["error"] = error_body(code, "Final URL is blocked by target policy.", details)["error"]
                    response = ("fail", 409, code, "Final URL is blocked by target policy.", details)
                elif network_code == "INVALID_REQUEST":
                    response = ("fail", 400, network_code, "Final URL is blocked by target policy.", network_details)
                elif network_code:
                    message = "Final URL is blocked by target policy."
                    capture["status"] = "failed"
                    capture["phase"] = body["phase"]
                    capture["error"] = error_body(network_code, message, network_details)["error"]
                    response = ("fail", 409, network_code, message, network_details)
                else:
                    capture["finalUrl"] = final_url
                    capture["sequence"] = body["sequence"]
                    capture["status"] = body["status"]
                    capture["phase"] = body["phase"]
                    capture["error"] = sanitize_bridge_error(body["error"]) if body.get("error") else capture["error"]
                    response = ("json", public_status(capture))
            else:
                capture["sequence"] = body["sequence"]
                capture["status"] = body["status"]
                capture["phase"] = body["phase"]
                capture["error"] = sanitize_bridge_error(body["error"]) if body.get("error") else capture["error"]
                response = ("json", public_status(capture))
        if response[0] == "fail":
            self.fail(response[1], response[2], response[3], response[4])
        else:
            self.send_json(200, response[1])

    def do_DELETE(self):
        if self.reject_bad_shell() or self.reject_cross_origin_sensitive_request():
            return
        if self.path == "/v1/captures":
            self.method_not_allowed("POST")
            return
        if self.path in {"/health", "/bridge"}:
            self.method_not_allowed("GET")
            return
        routed = self.capture_route(urlparse(self.path).path)
        if not routed:
            self.fail(404, "NOT_FOUND", "Endpoint was not found.")
            return
        capture, endpoint, _screenshot_download_id = routed
        if endpoint != "":
            self.method_not_allowed("GET")
            return
        if not capture:
            self.fail(404, "NOT_FOUND", "Capture was not found.")
            return
        if not self.auth_api():
            return
        if capture["status"] in FINAL_STATES:
            self.fail(409, "INVALID_REQUEST", "Capture is already terminal.", {"status": capture["status"]})
        elif capture["status"] == "cancel_requested":
            self.fail(409, "STALE_STATUS_UPDATE", "Capture cancellation is already requested.", {"status": capture["status"]})
        else:
            self.server.store.request_cancel(capture)
            self.send_json(200, public_status(capture))
