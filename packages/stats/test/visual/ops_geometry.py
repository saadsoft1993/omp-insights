#!/usr/bin/env python3
"""Group-heading hints on the ops pages and Accounts: Try again stays in view and clickable on a phone.

Serves the built client (`bun run build` first) with a fixture hub: the MacBook's account list fails, the Mac mini
is unreachable. At 390 px, every group-heading Try again must sit inside the viewport, be the element hit at its
centre, and the page must not scroll sideways. At 1440 px the hint stays on the heading's line.
Pass `--shots DIR` to also save the 1440 px pages (for a before/after pixel comparison).
"""
import argparse
from contextlib import contextmanager
import functools
import http.server
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

PACKAGE = Path(__file__).resolve().parents[2]
DIST = PACKAGE / "dist/client"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Fixed clock so the 1440 px screenshots are comparable between runs.
NOW = int(time.mktime((2026, 11, 19, 10, 0, 0, 0, 0, -1)) * 1000)
H = 3_600_000

MACHINES = [
    {"id": "server", "name": "Ada Server", "self": True, "ok": True, "lastOkAt": NOW},
    {"id": "macbook", "name": "Ada MacBook", "ok": True, "lastOkAt": NOW},
    {"id": "mini", "name": "Ada Mac mini", "ok": False, "lastOkAt": NOW - 3 * H},
]


def job(label, **over):
    row = {"label": label, "file": f"{label}.plist", "readable": True, "note": None, "schedule": "daily 07:30",
           "status": "ok", "exit": "last exit ok", "pid": None, "lastLogWrite": NOW - 2 * H, "kind": "scheduled",
           "loaded": True, "impact": None, "nextRun": NOW + 5 * H}
    row.update(over)
    return row


def device(i, **over):
    row = {"id": i, "scope": "tailnet", "label": "Mozilla/5.0 (Macintosh) Chrome/140", "pairedAt": NOW - 3 * H,
           "expiresAt": NOW + 7 * 24 * H, "auto": False, "current": False, "lastSeen": NOW - H}
    row.update(over)
    return row


def connection(cid, email, label=None):
    return {"credentialId": cid, "identity": email, "email": email, "label": label, "accountId": None, "orgId": None,
            "type": "oauth", "expiresAt": None, "ok": True, "managed": False, "priority": 20, "policyMatched": True}


def stat(email, cid):
    return {"key": f"anthropic/email:{email}", "provider": "anthropic", "label": email, "email": email, "orgId": None,
            "credentialType": "oauth", "credentialIds": [cid], "status": "active", "disabledCause": None, "blocks": [],
            "requests": 120, "failedRequests": 0, "totalTokens": 1000, "totalCost": 1.2, "unpricedRequests": 0,
            "lastUsed": NOW - H, "requestShare": 0.5, "tokenShare": 0.5, "quotas": [], "recentRequests": 0,
            "recentShare": 0, "servingNow": False, "servedLatestNewSession": False}


ERROR = "connections request timed out after 10 seconds while the hub was busy"


def answer(path):
    """(status, body) for a hub or stats path; None for an unknown one."""
    machine, rest = "server", path
    if path.startswith("/m/"):
        _, _, machine, rest = path.split("/", 3)
        rest = "/" + rest
    if rest == "/api/hub/machines":
        return 200, {"machines": MACHINES, "now": NOW}
    if machine == "mini":
        return 502, {"error": "machine unreachable", "machine": "mini"}
    if rest == "/api/hub/version":
        # The MacBook's hub predates job actions, so its Jobs group carries the long "update the hub" hint.
        return 200, {"hub": {"commit": "abc", "dirty": False, "startedAt": NOW - H}, "ui": None,
                     "capabilities": {"jobsActions": machine != "macbook", "relayViewers": True, "devicesLastSeen": True}}
    if rest == "/api/hub/jobs":
        return 200, {"now": NOW, "jobs": [job(f"com.acme.{machine}-sync")], "gaps": []}
    if rest == "/api/hub/devices":
        return 200, {"devices": [device(f"{machine[:4]}0001", current=machine == "server")], "autoPair": False,
                     "scope": "tailnet", "canLink": True}
    if rest == "/api/hub/connections":
        if machine == "macbook":
            return 504, {"error": ERROR}
        return 200, {"machine": machine, "providers": [{"provider": "anthropic", "label": "Claude", "style": "paste",
                                                        "accounts": [connection(1, "accounts@example.com", "Work account")]}],
                     "login": None}
    if rest.startswith("/api/stats/accounts/flow"):
        return 200, {"series": [], "points": []}
    if rest.startswith("/api/stats/accounts"):
        return 200, {"accounts": [stat("accounts@example.com", 1)], "unattributed": [], "providerTotals": [], "routing": []}
    if rest.startswith("/api/stats/provider-windows"):
        return 200, {"usageSeries": [], "windowInsights": []}
    return None


@contextmanager
def serve(directory):
    handler = functools.partial(
        type("Quiet", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *_: None}), directory=str(directory)
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def route(r):
    url = r.request.url
    path = "/" + url.split("/", 3)[3].split("?")[0]
    if not path.startswith(("/api", "/m/")):
        return r.continue_()
    if path.endswith("/api/events"):
        return r.fulfill(status=200, headers={"content-type": "text/event-stream"}, body="")
    found = answer(path)
    if found is None:
        return r.fulfill(status=404, json={"error": "fixture"})
    r.fulfill(status=found[0], json=found[1])


CHECK = """() => {
    const out = {overflow: document.documentElement.scrollWidth - window.innerWidth, buttons: [], hints: []};
    for (const button of document.querySelectorAll('.std-group th button, .std-summary button, .ops-problem button')) {
        if (!/Try again/.test(button.textContent)) continue;
        // Scroll the page only (never the button's own clipping box), so a clipped button stays clipped.
        window.scrollTo(0, button.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2);
        const box = button.getBoundingClientRect();
        const after = box;
        const hit = document.elementFromPoint(after.left + after.width / 2, after.top + after.height / 2);
        out.buttons.push({left: box.left, right: box.right, width: box.width, height: box.height,
                          hit: !!hit && (hit === button || button.contains(hit)), vw: window.innerWidth});
    }
    out.notes = [...document.querySelectorAll('.std-group-empty td')].map(td => ({
        width: td.getBoundingClientRect().width, row: td.parentElement.getBoundingClientRect().width}));
    out.hintsInside = [...document.querySelectorAll('.ops-group-hint')].every(hint => {
        const box = hint.getBoundingClientRect();
        return box.left >= 0 && box.right <= window.innerWidth + 0.5;
    });
    for (const hint of document.querySelectorAll('.ops-group-hint')) {
        const name = hint.closest('.ops-group').querySelector('.std-machine');
        out.hints.push({sameLine: Math.abs(hint.getBoundingClientRect().top - name.getBoundingClientRect().top) < 6});
    }
    return out;
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shots", type=Path)
    args = parser.parse_args()
    failures = []
    with serve(DIST) as base, sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME, headless=True)
        for width in (390, 1440):
            for page_name, needs_button in (("accounts", True), ("jobs", True), ("devices", True)):
                context = browser.new_context(viewport={"width": width, "height": 900}, color_scheme="dark")
                page = context.new_page()
                page.route("**/*", route)
                page.add_init_script("localStorage.setItem('omp-stats-theme', 'dark'); localStorage.setItem('omp.machine', '*');")
                page.goto(f"{base}#/{page_name}?range=24h&m=*")
                page.locator(".std-group").first.wait_for()
                page.wait_for_timeout(600)
                if args.shots and width == 1440:
                    args.shots.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(args.shots / f"{page_name}-1440.png"), full_page=True)
                result = page.evaluate(CHECK)
                label = f"{page_name} @ {width}"
                print(f"{label}: overflow {result['overflow']} px, Try again {result['buttons']}, hints {result['hints']}, notes {result['notes']}")
                if result["overflow"] > 0:
                    failures.append(f"{label}: page scrolls sideways by {result['overflow']} px")
                if needs_button and not result["buttons"]:
                    failures.append(f"{label}: no Try again in a group heading")
                for button in result["buttons"]:
                    if button["left"] < 0 or button["right"] > button["vw"] or button["width"] < 20:
                        failures.append(f"{label}: Try again outside the viewport or squashed: {button}")
                    if not button["hit"]:
                        failures.append(f"{label}: Try again is covered or clipped at its centre")
                if not result["hintsInside"]:
                    failures.append(f"{label}: a group hint runs past the viewport")
                for note in result["notes"]:
                    # The row's own side padding (16 px each side on phones) is the only allowed difference.
                    if note["width"] < note["row"] - 33:
                        failures.append(f"{label}: a group's note is squeezed into part of its row: {note}")
                if width == 390 and not all(not hint["sameLine"] for hint in result["hints"]):
                    failures.append(f"{label}: a group hint did not move under the machine name")
                if width == 1440 and not all(hint["sameLine"] for hint in result["hints"]):
                    failures.append(f"{label}: a group hint left the heading's line")
                context.close()
        browser.close()
    if failures:
        print("\n".join(failures))
        sys.exit(1)
    print("ok")


main()
