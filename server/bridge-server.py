"""
bridge-server.py — HTTP server that receives data from kiomet-browser
hook.js and displays it.

Usage:
    pip3 install asyncio
    python3 bridge-server.py [--port 9998]

hook.js sends fetch POST to http://localhost:9998/log
"""

import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path

LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)


class HTTPBridge:
    def __init__(self, host: str = "0.0.0.0", port: int = 9998):
        self.host = host
        self.port = port
        self.log_file = LOG_DIR / f"bridge_{datetime.now():%Y%m%d_%H%M%S}.jsonl"
        self._buffer = b""

    def _log(self, msg: str):
        ts = datetime.now().isoformat()
        sys.stdout.write(f"[{ts}] {msg}\n")
        sys.stdout.flush()

    def _log_event(self, event: dict):
        try:
            with open(self.log_file, "a") as f:
                f.write(json.dumps(event) + "\n")
        except Exception:
            pass

    async def handle_client(self, reader, writer):
        """Handle one HTTP client connection."""
        try:
            raw = b""
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                raw += chunk
                # Check if we have the full request
                if b"\r\n\r\n" in raw:
                    # Check if there's a Content-Length
                    header_end = raw.find(b"\r\n\r\n") + 4
                    headers = raw[:header_end].decode("utf-8", "replace")
                    content_length = 0
                    for line in headers.split("\r\n"):
                        if line.lower().startswith("content-length:"):
                            content_length = int(line.split(":")[1].strip())
                    # Read the body
                    body = raw[header_end:]
                    while len(body) < content_length:
                        chunk = await reader.read(4096)
                        if not chunk:
                            break
                        body += chunk
                    break

            # Parse the request
            lines = raw.decode("utf-8", "replace").split("\r\n")
            if not lines:
                writer.close()
                return

            request_line = lines[0]
            parts = request_line.split(" ")
            if len(parts) < 2:
                writer.close()
                return

            method = parts[0]
            path = parts[1]

            # Handle CORS preflight
            if method == "OPTIONS":
                response = (
                    "HTTP/1.1 204 No Content\r\n"
                    "Access-Control-Allow-Origin: *\r\n"
                    "Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n"
                    "Access-Control-Allow-Headers: Content-Type\r\n"
                    "Access-Control-Max-Age: 86400\r\n"
                    "Content-Length: 0\r\n"
                    "\r\n"
                )
                writer.write(response.encode("utf-8"))
                await writer.drain()
                writer.close()
                return

            # Handle POST
            if method == "POST" and path == "/log":
                body_start = raw.find(b"\r\n\r\n") + 4
                body = raw[body_start:].decode("utf-8", "replace")

                if body:
                    data = json.loads(body)
                    event = data.get("event", "?")
                    self._log_event(data)

                    # Display interesting events
                    if event == "connected":
                        self._log(f"  HOOK BOOTED ✓ UA={data.get('data',{}).get('userAgent','')[:60]}")
                    elif event == "ws.create":
                        self._log(f"  WS CREATE: {data.get('data',{}).get('url','')}")
                    elif event in ("ws.out", "ws.in"):
                        d = data.get("data", {})
                        url = d.get("url", "")
                        body_preview = str(d.get("body", ""))[:60]
                        self._log(f"  WS [{event}] {url} {body_preview}")
                    elif event == "wasm.load":
                        self._log(f"  WASM LOADED: {data.get('data',{}).get('keys','')[:80]}")
                    elif event == "wasm.mem_info":
                        self._log(f"  WASM MEM: {data.get('data',{}).get('byteLength',0)} bytes")
                    elif event == "wasm.mem_dump":
                        d = data.get("data", {})
                        self._log(f"  WASM DUMP: offset={d.get('offset')} len={d.get('len')}")
                    elif event == "wasm.mem_grow":
                        self._log(f"  WASM GROW: {data.get('data',{}).get('byteLength',0)} bytes")
                    elif event == "console":
                        d = data.get("data", {})
                        level = d.get("level", "")
                        if level in ("error", "warn"):
                            self._log(f"  CONSOLE {level}: {d.get('msg','')[:100]}")
                    elif event == "globals":
                        self._log(f"  GLOBALS: {data.get('data',{}).get('keys',[])}")
                    elif event == "error":
                        self._log(f"  JS ERROR: {data.get('data',{}).get('msg','')[:100]}")
                    elif event == "heartbeat":
                        pass  # skip quiet
                    else:
                        self._log(f"  EVENT: {event}")

            # Send response
            response = (
                "HTTP/1.1 200 OK\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Content-Type: text/plain\r\n"
                "Content-Length: 2\r\n"
                "Connection: close\r\n"
                "\r\n"
                "OK"
            )
            writer.write(response.encode("utf-8"))
            await writer.drain()
        except Exception as e:
            self._log(f"  ERROR: {e}")
        finally:
            writer.close()

    async def run(self):
        print(f"= Kiomet Bridge Server (HTTP) =")
        print(f"  Listen: {self.host}:{self.port}")
        print(f"  Log:    {self.log_file}")
        print(f"  Press Ctrl+C to stop")
        print("=" * 30)

        server = await asyncio.start_server(self.handle_client, self.host, self.port)
        async with server:
            await server.serve_forever()


def main():
    host = "0.0.0.0"
    port = 9998
    for i, arg in enumerate(sys.argv[1:]):
        if arg == "--port" and i + 2 < len(sys.argv):
            port = int(sys.argv[i + 2])
        elif arg == "--host" and i + 2 < len(sys.argv):
            host = sys.argv[i + 2]
    asyncio.run(HTTPBridge(host, port).run())


if __name__ == "__main__":
    main()