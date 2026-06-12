import threading
import time
import os
from http.server import ThreadingHTTPServer

from .capture_store import CaptureStore
from .http_server import BridgeHandler
from .open_browser import open_browser, parse_open_config
from .protocol import new_api_token


DEFAULT_CREATE_LIMIT_PER_MINUTE = 10
DEFAULT_QUERY_LIMIT_PER_MINUTE = 120
DEFAULT_MAX_OPEN_CONNECTIONS = 20
DEFAULT_REQUEST_TIMEOUT_SECONDS = 35


class BridgeServer(ThreadingHTTPServer):
    allow_reuse_address = False
    request_queue_size = DEFAULT_MAX_OPEN_CONNECTIONS


def create_server(port=0, now=time.time, rate_limits=None, max_open_connections=DEFAULT_MAX_OPEN_CONNECTIONS, env=None, result_ttl_seconds=None):
    active_env = os.environ if env is None else env
    open_config_ok, open_config_code, open_config_message = parse_open_config(active_env)
    if not open_config_ok:
        error = ValueError(open_config_message)
        error.code = open_config_code
        raise error
    if not isinstance(max_open_connections, int) or max_open_connections <= 0:
        max_open_connections = DEFAULT_MAX_OPEN_CONNECTIONS
    api_token = new_api_token()
    BridgeServer.request_queue_size = max_open_connections
    server = BridgeServer(("127.0.0.1", port), BridgeHandler)
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    server.max_open_connections = max_open_connections
    server.active_connections = 0
    server.connection_lock = threading.Lock()
    server.api_token = api_token
    ttl_seconds = result_ttl_seconds if result_ttl_seconds is not None else None
    store_args = [base_url, now, lambda url: open_browser(url, active_env)]
    server.store = CaptureStore(*store_args, result_ttl_seconds=ttl_seconds) if ttl_seconds is not None else CaptureStore(*store_args)
    server.rate_limits = {
        "create": (rate_limits or {}).get("createLimitPerMinute", DEFAULT_CREATE_LIMIT_PER_MINUTE),
        "query": (rate_limits or {}).get("queryLimitPerMinute", DEFAULT_QUERY_LIMIT_PER_MINUTE),
    }
    server.rate_buckets = {}
    server.rate_lock = threading.Lock()
    server.timeout = DEFAULT_REQUEST_TIMEOUT_SECONDS
    return server, {"baseUrl": base_url, "healthUrl": f"{base_url}/health", "apiToken": api_token}
