#!/usr/bin/env python3
"""Verify responsive group and detail rows do not alter primary column geometry."""
from contextlib import contextmanager
import functools
import http.server
import subprocess
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

PACKAGE = Path(__file__).resolve().parents[2]
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


@contextmanager
def serve(directory):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def main():
    with tempfile.TemporaryDirectory(prefix="omp-table-geometry-") as temp:
        root = Path(temp)
        subprocess.run(["bun", "build", "test/visual/table-geometry.tsx", "--target", "browser", "--outdir", temp], cwd=PACKAGE, check=True)
        (root / "index.html").write_text('<link rel="stylesheet" href="table-geometry.css"><div id="root"></div><script type="module" src="table-geometry.js"></script>')
        with serve(root) as url, sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROME, headless=True)
            for width in (1440, 1024, 860, 600, 390):
                page = browser.new_page(viewport={"width": width, "height": 900})
                page.goto(url, wait_until="networkidle")
                row = page.locator("tbody tr:not(.std-group):not(.std-detail)").first
                row.wait_for()
                primary = row.locator("td:not(.std-control)").first
                before = primary.bounding_box()["width"]
                page.locator("#toggle-group").click()
                page.locator(".std-group").wait_for()
                page.wait_for_timeout(100)
                grouped = primary.bounding_box()["width"]
                row.locator("button[aria-expanded]").click()
                page.locator(".std-detail").wait_for()
                page.wait_for_timeout(100)
                expanded = primary.bounding_box()["width"]
                spans = page.evaluate("""() => {
                    const outer = document.querySelector('.table--std');
                    const own = [...outer.querySelectorAll(':scope > table > thead > tr > th')].filter(th => getComputedStyle(th).display !== 'none').length;
                    return {own, detail: Number(outer.querySelector(':scope > table > tbody > tr.std-detail > td').colSpan),
                            group: Number(outer.querySelector(':scope > table > tbody > tr.std-group > th').colSpan)};
                }""")
                print(f"{width}: spans {spans}")
                if not (spans["own"] == spans["detail"] == spans["group"]):
                    raise AssertionError(f"nested table changed the outer span at {width}px")
                print(f"{width}: primary={before:.2f}, grouped={grouped:.2f}, expanded={expanded:.2f}")
                if abs(before - grouped) > 1 or abs(before - expanded) > 1:
                    raise AssertionError(f"column geometry changed at {width}px")
                page.close()
            for theme in ("dark", "light"):
                for width in (600, 390):
                    page = browser.new_page(viewport={"width": width, "height": 900}, color_scheme=theme)
                    page.add_init_script(f'document.documentElement.dataset.theme = "{theme}"')
                    page.goto(url, wait_until="networkidle")
                    sizes = page.locator(".std-head").evaluate("""head => {
                        const card = head.closest('.table--std').getBoundingClientRect();
                        return {cardLeft: card.left, cardRight: card.right,
                          children: [...head.querySelectorAll('input, button, select')].map(el => {
                            const r = el.getBoundingClientRect(); return {left: r.left, right: r.right};
                          }), scroll: document.documentElement.scrollWidth, viewport: innerWidth};
                    }""")
                    print(f"{width} {theme}: header geometry {sizes}")
                    if sizes["scroll"] > sizes["viewport"] or any(
                        item["left"] < sizes["cardLeft"] - 1 or item["right"] > sizes["cardRight"] + 1
                        for item in sizes["children"]
                    ):
                        raise AssertionError(f"header overflows at {width}px in {theme}")
                    page.locator("#toggle-group").click()
                    group = page.locator(".std-group th")
                    action = page.locator("#group-action")
                    group.wait_for()
                    boxes = group.evaluate("""cell => {
                        const rect = el => { const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };
                        return {cell:rect(cell), label:rect(cell.querySelector('span')), action:rect(cell.querySelector('button'))};
                    }""")
                    print(f"{width} {theme}: group geometry {boxes}")
                    for name in ("label", "action"):
                        if any((boxes[name]["left"] < boxes["cell"]["left"] - 1,
                                boxes[name]["right"] > boxes["cell"]["right"] + 1,
                                boxes[name]["top"] < boxes["cell"]["top"] - 1,
                                boxes[name]["bottom"] > boxes["cell"]["bottom"] + 1)):
                            raise AssertionError(f"group {name} clipped at {width}px in {theme}")
                    action.click()
                    if "Merge group 1" not in action.inner_text():
                        raise AssertionError(f"group action not clickable at {width}px in {theme}")
                    page.close()
            browser.close()


if __name__ == "__main__":
    main()
