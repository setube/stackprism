import re

from .protocol import PROTOCOL_VERSION, is_known_bridge_error_code, redact_url

FINAL_STATES = {"completed", "failed", "cancelled", "expired"}
PLUGIN_WRITABLE_STATUSES = {"waiting_extension", "running", "cancelled", "failed"}
STATUS_PHASES = [
    "bridge_connected",
    "request_loaded",
    "target_opening",
    "target_loaded",
    "detecting_tech",
    "profiling_experience",
    "posting_profile",
    "cleanup",
]
PHASE_ORDER = {phase: index for index, phase in enumerate(STATUS_PHASES)}
SCREENSHOT_DATA_URL_PATTERN = re.compile(r"^data:image/(jpeg|png|webp);base64,")


def screenshot_preview(profile):
    screenshot = (((profile or {}).get("visualProfile") or {}).get("screenshot") or {})
    data_url = screenshot.get("dataUrl")
    match = SCREENSHOT_DATA_URL_PATTERN.match(data_url) if isinstance(data_url, str) else None
    if not match:
        return None
    return {
        "dataUrl": data_url,
        "mimeType": f"image/{match.group(1)}",
        "byteLength": screenshot.get("byteLength"),
        "scope": screenshot.get("scope"),
    }


def public_preview(capture):
    preview = {}
    target_url = redact_url(capture.get("finalUrl") or (capture.get("request") or {}).get("url"))
    if target_url:
        preview["targetUrl"] = target_url
    screenshot = screenshot_preview(capture.get("profile")) if capture["status"] == "completed" else None
    if screenshot:
        preview["screenshot"] = screenshot
    return preview


def public_status(capture):
    status = {"id": capture["id"], "status": capture["status"]}
    if capture.get("phase"):
        status["phase"] = capture["phase"]
    if capture.get("error"):
        status["error"] = capture["error"]
    preview = public_preview(capture)
    if preview:
        status["preview"] = preview
    return status


def validate_status_update(capture, body):
    if capture["status"] in FINAL_STATES:
        return False, "STALE_STATUS_UPDATE", "Capture is already terminal."
    if (
        body.get("captureId") != capture["id"]
        or body.get("sessionId") != capture["sessionId"]
        or body.get("nonce") != capture["nonce"]
        or body.get("protocolVersion") != PROTOCOL_VERSION
    ):
        return False, "INVALID_REQUEST", "Capture status identity is invalid."
    if body.get("status") not in PLUGIN_WRITABLE_STATUSES or body.get("phase") not in PHASE_ORDER:
        return False, "INVALID_REQUEST", "Capture status or phase is invalid."
    if body["status"] == "cancelled" and capture["status"] != "cancel_requested":
        return False, "STALE_STATUS_UPDATE", "Capture cancellation was not requested."
    if capture["status"] == "cancel_requested" and body["status"] != "cancelled":
        return False, "STALE_STATUS_UPDATE", "Capture cancellation is already requested."
    if body["status"] == "failed" and not (body.get("error", {}).get("code") and body.get("error", {}).get("message")):
        return False, "INVALID_REQUEST", "Failed status requires a structured error."
    if body["status"] == "failed" and not is_known_bridge_error_code(body["error"]["code"]):
        return False, "INVALID_REQUEST", "Failed status error code is invalid."
    if body["status"] in {"cancelled", "failed"} and body["phase"] != "cleanup":
        return False, "INVALID_REQUEST", "Terminal status must use cleanup phase."
    if not isinstance(body.get("sequence"), int) or body["sequence"] <= capture["sequence"]:
        return False, "STALE_STATUS_UPDATE", "Capture status sequence is stale."
    if PHASE_ORDER[body["phase"]] < PHASE_ORDER.get(capture.get("phase"), -1):
        return False, "STALE_STATUS_UPDATE", "Capture phase cannot move backwards."
    return True, None, None
