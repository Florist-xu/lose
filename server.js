// 零依赖静态服务器(支持视频 Range 请求)。运行: node server.js  然后打开 http://localhost:8080
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const root = __dirname, port = process.env.PORT || 8080;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.task': 'application/octet-stream' };
const handler = (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(root, p));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
  const size = fs.statSync(f).size, type = types[path.extname(f)] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range); let s = m[1] ? +m[1] : 0, e = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1, 'Content-Type': type });
    fs.createReadStream(f, { start: s, end: e }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(f).pipe(res);
  }
};
http.createServer(handler).listen(port, () => console.log('电脑/本机: http://localhost:' + port));
// 手机(尤其 iPhone)通过局域网 IP 访问时,摄像头要求 HTTPS:有 certs/ 目录就同时开 HTTPS
const kf = path.join(root, 'certs/key.pem'), cf = path.join(root, 'certs/cert.pem');
if (fs.existsSync(kf) && fs.existsSync(cf)) {
  const sp = process.env.SPORT || 8443;
  https.createServer({ key: fs.readFileSync(kf), cert: fs.readFileSync(cf) }, handler)
    .listen(sp, () => console.log('手机(HTTPS): https://<本机局域网IP>:' + sp + '  (首次需点"继续访问/信任")'));
} else console.log('未找到 certs/,如需手机用局域网访问摄像头,请先运行 gen-cert 脚本');
