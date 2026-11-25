#!/usr/bin/env python3
"""Static server for Daybook.

Why not `python -m http.server`?  On Windows the registry often maps .js to text/plain, and browsers
refuse to run ES modules served with the wrong MIME type. This server forces correct types and
disables caching so you always get fresh files while developing.

Usage:
    python tools/serve.py                 # http://localhost:8080
    python tools/serve.py --port 9000
    python tools/serve.py --lan           # also reachable from your phone on the same Wi-Fi
    python tools/serve.py --open          # open the browser
"""
import argparse
import functools
import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".md": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = os.path.splitext(str(path))[1].lower()
        return MIME.get(ext) or super().guess_type(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets two servers bind the same port (undefined behaviour) — keep it off there.
    allow_reuse_address = sys.platform != "win32"


def make_server(port=8080, host="127.0.0.1", root=ROOT, verbose=False):
    handler = functools.partial(Handler, directory=root)
    srv = Server((host, port), handler)
    srv.verbose = verbose
    return srv


def serve_in_thread(port=8080, host="127.0.0.1", root=ROOT):
    """Start the server in a daemon thread and return it (call .shutdown() when done)."""
    srv = make_server(port, host, root)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description="Serve Daybook locally")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces (phone on same Wi-Fi)")
    ap.add_argument("--open", action="store_true", help="open the browser")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    try:
        srv = make_server(args.port, host, ROOT, args.verbose)
    except OSError as e:
        print(f"Could not start on port {args.port}: {e}. Try --port 8090")
        sys.exit(1)

    url = f"http://localhost:{args.port}/"
    print("Daybook is running:")
    print(f"  On this computer:  {url}")
    if args.lan:
        print(f"  On your phone:     http://{lan_ip()}:{args.port}/   (same Wi-Fi; offline install needs HTTPS)")
    print("Press Ctrl+C to stop.")
    if args.open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
