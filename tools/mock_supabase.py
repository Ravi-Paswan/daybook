#!/usr/bin/env python3
"""Tiny in-memory stand-in for the parts of Supabase that Daybook sync uses (for local tests only).

Auth:  POST /auth/v1/signup, POST /auth/v1/token?grant_type=password|refresh_token, GET/PUT /auth/v1/user,
       POST /auth/v1/logout, POST /auth/v1/recover
REST:  GET /rest/v1/records?select=…&rev=gt.N&order=rev.asc&limit=M   POST /rest/v1/records (upsert)
No realtime (the app falls back to polling). Users are auto-confirmed.
"""
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.users = {}  # email -> {id, email, password}
        self.tokens = {}  # access -> user id
        self.refresh = {}  # refresh -> user id
        self.rows = {}  # (uid, store, key) -> row
        self.rev = 0
        self.requests = 0

    def session(self, user):
        a, r = secrets.token_hex(16), secrets.token_hex(16)
        self.tokens[a] = user["id"]
        self.refresh[r] = user["id"]
        return {"access_token": a, "refresh_token": r, "expires_in": 3600, "expires_at": int(time.time()) + 3600,
                "token_type": "bearer", "user": {"id": user["id"], "email": user["email"]}}


STATE = State()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "apikey, authorization, content-type, prefer, x-client-info")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")

    def _send(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        if obj is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"null") if n else None

    def _uid(self):
        auth = self.headers.get("Authorization") or ""
        return STATE.tokens.get(auth[7:]) if auth.startswith("Bearer ") else None

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        with STATE.lock:
            STATE.requests += 1
            uid = self._uid()
            if u.path == "/auth/v1/user":
                user = next((x for x in STATE.users.values() if x["id"] == uid), None)
                return self._send(200, {"id": user["id"], "email": user["email"]}) if user else self._send(401, {"msg": "invalid JWT"})
            if u.path == "/rest/v1/records":
                if not uid:
                    return self._send(401, {"message": "JWT expired"})
                gt = int((q.get("rev", ["gt.0"])[0]).split(".", 1)[1])
                limit = int(q.get("limit", ["1000"])[0])
                rows = sorted((r for (ru, _, _), r in STATE.rows.items() if ru == uid and r["rev"] > gt), key=lambda r: r["rev"])
                out = [{k: r[k] for k in ("store", "key", "data", "deleted", "rev", "client_ts")} for r in rows[:limit]]
                return self._send(200, out)
        self._send(404, {"message": "not found"})

    def do_PUT(self):
        u = urlparse(self.path)
        body = self._body() or {}
        with STATE.lock:
            uid = self._uid()
            if u.path == "/auth/v1/user" and uid:
                user = next(x for x in STATE.users.values() if x["id"] == uid)
                if body.get("password"):
                    user["password"] = body["password"]
                return self._send(200, {"id": user["id"], "email": user["email"]})
        self._send(401, {"msg": "unauthorized"})

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        body = self._body()
        with STATE.lock:
            STATE.requests += 1
            if u.path == "/auth/v1/signup":
                email = body["email"].lower()
                if email in STATE.users:
                    return self._send(422, {"code": 422, "error_code": "user_already_exists", "msg": "User already registered"})
                if len(body.get("password", "")) < 6:
                    return self._send(422, {"error_code": "weak_password", "msg": "Password should be at least 6 characters."})
                user = {"id": secrets.token_hex(4) + "-0000-4000-8000-" + secrets.token_hex(6), "email": email, "password": body["password"]}
                STATE.users[email] = user
                return self._send(200, STATE.session(user))
            if u.path == "/auth/v1/token":
                gt = q.get("grant_type", [""])[0]
                if gt == "password":
                    user = STATE.users.get(body["email"].lower())
                    if not user or user["password"] != body["password"]:
                        return self._send(400, {"error": "invalid_grant", "error_description": "Invalid login credentials"})
                    return self._send(200, STATE.session(user))
                if gt == "refresh_token":
                    uid = STATE.refresh.pop(body["refresh_token"], None)
                    user = next((x for x in STATE.users.values() if x["id"] == uid), None)
                    if not user:
                        return self._send(400, {"error_code": "refresh_token_not_found", "msg": "Invalid Refresh Token"})
                    return self._send(200, STATE.session(user))
            if u.path == "/auth/v1/logout":
                return self._send(204)
            if u.path == "/auth/v1/recover":
                return self._send(200, {})
            if u.path == "/rest/v1/records":
                uid = self._uid()
                if not uid:
                    return self._send(401, {"message": "JWT expired"})
                for row in body if isinstance(body, list) else [body]:
                    if row.get("user_id") != uid:
                        return self._send(403, {"message": "new row violates row-level security policy"})
                    STATE.rev += 1
                    k = (uid, row["store"], row["key"])
                    STATE.rows[k] = {**row, "rev": STATE.rev}
                return self._send(201)
        self._send(404, {"message": "not found"})


def start(port=54329):
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


if __name__ == "__main__":
    import sys
    p = int(sys.argv[1]) if len(sys.argv) > 1 else 54329
    print(f"mock supabase on http://127.0.0.1:{p}")
    start(p)
    while True:
        time.sleep(3600)
