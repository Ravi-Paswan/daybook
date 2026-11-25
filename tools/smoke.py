#!/usr/bin/env python3
"""Headless-Chrome smoke tester for Daybook (Playwright, uses the installed Chrome — no browser download).

CLI examples
    python tools/smoke.py --port 8301 --sample --routes "#/food" --shots out/food
    python tools/smoke.py --port 8301 --sample --routes all --mobile --theme dark --shots out/dark-mobile
    python tools/smoke.py --port 8301 --page tools/styleguide.html --shots out/sg --full
    python tools/smoke.py --port 8301 --onboarded --eval "await window.daybook.db.put('food', {date:'2026-11-24', meal:'lunch', title:'Dal rice'})" --routes "#/food"

Python API (for custom interaction tests)
    import sys; sys.path.insert(0, r'C:\\Users\\ravi paswan\\daybook\\tools')
    from smoke import app_session, goto_route
    with app_session(port=8301, mobile=True, theme='light', sample=True) as s:
        page = s.page
        goto_route(page, '#/expenses')
        page.click('text=Expense')
        ...
        print(s.report())          # console errors, page errors, failed requests collected so far

Exit code is 1 when any console error, page error or failed (>=400) request was seen.
"""
import argparse
import contextlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve import ROOT, serve_in_thread  # noqa: E402

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    print("Playwright is not installed for this Python. Use the venv python that has it.")
    sys.exit(2)

ALL_ROUTES = [
    "#/today",
    "#/food",
    "#/learning",
    "#/training",
    "#/expenses",
    "#/trades",
    "#/trades/analytics",
    "#/trades/calendar",
    "#/trades/plan",
    "#/goals",
    "#/calendar",
    "#/insights",
    "#/search?q=a",
    "#/settings",
    "#/welcome",
]

MOBILE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
DESKTOP = dict(viewport={"width": 1366, "height": 900}, device_scale_factor=1)


def _launch(pw):
    last = None
    for channel in ("chrome", "msedge", None):
        try:
            return pw.chromium.launch(channel=channel, headless=True) if channel else pw.chromium.launch(headless=True)
        except Exception as e:  # try the next browser
            last = e
    raise RuntimeError(f"Could not launch Chrome/Edge/Chromium: {last}")


class Session:
    def __init__(self, page, base):
        self.page = page
        self.base = base
        self.console = []  # (type, text)
        self.page_errors = []
        self.failed = []  # (status, url)

    def errors(self):
        return [t for (k, t) in self.console if k == "error"] + self.page_errors + [f"HTTP {s} {u}" for (s, u) in self.failed]

    def report(self):
        lines = []
        for k, t in self.console:
            if k in ("error", "warning"):
                lines.append(f"  console.{k}: {t}")
        for e in self.page_errors:
            lines.append(f"  PAGE ERROR: {e}")
        for s, u in self.failed:
            lines.append(f"  HTTP {s}: {u}")
        return "\n".join(lines) if lines else "  (no errors)"

    def reset_log(self):
        self.console.clear()
        self.page_errors.clear()
        self.failed.clear()


def wait_ready(page, timeout=15000):
    page.wait_for_function("window.__daybookReady === true", timeout=timeout)


def goto_route(page, route, wait_ms=500, timeout=10000):
    """Navigate via hash and wait for the app to finish rendering it (html[data-route] is set by app.js)."""
    route = route if route.startswith("#") else "#" + route
    path = route[1:].split("?")[0]
    page.evaluate("r => { if (location.hash === r) { window.dispatchEvent(new HashChangeEvent('hashchange')); } else { location.hash = r; } }", route)
    try:
        page.wait_for_function(
            "p => document.documentElement.dataset.route === p || (document.documentElement.dataset.route || '').startsWith(p)",
            arg=path,
            timeout=timeout,
        )
    except Exception:
        pass  # report via screenshot / errors instead of crashing
    if wait_ms:
        page.wait_for_timeout(wait_ms)


@contextlib.contextmanager
def app_session(port=8300, mobile=False, theme="light", sample=False, onboarded=False, eval_js=None,
                page_path="index.html", allow_sw=False, width=None, height=None, wait_ready_flag=True):
    srv = serve_in_thread(port)
    base = f"http://127.0.0.1:{port}/"
    try:
        with sync_playwright() as pw:
            browser = _launch(pw)
            opts = dict(MOBILE if mobile else DESKTOP)
            if width and height:
                opts["viewport"] = {"width": width, "height": height}
            ctx = browser.new_context(color_scheme=theme, service_workers="allow" if allow_sw else "block",
                                      locale="en-IN", timezone_id="Asia/Kolkata", **opts)
            page = ctx.new_page()
            s = Session(page, base)
            def on_console(m):
                # Chrome logs a console error for every failed request; those are reported via `failed` instead.
                if m.type == "error" and m.text.startswith("Failed to load resource"):
                    return
                s.console.append((m.type, m.text))

            def on_response(r):
                if r.status >= 400 and not r.url.endswith("/favicon.ico"):
                    s.failed.append((r.status, r.url))

            page.on("console", on_console)
            page.on("pageerror", lambda e: s.page_errors.append(str(e)))
            page.on("response", on_response)
            page.goto(base + page_path)
            if page_path.endswith("index.html") and wait_ready_flag:
                wait_ready(page)
                if sample:
                    page.evaluate("""async () => {
                        if (!window.daybook.getSettings().onboarded) await window.daybook.updateSettings({ currency: 'INR' });
                        const m = await import(new URL('js/modules/sample-data.js', location.href).href);
                        await m.loadSampleData();
                        await window.daybook.updateSettings({ onboarded: true, name: window.daybook.getSettings().name || 'Alex' });
                    }""")
                elif onboarded:
                    page.evaluate("async () => { await window.daybook.updateSettings({ onboarded: true, name: 'Alex' }); }")
                if eval_js:
                    page.evaluate(f"async () => {{ {eval_js} }}")
            yield s
            ctx.close()
            browser.close()
    finally:
        srv.shutdown()
        srv.server_close()


def main():
    ap = argparse.ArgumentParser(description="Daybook smoke test")
    ap.add_argument("--port", type=int, default=8300)
    ap.add_argument("--routes", default="#/today", help='comma-separated hash routes, or "all"')
    ap.add_argument("--page", default="index.html", help="page to open (e.g. tools/styleguide.html)")
    ap.add_argument("--mobile", action="store_true", help="390x844 touch viewport")
    ap.add_argument("--width", type=int)
    ap.add_argument("--height", type=int)
    ap.add_argument("--theme", default="light", choices=["light", "dark"])
    ap.add_argument("--sample", action="store_true", help="load sample data and mark onboarded")
    ap.add_argument("--onboarded", action="store_true", help="mark onboarded (no data)")
    ap.add_argument("--eval", dest="eval_js", help="async JS body to run after boot (window.daybook available)")
    ap.add_argument("--shots", help="directory for screenshots")
    ap.add_argument("--full", action="store_true", help="full-page screenshots")
    ap.add_argument("--wait", type=int, default=600, help="ms to wait after each route renders")
    ap.add_argument("--sw", action="store_true", help="allow the service worker")
    args = ap.parse_args()

    routes = ALL_ROUTES if args.routes == "all" else [r.strip() for r in args.routes.split(",") if r.strip()]
    if args.shots:
        os.makedirs(args.shots, exist_ok=True)

    total_errors = 0
    with app_session(port=args.port, mobile=args.mobile, theme=args.theme, sample=args.sample, onboarded=args.onboarded,
                     eval_js=args.eval_js, page_path=args.page, allow_sw=args.sw, width=args.width, height=args.height) as s:
        print(f"Boot ({args.page}):")
        print(s.report())
        total_errors += len(s.errors())
        s.reset_log()
        targets = routes if args.page.endswith("index.html") else [None]
        for r in targets:
            if r:
                goto_route(s.page, r, wait_ms=args.wait)
            else:
                s.page.wait_for_timeout(args.wait)
            name = (r or args.page).replace("#/", "").replace("/", "_").replace("?", "_").replace("=", "-").replace(".", "_") or "root"
            shot = ""
            if args.shots:
                shot = os.path.join(args.shots, f"{name}.png")
                s.page.screenshot(path=shot, full_page=args.full)
            heading = s.page.evaluate("() => (document.querySelector('#view h1, h1') || {}).textContent || ''")
            print(f"\n{r or args.page}  h1={json.dumps(heading.strip()[:60])}  {shot}")
            print(s.report())
            total_errors += len(s.errors())
            s.reset_log()
    print(f"\nTOTAL ERRORS: {total_errors}")
    sys.exit(1 if total_errors else 0)


if __name__ == "__main__":
    main()
