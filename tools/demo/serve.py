#!/usr/bin/env python3
"""A local preview of the site that behaves like GitHub Pages: files from the repository's root, directories by
their index.html, and the site's 404.html (with status 404) for anything missing. The demo needs that last part: a
hard reload or a first visit of one of its routes (/demo/lumen/channels/...) reaches the server, and 404.html sends
it through the demo's loader.

    python3 tools/demo/serve.py [port]          (default 8000; then open http://127.0.0.1:<port>/demo/)
"""
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


class PagesHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript',
                      '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm',
                      '.webp': 'image/webp', '.woff2': 'font/woff2'}

    def send_error(self, code, message=None, explain=None):
        page = ROOT / '404.html'
        if code != 404 or not page.exists():
            return super().send_error(code, message, explain)
        body = page.read_bytes()
        self.send_response(404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def end_headers(self):
        # Like Pages, nothing is cached for long; the demo's service worker is fetched fresh.
        self.send_header('Cache-Control', 'max-age=0')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '404' in (args[1:2] or ['']) or (len(args) > 1 and str(args[1]).startswith(('4', '5'))):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(PagesHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as httpd:
        print(f'serving {ROOT} at http://127.0.0.1:{port}/ (the demo: http://127.0.0.1:{port}/demo/)', flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
