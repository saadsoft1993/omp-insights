#!/usr/bin/env python3
"""Compare the Models content in the current build with the local-dashboard build."""
import argparse
from contextlib import contextmanager
import functools
import http.server
import json
import threading
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

PACKAGE = Path(__file__).resolve().parents[2]
BASELINE = Path.home() / "projects/oh-my-pi-dashboard/packages/stats/dist/client"
FIXTURE = PACKAGE / "test/visual/fixture-models.json"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


@contextmanager
def server(directory):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    handler = functools.partial(Handler, directory=str(directory))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}"
    finally:
        httpd.shutdown()
        thread.join()
        httpd.server_close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, default=BASELINE)
    parser.add_argument("--current", type=Path, default=PACKAGE / "dist/client")
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    parser.add_argument("--output", type=Path, default=Path("/tmp/omp-models-diff"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    models = json.loads(args.fixture.read_text())["machines"]["server"]
    machines = [{"id": "server", "name": "Server", "self": True, "ok": True}, {"id": "mini", "name": "Mini", "ok": True}]
    with server(args.baseline) as old, server(args.current) as new, sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])
        failed = False
        for theme in ("dark", "light"):
            for width, height in ((1440, 900), (390, 844)):
                paths = []
                for name, url in (("baseline", old), ("current", new)):
                    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1, color_scheme=theme, reduced_motion="reduce")
                    context.add_init_script(f"localStorage.setItem('omp.machine', 'server'); localStorage.setItem('omp-stats-theme', '{theme}')")
                    page = context.new_page()
                    def respond(route):
                        path = route.request.url.split("?", 1)[0]
                        if path.endswith("/hub/machines"):
                            body = machines
                        elif path.endswith("/stats/model-dashboard"):
                            body = models
                        elif path.endswith("/hub/version"):
                            body = {"hub": {"commit": "test", "dirty": False, "startedAt": 0}, "ui": None}
                        else:
                            body = {}
                        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
                    page.route("**/api/**", respond)
                    page.goto(f"{url}/#/models?range=24h&m=server", wait_until="networkidle")
                    page.locator('.page .table').wait_for(timeout=15000)
                    mask = page.add_style_tag(content="*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } .topbar, .sidebar { visibility: hidden !important; }")
                    content = page.locator('.page')
                    path = args.output / f"{name}-{width}-{theme}.png"
                    content.screenshot(path=str(path), animations="disabled")
                    paths.append(path)
                    if name == "current":
                        mask.evaluate("(el) => el.remove()")
                        trigger = page.get_by_role("button", name="Machine", exact=True)
                        trigger.focus()
                        page.keyboard.press("Enter")
                        page.get_by_role("option", name="Server", exact=False).wait_for()
                        page.keyboard.press("ArrowDown")
                        page.keyboard.press("Enter")
                        if "Mini" not in trigger.inner_text():
                            raise AssertionError("ArrowDown and Enter did not select Mini")
                        page.keyboard.press("Enter")
                        page.keyboard.press("Escape")
                        if trigger.get_attribute("aria-expanded") != "false" or not trigger.evaluate("el => el === document.activeElement"):
                            raise AssertionError("Escape did not close and restore focus")
                    context.close()
                with Image.open(paths[0]) as a, Image.open(paths[1]) as b:
                    if a.size != b.size:
                        print(f"{width} {theme}: FAIL dimensions {a.size} != {b.size}")
                        failed = True
                    else:
                        diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
                        count = sum(1 for pixel in diff.getdata() if pixel != (0, 0, 0))
                        print(f"{width} {theme}: {count} changed pixels of {a.width * a.height}")
                        if count:
                            diff.save(args.output / f"diff-{width}-{theme}.png")
                            failed = True
        browser.close()
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
