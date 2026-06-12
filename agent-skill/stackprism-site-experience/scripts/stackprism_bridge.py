#!/usr/bin/env python3
import errno
import json
import os
import signal
import sys
import threading

from stackprism_bridge_lib.server_factory import create_server
from stackprism_bridge_lib.open_browser import parse_open_config
from stackprism_bridge_lib.protocol import PROTOCOL_VERSION, SERVICE, VERSION


def fail_start(code, message):
    sys.stderr.write(json.dumps({"error": {"code": code, "message": message}}) + "\n")
    return 1


def parse_port(value):
    if value is None:
        return 0
    if not value.isdecimal():
        return None
    port = int(value)
    return port if 1 <= port <= 65535 else None


def main():
    open_config_ok, open_config_code, open_config_message = parse_open_config(os.environ)
    if not open_config_ok:
        return fail_start(open_config_code, open_config_message)
    port = parse_port(os.environ.get("STACKPRISM_BRIDGE_PORT"))
    if port is None:
        return fail_start("BRIDGE_INVALID_ENV", "STACKPRISM_BRIDGE_PORT must be an integer from 1 to 65535.")
    try:
        server, ready = create_server(port)
    except OSError as exc:
        if getattr(exc, "errno", None) == errno.EADDRINUSE:
            return fail_start("PORT_IN_USE", "Configured bridge port is already in use.")
        return fail_start("BRIDGE_START_FAILED", "Failed to start bridge server.")

    def shutdown(_signum=None, _frame=None):
        server.shutdown()

    def watch_stdin():
        try:
            sys.stdin.read()
        finally:
            shutdown()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    stdin_thread = threading.Thread(target=watch_stdin, daemon=True)
    thread.start()
    stdin_thread.start()
    sys.stdout.write(
        json.dumps(
            {
                "event": "stackprism-bridge-ready",
                "service": SERVICE,
                "version": VERSION,
                "protocolVersion": PROTOCOL_VERSION,
                "baseUrl": ready["baseUrl"],
                "healthUrl": ready["healthUrl"],
                "apiToken": ready["apiToken"],
            }
        )
        + "\n"
    )
    sys.stdout.flush()
    thread.join()
    server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
