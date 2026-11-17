#!/usr/bin/env python3
"""备用静态服务器(node 在 Termux 无法运行时使用),功能与 server.js 相同:
HTTP 8080(PORT) + 若有 certs/ 则 HTTPS 8443(SPORT),支持视频 Range 请求。"""
import os, re, ssl, sys, threading, mimetypes
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('PORT', 8080))
SPORT = int(os.environ.get('SPORT', 8443))
mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('video/mp4', '.mp4')
mimetypes.add_type('application/octet-stream', '.task')


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def send_head(self):
        path = self.translate_path(self.path)
        rng = self.headers.get('Range')
        if os.path.isdir(path) or not rng:
            return super().send_head()
        m = re.match(r'bytes=(\d*)-(\d*)', rng)
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        s = int(m.group(1)) if m.group(1) else 0
        e = int(m.group(2)) if m.group(2) else size - 1
        e = min(e, size - 1)
        if s > e:
            self.send_error(416)
            return None
        f = open(path, 'rb')
        f.seek(s)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {s}-{e}/{size}')
        self.send_header('Content-Length', str(e - s + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        self._left = e - s + 1
        return f

    def copyfile(self, src, dst):
        left = getattr(self, '_left', None)
        try:
            if left is None:
                return super().copyfile(src, dst)
            while left > 0:
                buf = src.read(min(65536, left))
                if not buf:
                    break
                dst.write(buf)
                left -= len(buf)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass  # 浏览器拖动/中断视频时会断开连接,属正常

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()


def serve(srv):
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


http = ThreadingHTTPServer(('0.0.0.0', PORT), H)
print(f'电脑/本机: http://localhost:{PORT}')
kf, cf = os.path.join(ROOT, 'certs/key.pem'), os.path.join(ROOT, 'certs/cert.pem')
if os.path.exists(kf) and os.path.exists(cf):
    https = ThreadingHTTPServer(('0.0.0.0', SPORT), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cf, kf)
    https.socket = ctx.wrap_socket(https.socket, server_side=True)
    threading.Thread(target=serve, args=(https,), daemon=True).start()
    print(f'手机(HTTPS): https://<本机局域网IP>:{SPORT}  (首次需点"继续访问/信任")')
else:
    print('未找到 certs/,如需手机用局域网访问摄像头,请先运行 sh gen-cert.sh <局域网IP>')
serve(http)
