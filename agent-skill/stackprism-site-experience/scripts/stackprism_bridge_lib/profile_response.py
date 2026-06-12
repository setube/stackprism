import base64
import copy
import re
from datetime import datetime, timezone


SCREENSHOT_DATA_URL_PATTERN = re.compile(r"^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$", re.I)
SCREENSHOT_BASE64_OMITTED_NOTE = (
    "Screenshot image base64 is intentionally omitted from this Profile JSON. "
    "To inspect actual visual appearance, download the image from downloadUrl while the local bridge is running and before availableUntil."
)
SCREENSHOT_PROFILE_JSON_NOTE = (
    "Profile JSON is standard JSON and cannot contain comments. "
    "This note field is the durable instruction: screenshot base64 is omitted; use downloadUrl to inspect actual visual appearance."
)


def as_dict(value):
    return value if isinstance(value, dict) else {}


def profile_visual_screenshot(profile):
    visual_profile = as_dict(as_dict(profile).get("visualProfile"))
    return as_dict(visual_profile.get("screenshot"))


def screenshot_extension_for(mime_type):
    if mime_type == "image/png":
        return "png"
    if mime_type == "image/webp":
        return "webp"
    return "jpg"


def available_until_for(capture):
    expires_at = capture.get("resultExpiresAt")
    if not expires_at:
        return ""
    timestamp = datetime.fromtimestamp(expires_at, timezone.utc)
    milliseconds = timestamp.microsecond // 1000
    return f"{timestamp.strftime('%Y-%m-%dT%H:%M:%S')}.{milliseconds:03d}Z"


def screenshot_asset_from(screenshot):
    data_url = screenshot.get("dataUrl")
    match = SCREENSHOT_DATA_URL_PATTERN.match(data_url) if isinstance(data_url, str) else None
    if not match:
        return None
    mime_type = f"image/{match.group(1).lower()}"
    try:
        data = base64.b64decode(match.group(2), validate=True)
    except Exception:
        return None
    if not data:
        return None
    metadata = {key: value for key, value in screenshot.items() if key != "dataUrl"}
    return {"data": data, "mimeType": mime_type, "extension": screenshot_extension_for(mime_type), "metadata": metadata}


def screenshot_metadata_for(capture, asset):
    metadata = dict(asset.get("metadata") or {})
    metadata.update(
        {
            "mimeType": asset["mimeType"],
            "byteLength": len(asset["data"]),
            "downloadUrl": capture.get("screenshotUrl"),
            "downloadMethod": "GET",
            "lifecycle": {
                "requiresLocalBridge": True,
                "availableUntil": available_until_for(capture),
                "note": "Download the screenshot before the local bridge process exits or the capture result expires.",
            },
            "profileJsonNote": SCREENSHOT_PROFILE_JSON_NOTE,
            "note": SCREENSHOT_BASE64_OMITTED_NOTE,
        }
    )
    return metadata


def screenshot_payload_for_capture(capture):
    asset = capture.get("screenshotAsset") or screenshot_asset_from(profile_visual_screenshot(capture.get("profile")))
    if not asset or not asset.get("data"):
        return None
    return {
        "data": asset["data"],
        "mimeType": asset["mimeType"],
        "extension": asset["extension"],
        "metadata": screenshot_metadata_for(capture, asset),
    }


def ensure_visual_reference(profile):
    if not isinstance(profile.get("agentGuidance"), dict):
        profile["agentGuidance"] = {}
    if not isinstance(profile["agentGuidance"].get("recreationPlan"), dict):
        profile["agentGuidance"]["recreationPlan"] = {}
    if not isinstance(profile["agentGuidance"]["recreationPlan"].get("visualReference"), dict):
        profile["agentGuidance"]["recreationPlan"]["visualReference"] = {}
    return profile["agentGuidance"]["recreationPlan"]["visualReference"]


def update_visual_reference(profile, capture, payload):
    visual_reference = ensure_visual_reference(profile) if payload else (((profile or {}).get("agentGuidance") or {}).get("recreationPlan") or {}).get("visualReference")
    if not isinstance(visual_reference, dict):
        return
    visual_reference["screenshotIncluded"] = bool(payload)
    visual_reference["screenshotBase64Included"] = False
    visual_reference["screenshotDownloadUrl"] = capture.get("screenshotUrl") if payload else ""
    visual_reference["screenshotDownloadHint"] = (
        SCREENSHOT_BASE64_OMITTED_NOTE
        if payload
        else "No screenshot image is available in this capture. Review limitations before treating visual evidence as absent."
    )
    visual_reference["screenshotProfileJsonNote"] = SCREENSHOT_PROFILE_JSON_NOTE
    if payload:
        visual_reference["screenshotMimeType"] = payload["mimeType"]
        visual_reference["screenshotByteLength"] = len(payload["data"])
        visual_reference["screenshotAvailableUntil"] = available_until_for(capture)
    else:
        visual_reference.pop("screenshotMimeType", None)
        visual_reference.pop("screenshotByteLength", None)
        visual_reference.pop("screenshotAvailableUntil", None)


def prepare_profile_for_storage(profile, capture):
    stored_profile = copy.deepcopy(as_dict(profile))
    visual_profile = as_dict(stored_profile.get("visualProfile"))
    screenshot = as_dict(visual_profile.get("screenshot"))
    asset = screenshot_asset_from(screenshot)
    if isinstance(screenshot, dict):
        if asset:
            visual_profile["screenshot"] = screenshot_metadata_for(capture, asset)
        else:
            screenshot.pop("dataUrl", None)
    update_visual_reference(stored_profile, capture, asset)
    return stored_profile, asset


def profile_for_agent(capture):
    profile = copy.deepcopy(as_dict(capture.get("profile")))
    payload = screenshot_payload_for_capture(capture)
    visual_profile = as_dict(profile.get("visualProfile"))
    screenshot = as_dict(visual_profile.get("screenshot"))
    if isinstance(screenshot, dict):
        if payload:
            visual_profile["screenshot"] = payload["metadata"]
        else:
            screenshot.pop("dataUrl", None)
    update_visual_reference(profile, capture, payload)
    return profile


def get_profile(handler, capture):
    token_type = handler.auth_capture(capture, "status")
    if not token_type:
        return
    profile_headers = {"Referrer-Policy": "no-referrer"}
    if token_type == "bridge":
        handler.fail(403, "BRIDGE_TOKEN_CANNOT_READ_PROFILE", "Bridge token cannot read the profile endpoint.", extra_headers=profile_headers)
    elif token_type == "api" and handler.rate_limited(handler.server.api_token, "query"):
        handler.fail(429, "RATE_LIMITED", "Agent bridge rate limit exceeded.", extra_headers=profile_headers)
    elif capture["status"] == "expired":
        handler.fail(410, "CAPTURE_RESULT_EXPIRED", "Capture result expired.", extra_headers=profile_headers)
    elif capture["status"] != "completed":
        handler.fail(409, "INVALID_REQUEST", "Capture profile is not ready.", extra_headers=profile_headers)
    else:
        handler.server.store.touch_result(capture)
        handler.send_json(200, profile_for_agent(capture), profile_headers)


def get_profile_download(handler, capture):
    if not handler.auth_capture(capture, "download"):
        return
    headers = {
        "Referrer-Policy": "no-referrer",
        "Content-Disposition": f'attachment; filename="stackprism-{capture["id"]}-profile.json"',
    }
    if capture["status"] == "expired":
        handler.fail(410, "CAPTURE_RESULT_EXPIRED", "Capture result expired.", extra_headers=headers)
    elif capture["status"] != "completed":
        handler.fail(409, "INVALID_REQUEST", "Capture profile is not ready.", {"status": capture["status"]}, extra_headers=headers)
    else:
        capture["profileDownloadReadyAt"] = capture.get("profileDownloadReadyAt") or handler.server.store.now()
        handler.server.store.touch_result(capture)
        handler.send_json(200, profile_for_agent(capture), headers)


def get_screenshot_download(handler, capture, require_auth=True):
    if require_auth and not handler.auth_capture(capture, "download"):
        return
    headers = {"Referrer-Policy": "no-referrer"}
    payload = screenshot_payload_for_capture(capture) if capture.get("status") == "completed" else None
    if payload:
        headers.update(
            {
                "Content-Type": payload["mimeType"],
                "Content-Disposition": f'attachment; filename="stackprism-{capture["id"]}-screenshot.{payload["extension"]}"',
                "Content-Length": str(len(payload["data"])),
            }
        )
    if capture["status"] == "expired":
        handler.fail(410, "CAPTURE_RESULT_EXPIRED", "Capture result expired.", extra_headers=headers)
    elif capture["status"] != "completed":
        handler.fail(409, "INVALID_REQUEST", "Capture screenshot is not ready.", {"status": capture["status"]}, extra_headers=headers)
    elif not payload:
        handler.fail(404, "NOT_FOUND", "Capture screenshot is not available.", extra_headers=headers)
    else:
        handler.server.store.touch_result(capture)
        handler.send_response(200)
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Content-Type-Options", "nosniff")
        for key, value in headers.items():
            handler.send_header(key, value)
        handler.end_headers()
        handler.wfile.write(payload["data"])
