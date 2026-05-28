import threading
import time

from .open_browser import open_browser
from .protocol import error_body, new_bridge_token, new_capture_id, new_nonce, new_session_id


EXTENSION_CONNECT_TIMEOUT_SECONDS = 30
CAPTURE_TIMEOUT_SECONDS = 60
CANCEL_TIMEOUT_SECONDS = 10
RESULT_TTL_SECONDS = 10 * 60
MAX_CAPTURE_RECORDS = 100


def capture_deadline_error(capture):
    if capture.get("phase") == "target_opening":
        return error_body("TARGET_LOAD_TIMEOUT", "Target tab load timed out.")["error"]
    return error_body("CAPTURE_TIMEOUT", "Capture timed out.")["error"]


class CaptureStore:
    def __init__(self, base_url, now=time.time, open_browser_fn=open_browser, result_ttl_seconds=RESULT_TTL_SECONDS, timer_factory=threading.Timer):
        self.base_url = base_url
        self.now = now
        self.open_browser = open_browser_fn
        self.result_ttl_seconds = result_ttl_seconds
        self.timer_factory = timer_factory
        self.captures = {}
        self.result_expiry_timers = {}
        self._lock = threading.RLock()

    def active_count(self):
        with self._lock:
            for item in list(self.captures.values()):
                self.expire_if_needed(item)
            return len([item for item in self.captures.values() if item["status"] in {"queued", "waiting_extension", "running", "cancel_requested"}])

    def get(self, capture_id):
        with self._lock:
            capture = self.captures.get(capture_id)
            if capture:
                self.expire_if_needed(capture)
            return capture

    def create(self, request):
        with self._lock:
            if self.active_count():
                return None, 429, error_body("CAPTURE_BUSY", "Another capture is already active.")
            now = self.now()
            capture_id = new_capture_id()
            session_id = new_session_id()
            nonce = new_nonce()
            capture = {
                "id": capture_id,
                "sessionId": session_id,
                "nonce": nonce,
                "bridgeToken": new_bridge_token(),
                "status": "queued",
                "phase": None,
                "sequence": 0,
                "request": request,
                "profile": None,
                "error": None,
                "createdAt": now,
                "extensionDeadlineAt": now + EXTENSION_CONNECT_TIMEOUT_SECONDS,
                "deadlineAt": now + CAPTURE_TIMEOUT_SECONDS,
                "cancelDeadlineAt": None,
                "resultExpiresAt": None,
                "bridgeTokenRenderedAt": None,
                "bridgeTokenClaimedAt": None,
            }
            capture["bridgeUrl"] = f"{self.base_url}/bridge?session={session_id}&capture={capture_id}&nonce={nonce}"
            capture["profileUrl"] = f"{self.base_url}/v1/captures/{capture_id}/profile"
            self.captures[capture_id] = capture
            self.prune_terminal_records()
        opened, details = self.open_browser(capture["bridgeUrl"])
        if not opened:
            with self._lock:
                capture["status"] = "failed"
                capture["error"] = error_body("BROWSER_OPEN_FAILED", "Failed to open the bridge page.", details)["error"]
            return None, 500, error_body("BROWSER_OPEN_FAILED", "Failed to open the bridge page.", details)
        return capture, 200, None

    def request_cancel(self, capture):
        with self._lock:
            capture["status"] = "cancel_requested"
            capture["cancelDeadlineAt"] = self.now() + CANCEL_TIMEOUT_SECONDS

    def mark_profile(self, capture, profile):
        with self._lock:
            capture["profile"] = profile
            capture["status"] = "completed"
            capture["phase"] = "cleanup"
            capture["resultExpiresAt"] = self.now() + self.result_ttl_seconds
            self.schedule_result_expiry(capture)

    def clear_result_expiry_timer(self, capture_id):
        timer = self.result_expiry_timers.pop(capture_id, None)
        if timer:
            timer.cancel()

    def schedule_result_expiry(self, capture):
        self.clear_result_expiry_timer(capture["id"])
        expires_at = capture.get("resultExpiresAt")
        if not expires_at:
            return
        delay = max(0, expires_at - self.now())
        timer = self.timer_factory(delay, lambda: self.expire_result_by_id(capture["id"]))
        timer.daemon = True
        self.result_expiry_timers[capture["id"]] = timer
        timer.start()

    def expire_result_by_id(self, capture_id):
        with self._lock:
            self.result_expiry_timers.pop(capture_id, None)
            capture = self.captures.get(capture_id)
            if capture:
                self.expire_if_needed(capture)

    def expire_if_needed(self, capture):
        with self._lock:
            now = self.now()
            if capture["status"] == "completed" and capture.get("resultExpiresAt") and capture["resultExpiresAt"] <= now:
                capture["status"] = "expired"
                capture["profile"] = None
                capture["error"] = error_body("CAPTURE_RESULT_EXPIRED", "Capture result expired.")["error"]
                self.clear_result_expiry_timer(capture["id"])
            extension_deadline = capture.get("extensionDeadlineAt")
            if capture["status"] in {"queued", "waiting_extension"} and extension_deadline is not None and extension_deadline <= now:
                capture["status"] = "failed"
                capture["error"] = error_body("EXTENSION_NOT_CONNECTED", "StackPrism extension did not connect before the deadline.")["error"]
            capture_deadline = capture.get("deadlineAt")
            if capture["status"] == "running" and capture_deadline is not None and capture_deadline <= now:
                capture["status"] = "failed"
                capture["error"] = capture_deadline_error(capture)
            if capture["status"] == "cancel_requested" and capture.get("cancelDeadlineAt") and capture["cancelDeadlineAt"] <= now:
                capture["status"] = "cancelled"
                capture["error"] = error_body("CAPTURE_TIMEOUT", "Capture cancellation timed out.", {"reason": "cancel_timeout"})["error"]

    def prune_terminal_records(self):
        with self._lock:
            overflow = len(self.captures) - MAX_CAPTURE_RECORDS
            if overflow <= 0:
                return
            terminal = sorted(
                (item for item in self.captures.values() if item["status"] not in {"queued", "waiting_extension", "running", "cancel_requested"}),
                key=lambda item: item.get("createdAt", 0),
            )
            for item in terminal[:overflow]:
                self.clear_result_expiry_timer(item["id"])
                self.captures.pop(item["id"], None)

    def clear(self):
        with self._lock:
            for capture_id in list(self.result_expiry_timers.keys()):
                self.clear_result_expiry_timer(capture_id)
            self.captures.clear()
