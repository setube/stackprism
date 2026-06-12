import json
import os
import platform
import shutil
import subprocess
from urllib.parse import urlparse


DEFAULT_OPEN_TIMEOUT_SECONDS = 5
MAX_OPEN_TIMEOUT_SECONDS = 30
MAX_LAUNCH_PROBE_SECONDS = 1
DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD"


def contains_nul(value):
    return isinstance(value, str) and "\0" in value or isinstance(value, list) and any(contains_nul(item) for item in value)


def has_path_separator(value):
    return "/" in value or "\\" in value


def windows_command_candidates(command, env=os.environ):
    extensions = [item for item in env.get("PATHEXT", DEFAULT_WINDOWS_PATHEXT).split(";") if item]
    if any(command.lower().endswith(extension.lower()) for extension in extensions):
        return [command]
    return [f"{command}{extension}" for extension in extensions]


def parse_open_timeout_seconds(env):
    value = env.get("STACKPRISM_BROWSER_OPEN_TIMEOUT_MS")
    if value is None or value == "":
        return True, DEFAULT_OPEN_TIMEOUT_SECONDS, None
    if not str(value).isdecimal():
        return False, None, {"reason": "invalid_open_timeout"}
    timeout_ms = int(value)
    if timeout_ms < 100 or timeout_ms > MAX_OPEN_TIMEOUT_SECONDS * 1000:
        return False, None, {"reason": "invalid_open_timeout"}
    return True, timeout_ms / 1000, None


def parse_open_config(env=os.environ):
    if any("\0" in str(env.get(key, "")) for key in ("STACKPRISM_BROWSER_OPEN_COMMAND", "STACKPRISM_BROWSER_OPEN_ARGS_JSON")):
        return False, "BRIDGE_INVALID_ENV", "Browser open environment contains NUL."
    if env.get("STACKPRISM_BROWSER_OPEN_COMMAND") and env.get("STACKPRISM_BROWSER_OPEN_ARGS_JSON"):
        try:
            if contains_nul(json.loads(env["STACKPRISM_BROWSER_OPEN_ARGS_JSON"])):
                return False, "BRIDGE_INVALID_ENV", "Browser open environment contains NUL."
        except Exception:
            pass
    return True, None, None


def resolve_browser_open_command(env=os.environ, system=None):
    command = env.get("STACKPRISM_BROWSER_OPEN_COMMAND")
    args = []
    if command:
        if env.get("STACKPRISM_BROWSER_OPEN_ARGS_JSON"):
            try:
                args = json.loads(env["STACKPRISM_BROWSER_OPEN_ARGS_JSON"])
            except Exception:
                return False, {"reason": "invalid_open_args"}
            if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
                return False, {"reason": "invalid_open_args"}
    elif (system or platform.system()) == "Darwin":
        command = "open"
    elif (system or platform.system()) == "Windows":
        command = "rundll32.exe"
        args = ["url.dll,FileProtocolHandler"]
    else:
        command = "xdg-open"
    return True, {"command": command, "args": args}


def command_exists(command):
    if has_path_separator(command):
        if os.name == "nt":
            return any(os.path.isfile(candidate) for candidate in windows_command_candidates(command))
        return os.path.isfile(command) and os.access(command, os.X_OK)
    return shutil.which(command) is not None


def detached_popen_kwargs():
    kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True
    return kwargs


def open_browser(url, env=os.environ):
    ok, code, message = parse_open_config(env)
    if not ok:
        return False, {"reason": code, "message": message}
    if any(char in url for char in ("\0", "\n", "\r")):
        return False, {"reason": "invalid_url"}
    parsed_url = urlparse(url)
    if parsed_url.scheme.lower() not in ("http", "https"):
        return False, {"reason": "invalid_scheme", "allowed": ["http", "https"]}
    if parsed_url.username or parsed_url.password:
        return False, {"reason": "invalid_url"}
    if env.get("STACKPRISM_BRIDGE_NO_OPEN") == "1":
        return True, {"skipped": True}

    resolved_ok, resolved = resolve_browser_open_command(env)
    if not resolved_ok:
        return False, resolved
    timeout_ok, timeout_seconds, timeout_details = parse_open_timeout_seconds(env)
    if not timeout_ok:
        return False, timeout_details
    command = resolved["command"]
    args = resolved["args"]
    if not command_exists(command):
        return False, {"reason": "command_not_found"}

    try:
        process = subprocess.Popen([command, *args, url], **detached_popen_kwargs())
        try:
            code = process.wait(timeout=min(timeout_seconds, MAX_LAUNCH_PROBE_SECONDS))
        except subprocess.TimeoutExpired:
            return True, {}
        if code != 0:
            return False, {"reason": "open_failed", "exitCode": code}
    except FileNotFoundError:
        return False, {"reason": "command_not_found"}
    except PermissionError:
        return False, {"reason": "permission_denied"}
    except Exception:
        return False, {"reason": "spawn_failed"}
    return True, {}
