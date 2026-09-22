# tiny static server with CORS + Range support, for testing disc-image mode locally:  python3 rangeserver.py /path/to/dir 8765
import http.server, os, re, sys, urllib.parse
ROOT, PORT = sys.argv[1], int(sys.argv[2])
MIME = {'.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json', '.iso': 'application/octet-stream'}
ctype = lambda p: MIME.get(os.path.splitext(p)[1].lower(), 'application/octet-stream')
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_HEAD(self):
        rel = urllib.parse.unquote(self.path.split('?')[0]).lstrip('/')
        p = os.path.normpath(os.path.join(ROOT, *[x for x in rel.split('/') if x not in ('..','')]))
        if not os.path.isfile(p): self.send_error(404); return
        self.send_response(200); self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Accept-Ranges', 'bytes'); self.send_header('Content-Type', ctype(p)); self.send_header('Content-Length', str(os.path.getsize(p))); self.end_headers()
    def do_OPTIONS(self):
        print('OPTIONS', self.path, dict(self.headers).get('Access-Control-Request-Headers'), flush=True)
        self.send_response(204); self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Access-Control-Allow-Headers', 'Range'); self.send_header('Access-Control-Allow-Private-Network', 'true'); self.end_headers()
    def do_GET(self):
        rel = urllib.parse.unquote(self.path.split('?')[0]).lstrip('/')
        p = os.path.normpath(os.path.join(ROOT, *[x for x in rel.split('/') if x not in ('..','')]))
        if not os.path.isfile(p): self.send_error(404); return
        size = os.path.getsize(p); m = re.match(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
        a, b = (int(m.group(1)), int(m.group(2)) if m.group(2) else size - 1) if m else (0, size - 1); b = min(b, size - 1)
        self.send_response(206 if m else 200); self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Accept-Ranges', 'bytes'); self.send_header('Content-Type', ctype(p))
        if m: self.send_header('Content-Range', f'bytes {a}-{b}/{size}')
        self.send_header('Content-Length', str(b - a + 1)); self.end_headers()
        with open(p, 'rb') as f: f.seek(a); self.wfile.write(f.read(b - a + 1))
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
