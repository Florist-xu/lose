#!/usr/bin/env python3
"""跟练打卡服务器(仅用 Python 标准库,含 sqlite3)。
- 静态页面 + 视频/音频 Range 请求
- 训练记录接口,SQLite 存储在 data/workout.db(含每组随机抓拍的图片)
默认端口: HTTP 6060 (PORT);若存在 certs/ 则同时开 HTTPS 6061 (SPORT)。"""
import base64, binascii, json, mimetypes, os, re, sqlite3, ssl, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('PORT', 6060))
SPORT = int(os.environ.get('SPORT', 6061))
DB_PATH = os.environ.get('DB_PATH', os.path.join(ROOT, 'data', 'workout.db'))
MAX_BODY = 20 * 1024 * 1024
MAX_IMG = 2 * 1024 * 1024
PUBLIC = {'index.html', 'app.js', 'templates.json', 'lib', 'media', 'favicon.ico'}  # 只公开这些,certs/data 等不会被下载
mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('video/mp4', '.mp4')
mimetypes.add_type('audio/mp4', '.m4a')
mimetypes.add_type('application/octet-stream', '.task')
DAY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


# ---------------- SQLite ----------------
def db():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys = ON')
    return c


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS sessions(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          day TEXT NOT NULL,                 -- 本地日期 YYYY-MM-DD
          started_at TEXT NOT NULL,          -- ISO 时间
          duration_sec INTEGER NOT NULL,     -- 总用时(含休息)
          active_sec INTEGER NOT NULL,       -- 动作用时(不含休息)
          moves_done INTEGER NOT NULL,       -- 完成动作数(满 20 次 / 跳过)
          moves_json TEXT NOT NULL,          -- 每个动作的次数与用时
          created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
        CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
        CREATE TABLE IF NOT EXISTS images(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          grp INTEGER NOT NULL,              -- 第几组 0~4
          move_idx INTEGER,                  -- 抓拍时的动作 0~19
          data BLOB NOT NULL);               -- JPEG
        CREATE INDEX IF NOT EXISTS idx_images_session ON images(session_id);
        ''')


def clamp_int(v, lo, hi, name):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f'{name} 必须是数字')
    v = int(round(v))
    if not lo <= v <= hi:
        raise ValueError(f'{name} 超出范围')
    return v


def save_session(body):
    day = body.get('day')
    if not isinstance(day, str) or not DAY_RE.match(day):
        raise ValueError('day 格式应为 YYYY-MM-DD')
    started = str(body.get('started_at', ''))[:40]
    dur = clamp_int(body.get('duration_sec'), 0, 86400, 'duration_sec')
    act = clamp_int(body.get('active_sec'), 0, 86400, 'active_sec')
    done = clamp_int(body.get('moves_done'), 0, 20, 'moves_done')
    moves = body.get('moves', [])
    if not isinstance(moves, list) or len(moves) > 20:
        raise ValueError('moves 不合法')
    clean_moves = []
    for m in moves:
        clean_moves.append({'idx': clamp_int(m.get('idx'), 0, 19, 'idx'), 'reps': clamp_int(m.get('reps'), 0, 100, 'reps'),
                            'sec': clamp_int(m.get('sec'), 0, 86400, 'sec')})
    imgs = []
    for im in body.get('images', [])[:10]:
        g = clamp_int(im.get('group'), 0, 4, 'group')
        mi = im.get('move_idx')
        mi = clamp_int(mi, 0, 19, 'move_idx') if mi is not None else None
        data = str(im.get('data', ''))
        if not data.startswith('data:image/jpeg;base64,'):
            raise ValueError('图片必须是 JPEG')
        try:
            raw = base64.b64decode(data.split(',', 1)[1], validate=True)
        except (binascii.Error, ValueError):
            raise ValueError('图片编码错误')
        if len(raw) > MAX_IMG or raw[:2] != b'\xff\xd8':
            raise ValueError('图片无效或过大')
        imgs.append((g, mi, raw))
    with db() as c:
        cur = c.execute('INSERT INTO sessions(day,started_at,duration_sec,active_sec,moves_done,moves_json) VALUES(?,?,?,?,?,?)',
                        (day, started, dur, act, done, json.dumps(clean_moves)))
        sid = cur.lastrowid
        c.executemany('INSERT INTO images(session_id,grp,move_idx,data) VALUES(?,?,?,?)', [(sid, g, mi, raw) for g, mi, raw in imgs])
        t = c.execute('SELECT COALESCE(SUM(duration_sec),0) s, COUNT(*) n FROM sessions WHERE day=?', (day,)).fetchone()
    return {'id': sid, 'day_total_sec': t['s'], 'day_sessions': t['n']}


def list_days():
    with db() as c:
        return [dict(r) for r in c.execute(
            'SELECT day, SUM(duration_sec) total_sec, SUM(active_sec) active_sec, COUNT(*) sessions FROM sessions GROUP BY day ORDER BY day DESC LIMIT 400')]


def list_sessions(day):
    with db() as c:
        out = []
        for r in c.execute('SELECT * FROM sessions WHERE day=? ORDER BY id DESC', (day,)):
            d = dict(r)
            d['moves'] = json.loads(d.pop('moves_json'))
            d['images'] = [dict(i) for i in c.execute('SELECT id, grp, move_idx FROM images WHERE session_id=? ORDER BY grp', (r['id'],))]
            out.append(d)
        return out


# ---------------- HTTP ----------------
class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    # ---- JSON 工具 ----
    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(b)

    def _api(self, method):
        u = urlparse(self.path)
        parts = [p for p in u.path.split('/') if p]  # ['api', ...]
        try:
            if method == 'GET' and parts == ['api', 'days']:
                return self._json(list_days())
            if method == 'GET' and parts == ['api', 'sessions']:
                day = parse_qs(u.query).get('day', [''])[0]
                if not DAY_RE.match(day):
                    return self._json({'error': 'day 参数不合法'}, 400)
                return self._json(list_sessions(day))
            if method == 'GET' and len(parts) == 3 and parts[1] == 'images' and parts[2].isdigit():
                with db() as c:
                    r = c.execute('SELECT data FROM images WHERE id=?', (int(parts[2]),)).fetchone()
                if not r:
                    return self._json({'error': '不存在'}, 404)
                self.send_response(200)
                self.send_header('Content-Type', 'image/jpeg')
                self.send_header('Content-Length', str(len(r['data'])))
                self.send_header('Cache-Control', 'max-age=86400')
                self.end_headers()
                return self.wfile.write(r['data'])
            if method == 'POST' and parts == ['api', 'sessions']:
                n = int(self.headers.get('Content-Length') or 0)
                if n <= 0 or n > MAX_BODY:
                    return self._json({'error': '请求体大小不合法'}, 413)
                try:
                    body = json.loads(self.rfile.read(n))
                except ValueError:
                    return self._json({'error': 'JSON 格式错误'}, 400)
                if not isinstance(body, dict):
                    return self._json({'error': 'JSON 格式错误'}, 400)
                return self._json(save_session(body), 201)
            if method == 'DELETE' and len(parts) == 3 and parts[1] == 'sessions' and parts[2].isdigit():
                with db() as c:
                    cur = c.execute('DELETE FROM sessions WHERE id=?', (int(parts[2]),))
                return self._json({'deleted': cur.rowcount})
            return self._json({'error': '接口不存在'}, 404)
        except ValueError as e:
            return self._json({'error': str(e)}, 400)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass
        except Exception as e:  # noqa
            return self._json({'error': '服务器错误: ' + type(e).__name__}, 500)

    def do_POST(self):
        if self.path.startswith('/api/'):
            return self._api('POST')
        self.send_error(405)

    def do_DELETE(self):
        if self.path.startswith('/api/'):
            return self._api('DELETE')
        self.send_error(405)

    def do_GET(self):
        if self.path.startswith('/api/'):
            return self._api('GET')
        return super().do_GET()

    def do_HEAD(self):
        return super().do_HEAD()

    # ---- 静态文件(白名单 + Range) ----
    def _allowed(self):
        p = urlparse(self.path).path
        segs = [s for s in p.split('/') if s]
        return not segs or segs[0] in PUBLIC

    def send_head(self):
        if not self._allowed():
            self.send_error(404)
            return None
        path = self.translate_path(self.path)
        rng = self.headers.get('Range')
        self._left = None
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
            pass  # 浏览器拖动/中断媒体时会断开连接,属正常

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()


def serve(srv):
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    init_db()
    http = ThreadingHTTPServer(('0.0.0.0', PORT), H)
    print(f'电脑/本机: http://localhost:{PORT}   数据库: {DB_PATH}', flush=True)
    kf, cf = os.path.join(ROOT, 'certs/key.pem'), os.path.join(ROOT, 'certs/cert.pem')
    if os.path.exists(kf) and os.path.exists(cf):
        https = ThreadingHTTPServer(('0.0.0.0', SPORT), H)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cf, kf)
        https.socket = ctx.wrap_socket(https.socket, server_side=True)
        threading.Thread(target=serve, args=(https,), daemon=True).start()
        print(f'手机(HTTPS): https://<本机局域网IP>:{SPORT}  (首次需点"继续访问/信任")', flush=True)
    else:
        print('未找到 certs/,如需手机用局域网访问摄像头,请先运行 sh gen-cert.sh <局域网IP>', flush=True)
    serve(http)
