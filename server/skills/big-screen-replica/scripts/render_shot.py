#!/usr/bin/env python3
"""Headless screenshot of a local HTML file using installed Chrome or Edge.

Usage:
  python render_shot.py index.html shot.png --width 1749 --height 982

Exits non-zero if no browser is found or the screenshot fails.
"""
import argparse, os, subprocess, sys

CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_browser():
    for p in CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("out")
    ap.add_argument("--width", type=int, default=1749)
    ap.add_argument("--height", type=int, default=982)
    a = ap.parse_args()

    browser = find_browser()
    if not browser:
        sys.exit("no Chrome/Edge found in standard locations")

    html = os.path.abspath(a.html)
    url = "file:///" + html.replace(os.sep, "/")
    cmd = [
        browser, "--headless", "--disable-gpu", "--hide-scrollbars",
        "--window-size=%d,%d" % (a.width, a.height),
        "--screenshot=" + os.path.abspath(a.out),
        "--virtual-time-budget=3000",
        url,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if not os.path.exists(a.out):
        sys.exit("screenshot failed:\n" + (r.stdout or "") + (r.stderr or ""))
    print("ok: %s (%s)" % (os.path.abspath(a.out), browser))


if __name__ == "__main__":
    main()
