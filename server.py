#!/usr/bin/env python3
"""跟练打卡服务器(仅用 Python 标准库,含 sqlite3)。
- 静态页面 + 视频/音频 Range 请求
- 训练记录接口,SQLite 存储在 data/workout.db(含每组随机抓拍的图片)
默认端口: HTTP 6060 (PORT);若存在 certs/ 则同时开 HTTPS 6061 (SPORT)。"""
import base64, binascii, ipaddress, json, mimetypes, os, re, socket, sqlite3, ssl, threading, urllib.error, urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urljoin, unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('PORT', 6060))
SPORT = int(os.environ.get('SPORT', 6061))
PARSER_URL = os.environ.get('PARSER_URL', '').strip().rstrip('/')  # 可选:media-parser 服务地址,用于解析抖音等分享链接
DB_PATH = os.environ.get('DB_PATH', os.path.join(ROOT, 'data', 'workout.db'))
MAX_BODY = 20 * 1024 * 1024
MAX_IMG = 2 * 1024 * 1024
MUSIC_DIR = os.path.join(os.path.dirname(DB_PATH), 'music')   # 用户上传的休息音乐
MAX_MUSIC = 60 * 1024 * 1024
MUSIC_EXT = {'mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'mp4'}  # mp4 = 从抖音等保存的视频,只取声音
CT_EXT = {'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav',
          'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'video/mp4': 'mp4'}
PUBLIC = {'index.html', 'app.js', 'workouts', 'lib', 'favicon.ico', 'music-files'}  # 只公开这些,certs/data 等不会被下载
mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('video/mp4', '.mp4')
mimetypes.add_type('audio/mp4', '.m4a')
mimetypes.add_type('audio/aac', '.aac')
mimetypes.add_type('audio/flac', '.flac')
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
    os.makedirs(MUSIC_DIR, exist_ok=True)
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
        CREATE TABLE IF NOT EXISTS music(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL, source TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
        ''')
        cols = {r['name'] for r in c.execute('PRAGMA table_info(sessions)')}
        if 'workout' not in cols:   # 多运动项目:旧记录都属于第一个项目 fatburn
            c.execute("ALTER TABLE sessions ADD COLUMN workout TEXT NOT NULL DEFAULT 'fatburn'")
            c.execute("ALTER TABLE sessions ADD COLUMN workout_name TEXT NOT NULL DEFAULT '燃脂跟练'")
        if 'username' not in cols:  # 用户:只凭用户名区分(无密码);之前的全部记录归 florist
            c.execute("ALTER TABLE sessions ADD COLUMN username TEXT NOT NULL DEFAULT 'florist'")
        c.execute('CREATE INDEX IF NOT EXISTS idx_sessions_user_day ON sessions(username, day)')


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
    done = clamp_int(body.get('moves_done'), 0, 200, 'moves_done')
    user = clean_user(body.get('user'))
    wid = str(body.get('workout', 'fatburn'))
    if not WID_RE.match(wid):
        raise ValueError('workout 不合法')
    wname = str(body.get('workout_name', wid))[:40]
    moves = body.get('moves', [])
    if not isinstance(moves, list) or len(moves) > 200:
        raise ValueError('moves 不合法')
    clean_moves = []
    for m in moves:
        clean_moves.append({'idx': clamp_int(m.get('idx'), 0, 199, 'idx'), 'reps': clamp_int(m.get('reps'), 0, 100, 'reps'),
                            'sec': clamp_int(m.get('sec'), 0, 86400, 'sec')})
    imgs = []
    for im in body.get('images', [])[:50]:
        g = clamp_int(im.get('group'), 0, 49, 'group')
        mi = im.get('move_idx')
        mi = clamp_int(mi, 0, 199, 'move_idx') if mi is not None else None
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
        user = canon_user(c, user)
        cur = c.execute('INSERT INTO sessions(day,started_at,duration_sec,active_sec,moves_done,moves_json,workout,workout_name,username) VALUES(?,?,?,?,?,?,?,?,?)',
                        (day, started, dur, act, done, json.dumps(clean_moves), wid, wname, user))
        sid = cur.lastrowid
        c.executemany('INSERT INTO images(session_id,grp,move_idx,data) VALUES(?,?,?,?)', [(sid, g, mi, raw) for g, mi, raw in imgs])
        t = c.execute('SELECT COALESCE(SUM(duration_sec),0) s, COUNT(*) n FROM sessions WHERE day=? AND username=? COLLATE NOCASE', (day, user)).fetchone()
    return {'id': sid, 'day_total_sec': t['s'], 'day_sessions': t['n']}


WID_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
USER_RE = re.compile(r'^[\w.\-]{1,20}$')   # 字母/数字/汉字/下划线/点/横线,1~20 个字符


def clean_user(v):
    v = str(v or '').strip()
    if not USER_RE.match(v):
        raise ValueError('用户名只能包含字母、数字、汉字、_ . -,长度 1~20')
    return v


def canon_user(c, name):
    """用户名不区分大小写:已存在则沿用已有写法"""
    r = c.execute('SELECT username FROM sessions WHERE username=? COLLATE NOCASE LIMIT 1', (name,)).fetchone()
    return r['username'] if r else name


def list_workouts():
    """扫描 workouts/<id>/workout.json,返回可选的运动项目"""
    out = []
    base = os.path.join(ROOT, 'workouts')
    for name in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        f = os.path.join(base, name, 'workout.json')
        if not WID_RE.match(name) or not os.path.isfile(f):
            continue
        try:
            with open(f, encoding='utf-8') as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        out.append({'id': name, 'name': d.get('name', name), 'desc': d.get('desc', ''), 'groups': d.get('groups', 1),
                    'movesPerGroup': d.get('movesPerGroup', 1), 'reps': d.get('reps', 10)})
    return out


def list_days(user):
    with db() as c:
        return [dict(r) for r in c.execute(
            'SELECT day, SUM(duration_sec) total_sec, SUM(active_sec) active_sec, COUNT(*) sessions FROM sessions WHERE username=? COLLATE NOCASE GROUP BY day ORDER BY day DESC LIMIT 400', (user,))]


def list_users():
    with db() as c:
        return [dict(r) for r in c.execute('SELECT username name, COUNT(*) sessions, MAX(day) last_day FROM sessions GROUP BY username COLLATE NOCASE ORDER BY MAX(id) DESC LIMIT 50')]


def list_sessions(day, user):
    with db() as c:
        out = []
        for r in c.execute('SELECT * FROM sessions WHERE day=? AND username=? COLLATE NOCASE ORDER BY id DESC', (day, user)):
            d = dict(r)
            d['moves'] = json.loads(d.pop('moves_json'))
            d['images'] = [dict(i) for i in c.execute('SELECT id, grp, move_idx FROM images WHERE session_id=? ORDER BY grp', (r['id'],))]
            out.append(d)
        return out


# ---------------- 休息音乐 ----------------
def music_row(r):
    return {'id': r['id'], 'title': r['title'], 'ext': r['ext'], 'size': r['size'], 'url': f"music-files/{r['id']}.{r['ext']}"}


def list_music():
    with db() as c:
        return [music_row(r) for r in c.execute('SELECT * FROM music ORDER BY id DESC')]


def add_music(title, ext, size, source, tmp_path):
    """tmp_path 已写好的文件 -> 入库并改名为 <id>.<ext>"""
    title = (title or '未命名').strip()[:60] or '未命名'
    with db() as c:
        cur = c.execute('INSERT INTO music(title,ext,size,source) VALUES(?,?,?,?)', (title, ext, size, source))
        mid = cur.lastrowid
    os.replace(tmp_path, os.path.join(MUSIC_DIR, f'{mid}.{ext}'))
    return {'id': mid, 'title': title, 'ext': ext, 'size': size, 'url': f'music-files/{mid}.{ext}'}


def delete_music(mid):
    with db() as c:
        r = c.execute('SELECT ext FROM music WHERE id=?', (mid,)).fetchone()
        if not r:
            return 0
        c.execute('DELETE FROM music WHERE id=?', (mid,))
    try:
        os.remove(os.path.join(MUSIC_DIR, f'{mid}.{r["ext"]}'))
    except OSError:
        pass
    return 1


# 字节系 CDN:这些域名只会指向公网。手机开了代理/VPN 时会被解析成假内网地址(如 198.18.x.x),不应误拦
TRUSTED_CDN = re.compile(r'(^|\.)(douyinstatic|douyinvod|douyincdn|douyinpic|amemv|bytecdn|byteimg|snssdk|pstatp|ixigua|zjcdn|bytedance|byteoversea)\.(com|cn|net)$')


def _check_host(host):
    """防 SSRF:禁止访问内网/本机地址"""
    if TRUSTED_CDN.search(host or ''):
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        raise ValueError('无法解析该域名')
    for i in infos:
        ip = ipaddress.ip_address(i[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise ValueError(f'不允许访问内网地址({host} → {ip})')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None  # 手动处理重定向,逐跳检查地址


DOUYIN_RE = re.compile(r'(^|\.)(douyin|iesdouyin|tiktok|toutiao)\.com$')


def parse_via_service(link):
    """调用 media-parser(PARSER_URL)把平台分享链接解析成 (音频直链, 标题)。"""
    import urllib.parse
    api = f'{PARSER_URL}/api/v1/parse?url=' + urllib.parse.quote(link, safe='')
    try:
        with urllib.request.urlopen(urllib.request.Request(api, headers={'User-Agent': 'Mozilla/5.0'}), timeout=40) as r:
            j = json.loads(r.read(2_000_000))
    except (urllib.error.URLError, OSError, ValueError):
        raise ValueError('解析服务连不上,请确认 media-parser 已启动(PARSER_URL=' + PARSER_URL + ')')
    d = j.get('data') or {}
    if not j.get('succ') or not d.get('audio_url'):
        raise ValueError('解析失败:' + str(j.get('retdesc') or '没有拿到音频地址') + '。可改为保存视频后上传')
    return d['audio_url'], (d.get('title') or '')[:60]


def import_music_link(text):
    """从直接的音频文件链接导入。抖音等平台页面链接受反爬保护,无法自动解析。"""
    m = re.search(r'https?://[^\s\u3000"\'<>]+', text or '')
    if not m:
        raise ValueError('没有找到链接')
    cur = m.group(0).rstrip('.,;)]}，。')
    opener = urllib.request.build_opener(_NoRedirect)
    title_hint = ''
    for _ in range(5):
        u = urlparse(cur)
        if u.scheme not in ('http', 'https') or not u.hostname:
            raise ValueError('链接格式不对')
        if DOUYIN_RE.search(u.hostname) and PARSER_URL:
            cur, title_hint = parse_via_service(cur)
            u = urlparse(cur)
            if u.scheme not in ('http', 'https') or not u.hostname or DOUYIN_RE.search(u.hostname):
                raise ValueError('解析结果不是有效的音频地址')
        elif DOUYIN_RE.search(u.hostname):
            raise ValueError('抖音/TikTok 的分享链接有反爬保护,无法自动解析。请在抖音里"保存视频"到手机,再点上方"上传音频/视频文件"(mp4 也可以,只会取声音)')
        _check_host(u.hostname)
        try:
            resp = opener.open(urllib.request.Request(cur, headers={'User-Agent': 'Mozilla/5.0'}), timeout=20)
        except urllib.error.HTTPError as e:
            loc = e.headers.get('Location')
            if e.code in (301, 302, 303, 307, 308) and loc:
                cur = urljoin(cur, loc)
                continue
            raise ValueError(f'下载失败(HTTP {e.code})')
        except (urllib.error.URLError, OSError, ValueError):
            raise ValueError('下载失败,请检查链接')
        ct = (resp.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        ext = CT_EXT.get(ct) or os.path.splitext(u.path)[1].lstrip('.').lower()
        if ext not in MUSIC_EXT:
            raise ValueError('这个链接不是音频文件(需要直接指向 mp3/m4a/aac/wav 等文件)')
        tmp = os.path.join(MUSIC_DIR, f'.tmp_{os.getpid()}_{threading.get_ident()}')
        size = 0
        try:
            with open(tmp, 'wb') as f:
                while True:
                    buf = resp.read(65536)
                    if not buf:
                        break
                    size += len(buf)
                    if size > MAX_MUSIC:
                        raise ValueError('文件太大(上限 60MB)')
                    f.write(buf)
            if size < 1024:
                raise ValueError('文件太小,不是有效的音频')
            title = title_hint or unquote(os.path.splitext(os.path.basename(u.path))[0]) or u.hostname
            return add_music(title, ext, size, cur[:300], tmp)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    raise ValueError('重定向次数过多')


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
            if method == 'GET' and parts == ['api', 'users']:
                return self._json(list_users())
            if method == 'GET' and parts == ['api', 'days']:
                return self._json(list_days(clean_user(parse_qs(u.query).get('user', [''])[0])))
            if method == 'GET' and parts == ['api', 'sessions']:
                day = parse_qs(u.query).get('day', [''])[0]
                if not DAY_RE.match(day):
                    return self._json({'error': 'day 参数不合法'}, 400)
                return self._json(list_sessions(day, clean_user(parse_qs(u.query).get('user', [''])[0])))
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
                    cur = c.execute('DELETE FROM sessions WHERE id=? AND username=? COLLATE NOCASE', (int(parts[2]), clean_user(parse_qs(u.query).get('user', [''])[0])))
                return self._json({'deleted': cur.rowcount})
            if method == 'GET' and parts == ['api', 'workouts']:
                return self._json(list_workouts())
            if method == 'GET' and parts == ['api', 'music']:
                return self._json(list_music())
            if method == 'PUT' and parts == ['api', 'music']:
                name = parse_qs(u.query).get('name', ['未命名'])[0]
                ext = os.path.splitext(name)[1].lstrip('.').lower()
                n = int(self.headers.get('Content-Length') or 0)
                if ext not in MUSIC_EXT:
                    return self._json({'error': '只支持 mp3 / m4a / aac / wav / ogg / flac / mp4'}, 400)
                if n < 1024 or n > MAX_MUSIC:
                    return self._json({'error': '文件大小不合法(1KB ~ 60MB)'}, 413)
                tmp = os.path.join(MUSIC_DIR, f'.tmp_{os.getpid()}_{threading.get_ident()}')
                try:
                    left = n
                    with open(tmp, 'wb') as f:
                        while left > 0:
                            buf = self.rfile.read(min(65536, left))
                            if not buf:
                                raise ValueError('上传中断')
                            f.write(buf)
                            left -= len(buf)
                    return self._json(add_music(os.path.splitext(name)[0], ext, n, '上传', tmp), 201)
                finally:
                    if os.path.exists(tmp):
                        os.remove(tmp)
            if method == 'POST' and parts == ['api', 'music', 'link']:
                n = int(self.headers.get('Content-Length') or 0)
                if n <= 0 or n > 10000:
                    return self._json({'error': '请求体大小不合法'}, 413)
                try:
                    body = json.loads(self.rfile.read(n))
                except ValueError:
                    return self._json({'error': 'JSON 格式错误'}, 400)
                return self._json(import_music_link(str(body.get('url', ''))), 201)
            if method == 'DELETE' and len(parts) == 3 and parts[1] == 'music' and parts[2].isdigit():
                return self._json({'deleted': delete_music(int(parts[2]))})
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

    def do_PUT(self):
        if self.path.startswith('/api/'):
            return self._api('PUT')
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

    def translate_path(self, path):
        p = urlparse(path).path
        if p.startswith('/music-files/'):  # /music-files/<id>.<ext> -> data/music/<id>.<ext>
            fn = os.path.basename(unquote(p))
            if re.fullmatch(r'\d+\.(' + '|'.join(MUSIC_EXT) + ')', fn):
                return os.path.join(MUSIC_DIR, fn)
            return os.path.join(ROOT, '__missing__')
        return super().translate_path(path)

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
        self.send_header('X-Content-Type-Options', 'nosniff')
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
