// 零依赖静态服务器(支持视频 Range 请求)。运行: node server.js  然后打开 http://localhost:8080
const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname, port = process.env.PORT || 8080;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.task': 'application/octet-stream' };
http.createServer((req, res) => {
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
}).listen(port, () => console.log('打开 http://localhost:' + port));
