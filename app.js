import { FilesetResolver, PoseLandmarker } from './lib/package/vision_bundle.mjs';

const $ = id => document.getElementById(id);
const GROUP_CN = ['第一组', '第二组', '第三组', '第四组', '第五组'];
const cam = $('cam'), overlay = $('overlay'), ctx = overlay.getContext('2d'), ref = $('ref');
let DATA, landmarker = null;

// ---------- 状态 ----------
const S = {
  phase: 'idle',        // idle | rest | active | done
  g: 0, m: 0,           // 当前组 / 动作
  rep: 0, flags: { L: false, R: false }, sideCnt: { L: 0, R: 0 },
  restLeft: 0, moveTime: 0, totalTime: 0, paused: false,
  doneSet: new Set(), moveTimes: [],
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
  resetCount(); S.phase = 'rest'; S.restLeft = sec; ref.pause();
  ref.currentTime = seg().start + 1; renderChips(); renderHud();
  showBig(`${GROUP_CN[S.g]} · ${tpl().name}`, Math.ceil(S.restLeft), '准备,站到画面中');
  setMsg('休息 / 准备中…');
}
function startActive() {
  S.phase = 'active'; hideBig(); beep(1200, 0.25); renderChips();
  setMsg('开始!左右腿各抬一次算 1 次', '');
  ref.muted = !$('sound').checked; ref.currentTime = seg().start + 1; ref.play().catch(() => {});
}
function completeMove() {
  S.doneSet.add(idx()); S.moveTimes[idx()] = S.moveTime; beep(1500, 0.4, 0.2);
  ref.pause();
  if (idx() >= 19) return finish();
  const nm = idx() + 1; S.g = Math.floor(nm / 4); S.m = nm % 4;
  startRest();
}
function finish() {
  S.phase = 'done'; ref.pause();
  const lines = DATA.segments.map((s, i) => '').length; // eslint-disable-line
  showBig('🎉 全部完成!', fmt(S.totalTime), '5 组 × 4 动作 × 20 次 总用时');
  setMsg('完成!刷新页面可重新开始', 'ok'); renderChips();
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
      S.moveTime += dt;
      const s = seg(); if (ref.currentTime > s.end - 0.5) ref.currentTime = s.start + 1; // 循环示范片段
    }
    renderHud();
  }
  requestAnimationFrame(loop);
}

// ---------- 事件 ----------
$('mirror').onchange = e => { cam.classList.toggle('mirror', e.target.checked); overlay.classList.toggle('mirror', e.target.checked); };
$('sound').onchange = e => { ref.muted = !e.target.checked; };
$('debug').onchange = e => { $('dbgBox').style.display = e.target.checked ? 'block' : 'none'; };
$('btnSkip').onclick = () => { if (S.phase === 'active' || S.phase === 'rest') completeMove(); };
$('btnPause').onclick = () => {
  S.paused = !S.paused; $('btnPause').textContent = S.paused ? '继续' : '暂停';
  if (S.paused) ref.pause(); else if (S.phase === 'active') ref.play().catch(() => {});
  setMsg(S.paused ? '已暂停' : '继续');
};
addEventListener('keydown', e => { if (e.key === 'n') $('btnSkip').click(); if (e.key === ' ') { e.preventDefault(); $('btnPause').click(); } });

$('btnStart').onclick = async () => {
  $('btnStart').disabled = true; setMsg('正在加载模型与摄像头…');
  try {
    DATA = await (await fetch('templates.json')).json();
    const fileset = await FilesetResolver.forVisionTasks('./lib/package/wasm');
    const mk = delegate => PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: './lib/pose_landmarker_full.task', delegate }, runningMode: 'VIDEO', numPoses: 1 });
    try { landmarker = await mk('GPU'); } catch { landmarker = await mk('CPU'); }
    cam.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' }, audio: false });
    await cam.play(); await ref.play().then(() => ref.pause()).catch(() => {}); // 在用户手势内解锁音频
    $('btnPause').disabled = $('btnSkip').disabled = false;
    S.g = 0; S.m = 0; startRest();
  } catch (err) { setMsg('启动失败:' + err.message + '(请用 http://localhost:8080 打开并允许摄像头)', 'bad'); $('btnStart').disabled = false; console.error(err); }
};
fetch('templates.json').then(r => r.json()).then(d => { DATA = d; renderChips(); renderHud(); });
requestAnimationFrame(loop);
