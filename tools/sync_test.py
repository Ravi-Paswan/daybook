#!/usr/bin/env python3
"""End-to-end sync test: two isolated browser 'devices' against tools/mock_supabase.py.

    python tools/sync_test.py
Exit code 1 on any failed check or page error.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve import serve_in_thread  # noqa: E402
from smoke import _launch, wait_ready, goto_route  # noqa: E402
import mock_supabase  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

APP_PORT, MOCK_PORT = 8311, 54329
BASE = f"http://127.0.0.1:{APP_PORT}/index.html"
fails = []


def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        fails.append(name)


def device(browser, label, errors):
    ctx = browser.new_context(service_workers="block", locale="en-IN", timezone_id="Asia/Kolkata", viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"[{label}] PAGE ERROR {e}"))
    page.on("console", lambda m: m.type == "error" and "WebSocket" not in m.text and not m.text.startswith("Failed to load resource")
            and errors.append(f"[{label}] console.error {m.text}"))
    page.goto(BASE)
    wait_ready(page)
    page.evaluate(f"() => localStorage.setItem('daybookdev.syncUrl', 'http://127.0.0.1:{MOCK_PORT}')")
    page.reload()
    wait_ready(page)
    return ctx, page


def ev(page, js, arg=None):
    return page.evaluate(f"async (arg) => {{ const d = window.daybook, db = d.db, sync = d.sync; {js} }}", arg)


def main():
    srv = serve_in_thread(APP_PORT)
    mock = mock_supabase.start(MOCK_PORT)
    errors = []
    try:
        with sync_playwright() as pw:
            browser = _launch(pw)
            ctxA, A = device(browser, "A", errors)
            ctxB, B = device(browser, "B", errors)

            print("1. Device A (existing data) creates an account")
            ev(A, """
              await d.updateSettings({ onboarded: true, name: 'Ravi', currency: 'INR' });
              await db.put('food', { id: 'f1', date: '2026-11-25', meal: 'lunch', title: 'Dal rice', calories: 500 });
              await db.put('trades', { id: 't1', date: '2026-11-25', symbol: 'NIFTY', status: 'closed', entry: 100, exit: 110, qty: 50 });
              await db.patchDay('2026-11-25', { water: 3, reflection: 'Good day' });
              const blob = new Blob([new Uint8Array([1,2,3,4,5,250,251,252])], { type: 'image/webp' });
              await db.put('files', { id: 'img1', blob, type: 'image/webp', size: blob.size, name: 'chart.webp' });
              for (let i = 0; i < 40; i++) await db.put('expenses', { id: 'e' + i, date: '2026-11-2' + (i % 5), amount: 10 + i, type: 'expense', category: 'food' });
            """)
            r = ev(A, "const r = await sync.signUp('me@test.dev', 'secret123'); await sync.syncNow(); return { r, st: sync.getStatus() };")
            check("signUp signs in (auto-confirm)", r["r"]["confirmEmail"] is False and r["st"]["signedIn"], r)
            check("first sync finished without error", r["st"]["phase"] == "idle" and not r["st"]["error"], r["st"])
            n_rows = len(mock_supabase.STATE.rows)
            check("all records uploaded", n_rows >= 45, n_rows)
            img = next((v for (u, s, k), v in mock_supabase.STATE.rows.items() if s == "files"), None)
            check("photo uploaded as base64", bool(img and img["data"].get("$blob64")), img and list(img["data"].keys()))

            print("2. Fresh device B (not onboarded, own defaults) signs in")
            ev(B, "await d.updateSettings({ currency: 'USD', name: 'Phone' }); await db.patchDay('2026-11-26', { water: 1 });")
            r = ev(B, """
              await sync.signIn('me@test.dev', 'secret123'); await sync.syncNow();
              const s = d.getSettings(); const f = await db.get('files', 'img1');
              const bytes = f && f.blob ? [...new Uint8Array(await f.blob.arrayBuffer())] : null;
              return { onboarded: s.onboarded, name: s.name, currency: s.currency, food: await db.get('food', 'f1'),
                       exp: await db.count('expenses'), day: await db.getDay('2026-11-25'), bytes, type: f && f.blob && f.blob.type,
                       own: await db.getDay('2026-11-26') };
            """)
            check("account settings win on a new device", r["onboarded"] and r["name"] == "Ravi" and r["currency"] == "INR", r)
            check("records downloaded", r["food"] and r["food"]["title"] == "Dal rice" and r["exp"] == 40, r["exp"])
            check("journal day downloaded", r["day"]["water"] == 3 and r["day"]["reflection"] == "Good day")
            check("photo bytes identical", r["bytes"] == [1, 2, 3, 4, 5, 250, 251, 252] and r["type"] == "image/webp", r["bytes"])
            check("B's own new day kept and uploaded", r["own"]["water"] == 1)
            ev(A, "await sync.syncNow();")
            check("A received B's day", ev(A, "return (await db.getDay('2026-11-26')).water;") == 1)

            print("3. Edits and deletes propagate")
            ev(B, "const f = await db.get('food', 'f1'); await db.put('food', { ...f, calories: 650 }); await db.delete('trades', 't1'); await sync.syncNow();")
            r = ev(A, "await sync.syncNow(); return { cal: (await db.get('food', 'f1')).calories, t: await db.get('trades', 't1') };")
            check("edit on B shows on A", r["cal"] == 650, r)
            check("delete on B removes on A", r["t"] is None, r)
            ev(A, "await d.updateSettings({ theme: 'dark' }); await sync.syncNow();")
            check("settings change syncs", ev(B, "await sync.syncNow(); return d.getSettings().theme;") == "dark")

            print("4. Conflict: same record edited on both, newest wins")
            ev(A, "const f = await db.get('food', 'f1'); await db.put('food', { ...f, title: 'Older edit (A)' });")
            A.wait_for_timeout(30)
            ev(B, "const f = await db.get('food', 'f1'); await db.put('food', { ...f, title: 'Newer edit (B)' });")
            ev(B, "await sync.syncNow();")
            ev(A, "await sync.syncNow();")
            ev(B, "await sync.syncNow();")
            ta = ev(A, "return (await db.get('food', 'f1')).title;")
            tb = ev(B, "return (await db.get('food', 'f1')).title;")
            check("newest edit wins on both devices", ta == tb == "Newer edit (B)", (ta, tb))

            print("5. Mass delete safety")
            ev(A, "for (let i = 0; i < 30; i++) await db.delete('expenses', 'e' + i); await sync.syncNow();")
            st = ev(A, "return sync.getStatus();")
            check("mass delete paused for confirmation", st["massDelete"] and st["massDelete"]["count"] == 30, st["massDelete"])
            alive = sum(1 for (u, s, k), v in mock_supabase.STATE.rows.items() if s == "expenses" and not v["deleted"])
            check("nothing deleted in the cloud yet", alive == 40, alive)
            ev(A, "await sync.resolveMassDelete(false);")
            check("'keep them' restores the entries", ev(A, "return await db.count('expenses');") == 40)
            ev(A, "for (let i = 0; i < 30; i++) await db.delete('expenses', 'e' + i); await sync.syncNow(); await sync.resolveMassDelete(true);")
            check("'remove everywhere' deletes on other device", ev(B, "await sync.syncNow(); return await db.count('expenses');") == 10)

            print("6. UI renders (signed in + signed out)")
            goto_route(B, "#/settings/sync", wait_ms=600)
            txt = B.inner_text("#settings-sync")
            check("sync card shows account + status", "me@test.dev" in txt and "Synced" in txt, txt[:200])
            B.screenshot(path=os.path.join(os.path.dirname(__file__), "..", "out", "sync-signed-in.png"))
            B.click("[data-testid=sync-signout]")
            B.click("text=Sign out >> nth=-1")
            B.wait_for_timeout(500)
            check("signed out", not ev(B, "return sync.getStatus().signedIn;"))
            check("data stays after sign out", ev(B, "return await db.count('expenses');") == 10)
            B.fill("[data-testid=sync-email]", "me@test.dev")
            B.fill("[data-testid=sync-pass]", "wrong-pass")
            B.click("[data-testid=sync-signin]")
            B.wait_for_timeout(600)
            check("wrong password shows friendly error", "Wrong email or password" in B.inner_text("#settings-sync"))
            B.fill("[data-testid=sync-pass]", "secret123")
            B.click("[data-testid=sync-signin]")
            B.wait_for_function("window.daybook.sync.getStatus().signedIn && window.daybook.sync.getStatus().lastSyncAt", timeout=8000)
            check("sign in via form works", True)
            B.screenshot(path=os.path.join(os.path.dirname(__file__), "..", "out", "sync-after-signin.png"))

            print("7. 'Delete everything' only wipes this device")
            before = len(mock_supabase.STATE.rows)
            alive_before = sum(1 for v in mock_supabase.STATE.rows.values() if not v["deleted"])
            ev(A, "const b = await import(new URL('js/core/backup.js', location.href).href); await b.clearAllData(); await new Promise(r => setTimeout(r, 2500));")
            alive_after = sum(1 for v in mock_supabase.STATE.rows.values() if not v["deleted"])
            check("device signed out", not ev(A, "return sync.getStatus().signedIn;"))
            check("cloud copy untouched", alive_after == alive_before, (alive_before, alive_after))
            r = ev(A, "localStorage.setItem('daybookdev.syncUrl', 'http://127.0.0.1:%d'); return true;" % MOCK_PORT)
            A.reload()
            wait_ready(A)
            ev(A, "await sync.signIn('me@test.dev', 'secret123'); await sync.syncNow();")
            check("signing back in restores everything", ev(A, "return [await db.count('expenses'), d.getSettings().name];") == [10, "Ravi"])

            ctxA.close()
            ctxB.close()
            browser.close()
    finally:
        srv.shutdown()
        mock.shutdown()
    for e in errors:
        print("  " + e)
    print(f"\n{len(fails)} failed checks, {len(errors)} page errors")
    sys.exit(1 if fails or errors else 0)


if __name__ == "__main__":
    main()
