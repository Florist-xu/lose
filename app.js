import { FilesetResolver, PoseLandmarker } from './lib/package/vision_bundle.mjs';

const $ = id => document.getElementById(id);
const GROUP_CN = ['第一组', '第二组', '第三组', '第四组', '第五组'];
const cam = $('cam'), overlay = $('overlay'), ctx = overlay.getContext('2d'), ref = $('ref'), bgm = $('bgm');
// 示范画面(视频,可选/静音)与独立音频(bgm)一起按当前动作的片段同步;视频缺失也不影响声音
ref.muted = true;
let refOk = true;
ref.addEventListener('error', () => { refOk = false; ref.closest('.card').style.display = 'none'; });
const mSeek = t => { try { bgm.currentTime = t; } catch {} if (refOk) try { ref.currentTime = t; } catch {} };
const mPause = () => { bgm.pause(); if (refOk) ref.pause(); };
const mPlay = () => { bgm.muted = !$('sound').checked; bgm.play().catch(() => {}); if (refOk) ref.play().catch(() => {}); };
let DATA, landmarker = null;

// ---------- 状态 ----------
const S = {
  phase: 'idle',        // idle | rest | active | done
  g: 0, m: 0,           // 当前组 / 动作
  rep: 0, flags: { L: false, R: false }, sideCnt: { L: 0, R: 0 },
  restLeft: 0, moveTime: 0, totalTime: 0, paused: false,
  doneSet: new Set(), moveTimes: [], moveReps: [],
  startedAt: null, active: 0, imgs: {}, plan: {}, saved: false,
  lifts: { L: mkLift(), R: mkLift() },
};
function mkLift() { return { lifting: false, minK: 9, feat: null }; }
const idx = () => S.g * 4 + S.m;
const seg = () => DATA.segments[idx()];
const tpl = () => DATA.templates[S.m];

// ---------- 提示音 ----------
let actx;
function beep(f = 880, d = 0.09, v = 0.15) {
  try { actx ??= new AudioContext(); const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = f; g.gain.value = v; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + d); } catch {}
}
const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');

// ---------- 特征(与 build_templates.py 完全一致) ----------
let aspect = 16 / 9;
function feats(lm, side) {
  const P = i => [lm[i].x * aspect, lm[i].y];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const [ls, rs, lh, rh, lk, rk, lw, rw, le, re] = [11, 12, 23, 24, 25, 26, 15, 16, 13, 14].map(P);
  const T = dist([(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2], [(lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2]) + 1e-6;
  const L = side === 'L', kk = L ? lk : rk;
  const [sw, ow] = L ? [lw, rw] : [rw, lw], [se, oe] = L ? [le, re] : [re, le];
  const knee = ((L ? lk : rk)[1] - (L ? lh : rh)[1]) / T;
  return [dist(sw, kk) / T, dist(ow, kk) / T, dist(se, kk) / T, dist(oe, kk) / T,
    Math.abs(lw[0] - rw[0]) / T, ((lw[1] + rw[1]) / 2 - (lh[1] + rh[1]) / 2) / T, (Math.min(lw[1], rw[1]) - kk[1]) / T, knee];
}
function kneeVal(lm, side) {
  const t = Math.hypot(((lm[11].x + lm[12].x) / 2 - (lm[23].x + lm[24].x) / 2) * aspect, (lm[11].y + lm[12].y) / 2 - (lm[23].y + lm[24].y) / 2) + 1e-6;
  return side === 'L' ? (lm[25].y - lm[23].y) / t : (lm[26].y - lm[24].y) / t;
}
const score = (t, f) => f.reduce((s, v, i) => s + Math.abs((v - t.mean[i]) / t.std[i]), 0) / f.length;
const accept = () => +$('sens').value;

// ---------- UI ----------
function setMsg(t, cls = '') { const e = $('msg'); e.textContent = t; e.className = 'msg ' + cls; }
function showBig(h, cd, s) { $('bigH').textContent = h; $('bigCd').textContent = cd ?? ''; $('bigS').textContent = s ?? ''; $('big').classList.add('show'); }
const hideBig = () => $('big').classList.remove('show');
function renderChips() {
  let h = '';
  for (let g = 0; g < 5; g++) {
    h += `<div>${GROUP_CN[g].slice(1)}</div>`;
    for (let m = 0; m < 4; m++) {
      const i = g * 4 + m, cls = (i === idx() && S.phase !== 'done' && S.phase !== 'idle' ? 'cur ' : '') + (S.doneSet.has(i) ? 'done' : '');
      h += `<div class="chip ${cls}" data-i="${i}" title="${DATA.templates[m].name}">${DATA.templates[m].name.slice(0, 2)}</div>`;
    }
  }
  $('chips').innerHTML = h;
}
$('chips').addEventListener('click', e => {
  const i = e.target.dataset?.i; if (i == null || !landmarker) return;
  if (S.phase === 'active' && S.moveTime > 2 && S.imgs[S.g] === undefined) capture(S.g); // 离开当前组前兜底抓拍
  S.g = Math.floor(i / 4); S.m = i % 4; startRest(3);
});
function renderHud() {
  $('hGroup').textContent = GROUP_CN[S.g]; $('hMove').textContent = tpl().name;
  $('cnt').textContent = S.rep; $('hTimer').textContent = fmt(S.moveTime); $('sTotal').textContent = fmt(S.totalTime);
  $('sDone').textContent = S.doneSet.size + '/20'; $('sL').textContent = S.sideCnt.L; $('sR').textContent = S.sideCnt.R;
}

// ---------- 流程 ----------
function resetCount() { S.rep = 0; S.flags = { L: false, R: false }; S.sideCnt = { L: 0, R: 0 }; S.moveTime = 0; S.lifts = { L: mkLift(), R: mkLift() }; }
function startRest(sec = DATA.restSec) {
  resetCount(); S.phase = 'rest'; S.restLeft = sec; mPause();
  mSeek(seg().start + 1); renderChips(); renderHud();
  showBig(`${GROUP_CN[S.g]} · ${tpl().name}`, Math.ceil(S.restLeft), '准备,站到画面中');
  setMsg('休息 / 准备中…');
}
function startActive() {
  S.phase = 'active'; hideBig(); beep(1200, 0.25); renderChips();
  S.startedAt ??= new Date();
  S.plan[S.g] ??= { m: Math.floor(Math.random() * 4), at: 4 + Math.random() * 14 }; // 每组随机抓拍:随机动作 + 随机时刻
  setMsg('开始!左右腿各抬一次算 1 次', '');
  mSeek(seg().start + 1); mPlay();
}
function completeMove() {
  S.doneSet.add(idx()); S.moveTimes[idx()] = S.moveTime; S.moveReps[idx()] = S.rep; beep(1500, 0.4, 0.2);
  mPause();
  const p = S.plan[S.g]; if (S.imgs[S.g] === undefined && S.phase === 'active' && (S.m === 3 || (p && p.m === S.m))) capture(S.g); // 兜底:保证每组有图
  if (idx() >= 19) return finish();
  const nm = idx() + 1; S.g = Math.floor(nm / 4); S.m = nm % 4;
  startRest();
}
function finish() { setMsg('全部完成!', 'ok'); endWorkout(); }

// ---------- 随机抓拍 ----------
function capture(g) {
  if (!cam.videoWidth) return;
  const w = Math.min(640, cam.videoWidth), h = Math.round(w * cam.videoHeight / cam.videoWidth);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  if ($('mirror').checked) { x.translate(w, 0); x.scale(-1, 1); }
  x.drawImage(cam, 0, 0, w, h);
  S.imgs[g] = { data: c.toDataURL('image/jpeg', 0.72), move_idx: idx() };
}

// ---------- 结束 / 保存 / 历史 ----------
const pad = n => String(n).padStart(2, '0');
const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDur = s => `${Math.floor(s / 60)}分${pad(Math.round(s % 60))}秒`;
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const modal = $('modal'), mbox = $('mbox');
function openModal(html, dismissable = false) { mbox.innerHTML = html; mbox.dataset.dismiss = dismissable ? '1' : ''; modal.classList.add('show'); }
const closeModal = () => modal.classList.remove('show');
modal.addEventListener('click', e => { if (e.target === modal && mbox.dataset.dismiss) closeModal(); });
const setNote = (t, cls = '') => { const e = $('note'); if (e) { e.textContent = t; e.className = 'note ' + cls; } };

function buildPayload() {
  const moves = [];
  S.moveTimes.forEach((sec, i) => { if (sec !== undefined) moves.push({ idx: i, reps: S.moveReps[i] ?? 0, sec: Math.round(sec) }); });
  const images = Object.entries(S.imgs).map(([g, v]) => ({ group: +g, move_idx: v.move_idx, data: v.data }));
  const t0 = S.startedAt ?? new Date();
  return { day: dayOf(t0), started_at: t0.toISOString(), duration_sec: Math.round(S.totalTime), active_sec: Math.round(S.active), moves_done: S.doneSet.size, moves, images };
}
function endWorkout() {
  if (S.phase === 'idle') return;
  if (S.phase === 'active') {
    if (S.moveTime > 1 && S.moveTimes[idx()] === undefined) { S.moveTimes[idx()] = S.moveTime; S.moveReps[idx()] = S.rep; }
    if (S.imgs[S.g] === undefined) capture(S.g);
  }
  S.phase = 'done'; mPause(); hideBig(); renderChips();
  $('btnEnd').disabled = $('btnPause').disabled = $('btnSkip').disabled = true;
  showSavePrompt();
}
function showSavePrompt() {
  const p = buildPayload();
  if (p.duration_sec < 5) {
    openModal(`<h2>训练时间太短</h2><div class="sub">不足 5 秒,没有可保存的记录。</div><div class="btns"><button id="bAgain" class="pri">重新开始</button></div>`);
    $('bAgain').onclick = () => location.reload();
    return;
  }
  const thumbs = [0, 1, 2, 3, 4].map(g => `<figure>${S.imgs[g] ? `<img src="${S.imgs[g].data}" alt="">` : '<img alt="">'}第${g + 1}组</figure>`).join('');
  openModal(`<h2>🎉 训练结束</h2><div class="sub">${esc(p.day)} · 是否保存今天的锻炼记录?</div>
    <div class="kv"><div><b>${fmtDur(p.duration_sec)}</b><span>总用时(含休息)</span></div><div><b>${fmtDur(p.active_sec)}</b><span>动作用时</span></div>
    <div><b>${p.moves_done}/20</b><span>完成动作</span></div><div><b>${p.images.length}/5</b><span>每组随机抓拍</span></div></div>
    <div class="thumbs">${thumbs}</div>
    <div class="btns"><button id="bSave" class="pri">保存记录</button><button id="bDiscard" class="danger">放弃保存</button></div><div id="note" class="note"></div>`);
  $('bSave').onclick = () => doSave(p);
  $('bDiscard').onclick = () => {
    if (!confirm('确定放弃本次记录吗?放弃后无法找回。')) return;
    S.imgs = {};
    openModal(`<h2>已放弃保存</h2><div class="sub">本次训练不会计入每日记录。</div><div class="btns"><button id="bAgain" class="pri">重新开始</button><button id="bClose">关闭</button></div>`, true);
    $('bAgain').onclick = () => location.reload(); $('bClose').onclick = closeModal;
  };
}
async function doSave(p) {
  if (S.saved) return;
  $('bSave').disabled = $('bDiscard').disabled = true; setNote('保存中…');
  try {
    const r = await fetch('api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    S.saved = true;
    openModal(`<h2>✅ 已保存</h2><div class="sub">今天累计 ${j.day_sessions} 次训练,共 ${fmtDur(j.day_total_sec)}。</div>
      <div class="btns"><button id="bHist" class="pri">查看历史</button><button id="bAgain">重新开始</button></div>`, true);
    $('bHist').onclick = openHistory; $('bAgain').onclick = () => location.reload();
  } catch (e) {
    $('bSave').disabled = $('bDiscard').disabled = false;
    setNote('保存失败:' + e.message + '(可点"保存记录"重试)', 'bad');
  }
}
async function openHistory() {
  openModal('<h2>历史记录</h2><div class="sub">加载中…</div>', true);
  try {
    const days = await (await fetch('api/days')).json();
    if (!Array.isArray(days)) throw new Error(days.error || '返回格式错误');
    const rows = days.map(d => `<div class="dayrow" data-day="${esc(d.day)}"><span>${esc(d.day)}</span><span>${d.sessions} 次 · ${fmtDur(d.total_sec)}</span></div>`).join('');
    openModal(`<h2>历史记录</h2><div class="sub">按天汇总的锻炼时长,点击查看详情</div>${rows || '<div class="sub">还没有记录</div>'}<div class="btns"><button id="bClose">关闭</button></div>`, true);
    $('bClose').onclick = closeModal;
    mbox.querySelectorAll('.dayrow').forEach(el => el.onclick = () => openDay(el.dataset.day));
  } catch (e) {
    openModal(`<h2>历史记录</h2><div class="note bad">加载失败:${esc(e.message)}</div><div class="btns"><button id="bClose">关闭</button></div>`, true);
    $('bClose').onclick = closeModal;
  }
}
async function openDay(day) {
  try {
    const list = await (await fetch('api/sessions?day=' + encodeURIComponent(day))).json();
    const html = list.map(s => `<div class="sess"><b>${esc(new Date(s.started_at).toLocaleTimeString())}</b> · 总用时 ${fmtDur(s.duration_sec)} · 动作用时 ${fmtDur(s.active_sec)} · 完成 ${s.moves_done}/20
      <div class="thumbs">${s.images.map(i => `<figure><img loading="lazy" src="api/images/${i.id}" alt="">第${i.grp + 1}组</figure>`).join('')}</div>
      <button data-del="${s.id}" class="danger">删除这条</button></div>`).join('');
    openModal(`<h2>${esc(day)}</h2>${html || '<div class="sub">当天没有记录</div>'}<div class="btns"><button id="bBack">返回</button><button id="bClose">关闭</button></div>`, true);
    $('bBack').onclick = openHistory; $('bClose').onclick = closeModal;
    mbox.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('确定删除这条记录(含图片)吗?')) return;
      await fetch('api/sessions/' + b.dataset.del, { method: 'DELETE' }); openDay(day);
    });
  } catch (e) {
    openModal(`<div class="note bad">加载失败:${esc(e.message)}</div><div class="btns"><button id="bBack">返回</button></div>`, true);
    $('bBack').onclick = openHistory;
  }
}

// ---------- 识别 ----------
function onLift(side) {
  const l = S.lifts[side]; if (!l.feat) return;
  const sc = score(tpl(), l.feat), lim = accept();
  if (sc < lim) {
    if (!S.flags[side]) { S.flags[side] = true; S.sideCnt[side]++; }
    setMsg(`${side === 'L' ? '左' : '右'}腿 ✓ 动作到位(匹配 ${(100 - Math.min(100, sc / lim * 60)).toFixed(0)}%)`, 'ok');
    if (S.flags.L && S.flags.R) {
      S.rep++; S.flags = { L: false, R: false }; beep(880);
      if (S.rep >= DATA.reps) completeMove();
    }
  } else {
    const all = DATA.templates.map((t, i) => [score(t, l.feat), i]).sort((a, b) => a[0] - b[0]);
    setMsg(all[0][0] < lim && all[0][1] !== S.m ? `这个更像「${DATA.templates[all[0][1]].name}」,请做「${tpl().name}」` : `「${tpl().name}」手部/抬腿不标准,请对照右侧示范`, 'bad');
  }
  if ($('debug').checked) $('dbgBox').textContent = `side=${side} score=${sc.toFixed(2)} lim=${lim}\nfeat=` + l.feat.map(v => v.toFixed(2)).join(' ') + '\n' + DATA.templates.map(t => t.name + ':' + score(t, l.feat).toFixed(2)).join('  ');
}
function track(lm) {
  for (const side of ['L', 'R']) {
    const k = kneeVal(lm, side), l = S.lifts[side];
    if (k < 0) { l.lifting = true; if (k < l.minK) { l.minK = k; l.feat = feats(lm, side); } }
    else if (l.lifting && k > 0.2) { if (S.phase === 'active' && !S.paused) onLift(side); S.lifts[side] = mkLift(); }
  }
}

// ---------- 绘制 ----------
const CONN = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
function draw(lm) {
  overlay.width = cam.videoWidth; overlay.height = cam.videoHeight; ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lm) return; const W = overlay.width, H = overlay.height;
  ctx.lineWidth = 4; ctx.strokeStyle = '#3ddc84';
  for (const [a, b] of CONN) { ctx.beginPath(); ctx.moveTo(lm[a].x * W, lm[a].y * H); ctx.lineTo(lm[b].x * W, lm[b].y * H); ctx.stroke(); }
  ctx.fillStyle = '#ffd23f';
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { ctx.beginPath(); ctx.arc(lm[i].x * W, lm[i].y * H, 6, 0, 7); ctx.fill(); }
}

// ---------- 主循环 ----------
let lastT = performance.now(), lastVideoT = -1;
function loop(now) {
  const dt = Math.min(0.2, (now - lastT) / 1000); lastT = now;
  if (landmarker && cam.readyState >= 2 && cam.currentTime !== lastVideoT) {
    lastVideoT = cam.currentTime; aspect = cam.videoWidth / cam.videoHeight;
    const r = landmarker.detectForVideo(cam, now), lm = r.landmarks?.[0];
    draw(lm);
    const ok = lm && [11, 12, 23, 24, 25, 26].every(i => (lm[i].visibility ?? 1) > 0.4);
    if (!ok && S.phase === 'active') setMsg('请后退,让头到膝盖都进入画面', 'bad');
    else if (ok && S.phase !== 'idle' && S.phase !== 'done') track(lm);
  }
  if (!S.paused && (S.phase === 'rest' || S.phase === 'active')) {
    S.totalTime += dt;
    if (S.phase === 'rest') {
      const prev = Math.ceil(S.restLeft); S.restLeft -= dt;
      if (Math.ceil(S.restLeft) !== prev && S.restLeft > 0 && S.restLeft <= 3) beep(660, 0.1);
      $('bigCd').textContent = Math.max(0, Math.ceil(S.restLeft));
      if (S.restLeft <= 0) startActive();
    } else {
      S.moveTime += dt; S.active += dt;
      const pl = S.plan[S.g]; if (pl && S.imgs[S.g] === undefined && S.m === pl.m && S.moveTime >= pl.at) capture(S.g);
      const s = seg(); if (bgm.currentTime > s.end - 0.5 || bgm.currentTime < s.start) mSeek(s.start + 1); // 循环当前动作的音乐/示范片段
    }
    renderHud();
  }
  requestAnimationFrame(loop);
}

// ---------- 事件 ----------
$('mirror').onchange = e => { cam.classList.toggle('mirror', e.target.checked); overlay.classList.toggle('mirror', e.target.checked); };
$('sound').onchange = e => { bgm.muted = !e.target.checked; };
$('debug').onchange = e => { $('dbgBox').style.display = e.target.checked ? 'block' : 'none'; };
$('btnEnd').onclick = () => { if ((S.phase === 'active' || S.phase === 'rest') && confirm('确定结束本次训练吗?')) endWorkout(); };
$('btnHistory').onclick = openHistory;
$('btnSkip').onclick = () => { if (S.phase === 'active' || S.phase === 'rest') completeMove(); };
$('btnPause').onclick = () => {
  S.paused = !S.paused; $('btnPause').textContent = S.paused ? '继续' : '暂停';
  if (S.paused) mPause(); else if (S.phase === 'active') mPlay();
  setMsg(S.paused ? '已暂停' : '继续');
};
addEventListener('keydown', e => { if (e.key === 'n') $('btnSkip').click(); if (e.key === ' ') { e.preventDefault(); $('btnPause').click(); } });

$('btnStart').onclick = async () => {
  $('btnStart').disabled = true; setMsg('正在加载模型与摄像头…');
  try {
    try { actx ??= new AudioContext(); await actx.resume(); beep(1, 0.01, 0.001); } catch {} // 在点击手势内解锁提示音(iOS)
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前地址不是安全连接,浏览器禁用了摄像头。请用 https://' + location.hostname + ':8443 打开(或在本机用 localhost)');
    DATA = await (await fetch('templates.json')).json();
    const fileset = await FilesetResolver.forVisionTasks('./lib/package/wasm');
    const mk = delegate => PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: './lib/pose_landmarker_full.task', delegate }, runningMode: 'VIDEO', numPoses: 1 });
    try { landmarker = await mk('GPU'); } catch { landmarker = await mk('CPU'); }
    cam.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' }, audio: false });
    await cam.play();
    await Promise.all([bgm.play().then(() => bgm.pause()).catch(() => {}), ref.play().then(() => ref.pause()).catch(() => {})]); // 在用户手势内解锁音频(iOS)
    $('btnPause').disabled = $('btnSkip').disabled = $('btnEnd').disabled = false;
    S.g = 0; S.m = 0; startRest();
  } catch (err) { setMsg('启动失败:' + err.message + '(请用 http://localhost:8080 打开并允许摄像头)', 'bad'); $('btnStart').disabled = false; console.error(err); }
};
fetch('templates.json').then(r => r.json()).then(d => { DATA = d; renderChips(); renderHud(); });
requestAnimationFrame(loop);
