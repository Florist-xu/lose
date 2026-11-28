import { FilesetResolver, PoseLandmarker } from './lib/package/vision_bundle.mjs';

const $ = id => document.getElementById(id);
const CNUM = '一二三四五六七八九十';
const gname = g => g < 10 ? `第${CNUM[g]}组` : `第${g + 1}组`;
const cam = $('cam'), overlay = $('overlay'), ctx = overlay.getContext('2d'), ref = $('ref'), bgm = $('bgm'), restAudio = $('restAudio');
// 示范画面(视频,可选/静音)与独立音频(bgm)一起按当前动作的片段同步;视频缺失也不影响声音
ref.muted = true;
let refOk = true;
ref.addEventListener('error', () => { refOk = false; $('refCard').style.display = 'none'; document.body.classList.add('hideRef'); $('fsRef').style.display = 'none'; });
const mSeek = t => { try { bgm.currentTime = t; } catch {} if (refOk) try { ref.currentTime = t; } catch {} };
const mPause = () => { bgm.pause(); restAudio.pause(); if (refOk) ref.pause(); };
const mPlay = () => {
  bgm.muted = !$('sound').checked;
  bgm.play().catch(() => {
    setMsg('音乐被浏览器拦截,轻点一下屏幕即可开启', 'bad');
    addEventListener('pointerdown', () => { if (S.phase === 'active' && !S.paused) bgm.play().catch(() => {}); }, { once: true });
  });
  if (refOk) ref.play().catch(() => {});
};

// 音乐文件改用 fetch 下载成 blob 再播放:iPhone/Safari 对"自签名 HTTPS"页面,
// <audio src> 直连会加载失败,而 fetch 会沿用页面已信任的证书。加载状态显示在页头。
const bgmState = t => { const e = $('bgmState'); if (e) e.textContent = t; };
let WLIST = [], HOLD = false, bgmReady = false, DATA, WID, landmarker = null;
const NG = () => DATA.groups, NM = () => DATA.movesPerGroup, NMOV = () => DATA.groups * DATA.movesPerGroup;

// ---------- 运动项目:workouts/<id>/workout.json + 同目录的音频/示范视频 ----------
// 换项目 = 刷新页面并带上 ?w=<id>(训练中不允许切换)
async function init() {
  const btn = $('btnStart'), label = btn.textContent;
  btn.disabled = true; btn.textContent = '加载中…'; bgmState('(加载中…)');
  let list = [];
  try { list = await (await fetch('api/workouts')).json(); } catch {}
  if (!list.length) { setMsg('没有找到运动项目(workouts 目录)', 'bad'); btn.textContent = label; return; }
  let saved = null; try { saved = localStorage.getItem('workout'); } catch {}
  WID = [new URLSearchParams(location.search).get('w'), saved].find(x => x && list.some(w => w.id === x)) || list[0].id;
  WLIST = list;
  const sel = $('wsel'); sel.innerHTML = list.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join(''); sel.value = WID;
  sel.onchange = () => { try { localStorage.setItem('workout', sel.value); } catch {} location.href = location.pathname + '?w=' + encodeURIComponent(sel.value); };
  const base = `workouts/${WID}/`;
  DATA = await (await fetch(base + 'workout.json', { cache: 'no-cache' })).json();
  DATA.groups ??= 1; DATA.movesPerGroup ??= DATA.templates.length; DATA.groupRestSec ??= 120; DATA.restSec ??= 10;
  document.title = `${DATA.name} · 跟练打卡`;
  $('title').textContent = DATA.name;
  $('hstats').innerHTML = `${NG()} 组<i>·</i>${NM()} 个动作<i>·</i>每个 ${DATA.reps} ${DATA.unit || '次'}`;
  if (DATA.cover) { $('heroCover').src = base + DATA.cover; $('heroCover').hidden = false; }
  $('moveSec').textContent = `动作 · 每组依次完成,共 ${NG()} 组`;
  $('moveList').innerHTML = DATA.templates.map((t, i) => `<div class="li"><span class="num">${i + 1}</span><span class="lt">${esc(t.name)}</span><span class="trail">${DATA.reps} ${DATA.unit || '次'}</span></div>`).join('');
  $('cntMax').textContent = '/' + DATA.reps; $('sDone').textContent = `0/${NMOV()}`;
  HOLD = DATA.counter === 'hold';
  document.querySelectorAll('#sL,#sR').forEach(e => e.parentElement.style.display = HOLD ? 'none' : '');
  if (DATA.counter && !['kneeLift', 'hold'].includes(DATA.counter)) { setMsg(`「${DATA.name}」需要的识别方式(${DATA.counter})暂未支持`, 'bad'); btn.textContent = label; return; }
  ref.src = base + (DATA.video || 'workout.mp4');
  const au = base + (DATA.audio || 'workout.m4a');
  renderChips(); renderHud();
  // 音乐文件用 fetch 成 blob 再播放(iPhone 自签名 HTTPS 下 <audio src> 直连会失败)
  try {
    const r = await fetch(au); if (!r.ok) throw new Error('HTTP ' + r.status);
    bgm.src = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: 'audio/mp4' })); bgm.load();
    bgmReady = true; bgmState('(已就绪)');
  } catch (e) {
    console.warn('音频 fetch 失败,改用直连', e); bgm.src = au; bgm.load(); bgmReady = true; bgmState('(直连)');
  }
  bgm.addEventListener('error', () => bgmState('(加载失败)'));
  try { await loadTracks(); } catch (e) { console.warn('休息音乐列表加载失败', e); }
  btn.disabled = false; btn.textContent = label;
}

// ---------- 全屏(开始训练时铺满屏幕,结束后自动退出) ----------
// 桌面/安卓用原生全屏;iPhone 的 Safari 不支持元素全屏,自动退化为"页面内铺满"。两种方式都带画面内按钮条。
const stage = document.querySelector('.stage');
let nativeFS = false;
function enterFS() {
  stage.classList.add('full'); syncFS();
  const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (req) { try { Promise.resolve(req.call(stage)).then(() => { nativeFS = true; }).catch(() => {}); } catch {} }
}
function exitFS() {
  stage.classList.remove('full'); syncFS();
  const fe = document.fullscreenElement || document.webkitFullscreenElement;
  nativeFS = false;
  if (fe) { try { Promise.resolve((document.exitFullscreen || document.webkitExitFullscreen).call(document)).catch(() => {}); } catch {} }
}
const onFSChange = () => { if (nativeFS && !(document.fullscreenElement || document.webkitFullscreenElement)) { nativeFS = false; stage.classList.remove('full'); syncFS(); } }; // 用户按 Esc 退出
document.addEventListener('fullscreenchange', onFSChange);
document.addEventListener('webkitfullscreenchange', onFSChange);
$('fsExit').onclick = () => { if (stage.classList.contains('full')) exitFS(); else enterFS(); };
// 全屏时示范画面悬浮在左下角,可显示/隐藏(记住选择)
try { if (localStorage.getItem('hideRef') === '1') document.body.classList.add('hideRef'); } catch {}

// 训练画面控制条:图标按钮(带无障碍标签)
const FSI = {
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.3 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M5 5l10 7-10 7z"/><path d="M19 5v14"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
  shrink: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
};
const setIco = (id, ico, label) => { const b = $(id); b.innerHTML = FSI[ico]; b.setAttribute('aria-label', label); b.title = label; };
setIco('fsSkip', 'skip', '跳过本动作'); setIco('fsEnd', 'stop', '结束训练');
const syncRef = () => { const hid = document.body.classList.contains('hideRef'); setIco('fsRef', hid ? 'eyeOff' : 'eye', hid ? '显示示范' : '隐藏示范'); };
$('fsRef').onclick = () => { document.body.classList.toggle('hideRef'); try { localStorage.setItem('hideRef', document.body.classList.contains('hideRef') ? '1' : '0'); } catch {} syncRef(); };
syncRef();
const syncFS = () => { const p = $('btnPause').textContent === '继续'; setIco('fsPause', p ? 'play' : 'pause', p ? '继续' : '暂停'); const f = stage.classList.contains('full'); setIco('fsExit', f ? 'shrink' : 'expand', f ? '退出全屏' : '全屏'); };
$('fsPause').onclick = () => { $('btnPause').click(); syncFS(); };
syncFS();
$('fsSkip').onclick = () => $('btnSkip').click();
$('fsEnd').onclick = () => $('btnEnd').click();

// ---------- 状态 ----------
const S = {
  phase: 'idle',        // idle | rest | active | done
  g: 0, m: 0,           // 当前组 / 动作
  rep: 0, flags: { L: false, R: false }, sideCnt: { L: 0, R: 0 },
  restLeft: 0, moveTime: 0, totalTime: 0, paused: false,
  doneSet: new Set(), moveTimes: [], moveReps: [],
  groupBreak: false, startedAt: null, active: 0, imgs: {}, plan: {}, saved: false,
  lifts: { L: mkLift(), R: mkLift() },
};
function mkLift() { return { lifting: false, minK: 9, feat: null, best: null }; }
const idx = () => S.g * NM() + S.m;
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
const score = (t, f) => { let s = 0, ws = 0; for (let i = 0; i < f.length; i++) { const w = t.w ? t.w[i] : 1; s += w * Math.abs((f[i] - t.mean[i]) / t.std[i]); ws += w; } return s / ws; };
const accept = () => +$('sens').value;

// ---------- UI ----------
function setMsg(t, cls = '') { const e = $('msg'); e.textContent = t; e.className = 'msg ' + cls; }
function showBig(h, cd, s) { $('bigH').textContent = h; $('bigCd').textContent = cd ?? ''; $('bigS').textContent = s ?? ''; $('big').classList.add('show'); }
const hideBig = () => $('big').classList.remove('show');
function renderChips() {
  let h = '';
  $('chips').style.gridTemplateColumns = `auto repeat(${NM()},1fr)`;
  for (let g = 0; g < NG(); g++) {
    h += `<div>${gname(g).slice(1)}</div>`;
    for (let m = 0; m < NM(); m++) {
      const i = g * NM() + m, cls = (i === idx() && S.phase !== 'done' && S.phase !== 'idle' ? 'cur ' : '') + (S.doneSet.has(i) ? 'done' : '');
      h += `<div class="chip ${cls}" data-i="${i}" title="${DATA.templates[m].name}">${DATA.templates[m].name.slice(0, 2)}</div>`;
    }
  }
  $('chips').innerHTML = h;
}
$('chips').addEventListener('click', e => {
  const i = e.target.dataset?.i; if (i == null || !landmarker) return;
  if (S.phase === 'active' && S.moveTime > 2 && S.imgs[S.g] === undefined) capture(S.g); // 离开当前组前兜底抓拍
  S.g = Math.floor(i / NM()); S.m = i % NM(); startRest(3);
});
function renderHud() {
  $('hGroup').textContent = gname(S.g); $('hMove').textContent = tpl().name;
  $('cnt').textContent = S.rep; stage.style.setProperty('--p', Math.min(1, S.rep / (DATA?.reps || 1))); $('hTimer').textContent = fmt(S.moveTime); $('sTotal').textContent = fmt(S.totalTime);
  $('sDone').textContent = S.doneSet.size + '/' + NMOV(); $('sL').textContent = S.sideCnt.L; $('sR').textContent = S.sideCnt.R;
}

// ---------- 流程 ----------
function resetCount() { S.rep = 0; S.holdAcc = 0; S.good = false; S.flags = { L: false, R: false }; S.sideCnt = { L: 0, R: 0 }; S.moveTime = 0; S.lifts = { L: mkLift(), R: mkLift() }; }
function startRest(sec = DATA.restSec, groupBreak = false) {
  resetCount(); S.phase = 'rest'; S.restLeft = sec; S.groupBreak = groupBreak; mPause();
  mSeek(seg().start + 1); renderChips(); renderHud();
  $('bigCd').classList.toggle('small', groupBreak);
  if (groupBreak) {
    showBig(`${gname(S.g - 1)}完成 🎉 中场休息`, fmt(Math.ceil(S.restLeft)), `下一组:${gname(S.g)} · ${tpl().name}`);
    $('bigBtns').style.display = 'flex'; $('bPauseMusic').textContent = '⏸ 音乐'; setMsg('中场休息中…'); playRestMusic();
  } else {
    $('bigBtns').style.display = 'none';
    showBig(`${gname(S.g)} · ${tpl().name}`, Math.ceil(S.restLeft), '准备,站到画面中');
    setMsg('休息 / 准备中…');
  }
}
function startActive() {
  S.phase = 'active'; S.groupBreak = false; restAudio.pause(); $('bigBtns').style.display = 'none'; hideBig(); beep(1200, 0.25); renderChips();
  S.startedAt ??= new Date();
  S.plan[S.g] ??= { m: Math.floor(Math.random() * NM()), at: 4 + Math.random() * 14 }; // 每组随机抓拍:随机动作 + 随机时刻
  setMsg(HOLD ? '开始!保持身体成一条直线,姿势标准才计时' : '开始!左右腿各抬一次算 1 次', '');
  mSeek(seg().start + 1); mPlay();
}
function completeMove() {
  S.doneSet.add(idx()); S.moveTimes[idx()] = S.moveTime; S.moveReps[idx()] = S.rep; beep(1500, 0.4, 0.2);
  mPause();
  const p = S.plan[S.g]; if (S.imgs[S.g] === undefined && S.phase === 'active' && (S.m === NM() - 1 || (p && p.m === S.m))) capture(S.g); // 兜底:保证每组有图
  if (idx() >= NMOV() - 1) return finish();
  const nm = idx() + 1; S.g = Math.floor(nm / NM()); S.m = nm % NM();
  startRest(nm % NM() === 0 ? DATA.groupRestSec : DATA.restSec, nm % NM() === 0); // 每组结束后中场休息 2 分钟
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
  return { user: USER, workout: WID, workout_name: DATA.name, day: dayOf(t0), started_at: t0.toISOString(), duration_sec: Math.round(S.totalTime), active_sec: Math.round(S.active), moves_done: S.doneSet.size, moves, images };
}
function stopCam() { try { cam.srcObject?.getTracks().forEach(t => t.stop()); } catch {} cam.srcObject = null; draw(null); }
function endWorkout() {
  if (S.phase === 'idle') return;
  if (S.phase === 'active') {
    if (S.moveTime > 1 && S.moveTimes[idx()] === undefined) { S.moveTimes[idx()] = S.moveTime; S.moveReps[idx()] = S.rep; }
    if (S.imgs[S.g] === undefined) capture(S.g);
  }
  S.phase = 'done'; mPause(); stopCam(); hideBig(); renderChips(); exitFS(); stage.classList.remove('live'); document.body.classList.remove('training'); lock(false);
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
  const thumbs = Array.from({ length: NG() }, (_, g) => `<figure>${S.imgs[g] ? `<img src="${S.imgs[g].data}" alt="">` : '<img alt="">'}第${g + 1}组</figure>`).join('');
  openModal(`<h2>🎉 训练结束</h2><div class="sub">${esc(p.day)} · 是否保存今天的锻炼记录?</div>
    <div class="kv"><div><b>${fmtDur(p.duration_sec)}</b><span>总用时(含休息)</span></div><div><b>${fmtDur(p.active_sec)}</b><span>动作用时</span></div>
    <div><b>${p.moves_done}/${NMOV()}</b><span>完成动作</span></div><div><b>${p.images.length}/${NG()}</b><span>每组随机抓拍</span></div></div>
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
let relaxTimer = null, relaxUntil = 0;
function startRelax() {
  if (!tracks.length) return false;
  relaxUntil = Date.now() + 180000; restAudio.muted = false;
  restAudio.play().catch(() => {});
  clearTimeout(relaxTimer); relaxTimer = setTimeout(stopRelax, 180000);
  return true;
}
function stopRelax() { clearTimeout(relaxTimer); relaxUntil = 0; restAudio.pause(); }

// ---------- 今日数据:今日时长 / 近 7 天次数 / 连续天数 ----------
async function loadToday() {
  const box = $('today'); if (!box) return;
  let days = [];
  if (USER) { try { const j = await (await fetch('api/days?user=' + encodeURIComponent(USER))).json(); if (Array.isArray(j)) days = j; } catch {} }
  const map = new Map(days.map(d => [d.day, d])), now = new Date(), key = d => dayOf(d);
  const today = map.get(key(now));
  let week = 0; for (let i = 0; i < 7; i++) { const d = new Date(now); d.setDate(d.getDate() - i); week += map.get(key(d))?.sessions || 0; }
  let streak = 0; const d = new Date(now); if (!map.has(key(d))) d.setDate(d.getDate() - 1);
  while (map.has(key(d))) { streak++; d.setDate(d.getDate() - 1); }
  box.innerHTML = `<div><b>${Math.round((today?.total_sec || 0) / 60)}<small>分钟</small></b><span>今日训练</span></div>
    <div><b>${week}<small>次</small></b><span>近 7 天</span></div><div><b>${streak}<small>天</small></b><span>连续打卡</span></div>`;
}
async function doSave(p) {
  if (S.saved) return;
  $('bSave').disabled = $('bDiscard').disabled = true; setNote('保存中…');
  try {
    const r = await fetch('api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    S.saved = true; const relaxing = startRelax(); loadToday();
    openModal(`<h2>✅ 已保存</h2><div class="sub">今天累计 ${j.day_sessions} 次训练,共 ${fmtDur(j.day_total_sec)}。</div>
      ${relaxing ? '<div class="sub" id="relaxNote">🎵 摄像头已关闭,正在播放 3 分钟放松音乐</div>' : '<div class="sub">摄像头已关闭。(还没有休息音乐,可在「休息音乐」里添加,下次结束后会自动放松 3 分钟)</div>'}
      <div class="btns"><button id="bHist" class="pri">查看历史</button>${relaxing ? '<button id="bStopRelax">⏸ 停止音乐</button>' : ''}<button id="bAgain">重新开始</button></div>`, true);
    if ($('bStopRelax')) $('bStopRelax').onclick = () => { stopRelax(); $('bStopRelax').remove(); $('relaxNote').textContent = '放松音乐已停止'; };
    $('bHist').onclick = () => { closeModal(); switchTab('hist'); }; $('bAgain').onclick = () => location.reload();
  } catch (e) {
    $('bSave').disabled = $('bDiscard').disabled = false;
    setNote('保存失败:' + e.message + '(可点"保存记录"重试)', 'bad');
  }
}
const histView = html => { $('pgHist').innerHTML = html; };
async function openHistory() {
  histView('<h2>历史记录</h2><div class="sub">加载中…</div>', true);
  try {
    const days = await (await fetch('api/days?user=' + encodeURIComponent(USER))).json();
    if (!Array.isArray(days)) throw new Error(days.error || '返回格式错误');
    const rows = days.map(d => `<div class="dayrow" data-day="${esc(d.day)}"><span>${esc(d.day)}</span><span>${d.sessions} 次 · ${fmtDur(d.total_sec)}</span></div>`).join('');
    histView(`<h2>历史记录 · ${esc(USER)}</h2><div class="sub">按天汇总的锻炼时长,点击查看详情</div>${rows || '<div class="sub">还没有记录</div>'}<div class="btns"><button id="bClose">关闭</button></div>`, true);
    $('bClose').onclick = closeModal;
    $('pgHist').querySelectorAll('.dayrow').forEach(el => el.onclick = () => openDay(el.dataset.day));
  } catch (e) {
    histView(`<h2>历史记录</h2><div class="note bad">加载失败:${esc(e.message)}</div><div class="btns"><button id="bClose">关闭</button></div>`, true);
    $('bClose').onclick = closeModal;
  }
}
async function openDay(day) {
  try {
    const list = await (await fetch('api/sessions?day=' + encodeURIComponent(day) + '&user=' + encodeURIComponent(USER))).json();
    const html = list.map(s => `<div class="sess"><b>${esc(new Date(s.started_at).toLocaleTimeString())}</b> · 总用时 ${fmtDur(s.duration_sec)} · 动作用时 ${fmtDur(s.active_sec)} · ${esc(s.workout_name || '')} · 完成 ${s.moves_done} 个动作
      <div class="thumbs">${s.images.map(i => `<figure><img loading="lazy" src="api/images/${i.id}" alt="">第${i.grp + 1}组</figure>`).join('')}</div>
      <button data-del="${s.id}" class="danger">删除这条</button></div>`).join('');
    histView(`<h2>${esc(day)}</h2>${html || '<div class="sub">当天没有记录</div>'}<div class="btns"><button id="bBack">返回</button><button id="bClose">关闭</button></div>`, true);
    $('bBack').onclick = openHistory; $('bClose').onclick = closeModal;
    $('pgHist').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('确定删除这条记录(含图片)吗?')) return;
      await fetch('api/sessions/' + b.dataset.del + '?user=' + encodeURIComponent(USER), { method: 'DELETE' }); openDay(day);
    });
  } catch (e) {
    histView(`<div class="note bad">加载失败:${esc(e.message)}</div><div class="btns"><button id="bBack">返回</button></div>`, true);
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
    const f = l.feat; let hint = `「${tpl().name}」手部/抬腿不标准,请对照右侧示范`;
    if (DATA.id === 'fatburn' && S.m === 1) hint = f[7] > -0.12 ? '提膝下压:膝盖再抬高一点(至少到腰部)' : Math.max(f[0], f[1]) > 0.75 ? '提膝下压:双手要按到抬起的膝盖上' : hint;
    setMsg(all[0][0] < lim && all[0][1] !== S.m ? `这个更像「${DATA.templates[all[0][1]].name}」,请做「${tpl().name}」` : hint, 'bad');
  }
  if ($('debug').checked) $('dbgBox').textContent = `side=${side} score=${sc.toFixed(2)} lim=${lim}\nfeat=` + l.feat.map(v => v.toFixed(2)).join(' ') + '\n' + DATA.templates.map(t => t.name + ':' + score(t, l.feat).toFixed(2)).join('  ');
}
// 平板支撑:肩-髋-踝接近一条直线,且身体接近水平(侧面/斜侧面拍摄),姿势标准才累计秒数
function plankCheck(lm) {
  const vis = i => (lm[i].visibility ?? 1) > 0.4;
  let best = null;
  for (const [s, h, a] of [[11, 23, 27], [12, 24, 28]]) {
    if (!(vis(s) && vis(h) && vis(a))) continue;
    const P = i => [lm[i].x * aspect, lm[i].y], S0 = P(s), H0 = P(h), A0 = P(a);
    const v1 = [S0[0] - H0[0], S0[1] - H0[1]], v2 = [A0[0] - H0[0], A0[1] - H0[1]];
    const ang = Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-6)))) * 180 / Math.PI;
    const len = Math.hypot(S0[0] - A0[0], S0[1] - A0[1]) + 1e-6, tilt = Math.abs(S0[1] - A0[1]) / len; // 越小越水平
    // 髋相对肩-踝连线:>0 在线下方(塌腰),<0 在线上方(撅臀)
    const t = ((H0[0] - S0[0]) * (A0[0] - S0[0]) + (H0[1] - S0[1]) * (A0[1] - S0[1])) / (len * len);
    const off = ((H0[1] - S0[1]) - t * (A0[1] - S0[1])) / len;
    const c = { ang, tilt, off }; if (!best || ang < best.ang) best = c;
  }
  return best;
}
function trackHold(lm) {
  const c = plankCheck(lm);
  if (!c) { S.good = false; if (S.phase === 'active') setMsg('请侧身面对镜头,让肩、髋、脚踝都进入画面', 'bad'); return; }
  const flat = c.tilt < 0.3, straight = c.ang > 158;
  S.good = flat && straight;
  if (S.phase === 'active' && !S.paused) {
    if (S.good) { const tips = DATA.tips || [], i = Math.floor(S.moveTime / 8) % Math.max(1, tips.length); setMsg('✓ 姿势标准,计时中' + (tips.length ? ' · 要点:' + tips[i] : ''), 'ok'); }
    else setMsg(!flat ? '身体要接近水平:前臂撑地,肩膀在肘部正上方' : c.off > 0 ? '腰塌了:收紧腹部和臀部,把髋抬起来' : '臀部太高:把髋放低,身体成一条直线', 'bad');
  }
  if ($('debug').checked) $('dbgBox').textContent = `ang=${c.ang.toFixed(0)}° tilt=${c.tilt.toFixed(2)} off=${c.off.toFixed(2)} good=${S.good}`;
}
function track(lm) {
  if (HOLD) return trackHold(lm);
  for (const side of ['L', 'R']) {
    const k = kneeVal(lm, side), l = S.lifts[side];
    if (k < 0) { l.lifting = true; if (k < l.minK) l.minK = k; const f = feats(lm, side), sc = score(tpl(), f); if (sc < (l.best ?? 1e9)) { l.best = sc; l.feat = f; } } // 抬腿过程中取与当前动作最匹配的一帧(手按到膝盖的时机因人而异)
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
    const ok = lm && (HOLD || [11, 12, 23, 24, 25, 26].every(i => (lm[i].visibility ?? 1) > 0.4));
    if (HOLD && S.phase === 'active' && !lm) { S.good = false; setMsg('没有检测到人,请进入画面', 'bad'); }
    if (!ok && S.phase === 'active' && !HOLD) setMsg('请后退,让头到膝盖都进入画面', 'bad');
    else if (ok && S.phase !== 'idle' && S.phase !== 'done') track(lm);
  }
  if (!S.paused && (S.phase === 'rest' || S.phase === 'active')) {
    S.totalTime += dt;
    if (S.phase === 'rest') {
      const prev = Math.ceil(S.restLeft); S.restLeft -= dt;
      if (Math.ceil(S.restLeft) !== prev && S.restLeft > 0 && S.restLeft <= 3) beep(660, 0.1);
      $('bigCd').textContent = S.groupBreak ? fmt(Math.max(0, Math.ceil(S.restLeft))) : Math.max(0, Math.ceil(S.restLeft));
      if (S.restLeft <= 0) startActive();
    } else {
      S.moveTime += dt; S.active += dt;
      if (!restAudio.paused && Date.now() >= relaxUntil) restAudio.pause(); // 训练中休息音乐必须是暂停的
      if (HOLD && S.good) { S.holdAcc = (S.holdAcc || 0) + dt; if (S.holdAcc >= 1) { S.holdAcc -= 1; S.rep++; if (DATA.reps - S.rep <= 3 && S.rep < DATA.reps) beep(880, 0.08); if (S.rep >= DATA.reps) completeMove(); } }
      const pl = S.plan[S.g]; if (pl && S.imgs[S.g] === undefined && S.m === pl.m && S.moveTime >= pl.at) capture(S.g);
      const s = seg(); if (bgm.currentTime > s.end - 0.5 || bgm.currentTime < s.start) mSeek(s.start + 1); // 循环当前动作的音乐/示范片段
    }
    renderHud();
  }
  if (S.phase === 'rest' || S.phase === 'active') syncMusicBar();
  requestAnimationFrame(loop);
}

// ---------- 事件 ----------
$('mirror').onchange = e => { cam.classList.toggle('mirror', e.target.checked); overlay.classList.toggle('mirror', e.target.checked); };
$('sound').onchange = e => { bgm.muted = !e.target.checked; };
$('debug').onchange = e => { $('dbgBox').style.display = e.target.checked ? 'block' : 'none'; };
$('btnEnd').onclick = () => { if ((S.phase === 'active' || S.phase === 'rest') && confirm('确定结束本次训练吗?')) endWorkout(); };
$('btnSkip').onclick = () => { if (S.phase === 'active' || S.phase === 'rest') completeMove(); };
$('btnPause').onclick = () => {
  S.paused = !S.paused; $('btnPause').textContent = S.paused ? '继续' : '暂停'; syncFS();
  if (S.paused) mPause(); else if (S.phase === 'active') mPlay(); else if (S.phase === 'rest' && S.groupBreak) playRestMusic();
  setMsg(S.paused ? '已暂停' : '继续');
};
addEventListener('keydown', e => { if (e.key === 'n') $('btnSkip').click(); if (e.key === ' ') { e.preventDefault(); $('btnPause').click(); } });

$('btnStart').onclick = async () => {
  if (!USER) { showLogin(false); return; }
  enterFS(); lock(true);
  try { actx ??= new AudioContext(); actx.resume(); } catch {}
  bgm.muted = true; { const up = bgm.play(); if (up) up.then(() => { bgm.pause(); bgm.muted = !$('sound').checked; }).catch(() => {}); } // 解锁音乐(iOS)
  stopRelax();
  restAudio.muted = true; if (restAudio.getAttribute('src')) { const ru = restAudio.play(); if (ru) ru.then(() => { restAudio.pause(); restAudio.currentTime = 0; }).catch(() => {}); } // 解锁休息音乐(iOS)
  $('btnStart').disabled = true; setMsg('正在加载模型与摄像头…');
  try {
    try { actx ??= new AudioContext(); await actx.resume(); beep(1, 0.01, 0.001); } catch {} // 在点击手势内解锁提示音(iOS)
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前地址不是安全连接,浏览器禁用了摄像头。请用 https://' + location.hostname + ':8443 打开(或在本机用 localhost)');
    const fileset = await FilesetResolver.forVisionTasks('./lib/package/wasm');
    const mk = delegate => PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: './lib/pose_landmarker_full.task', delegate }, runningMode: 'VIDEO', numPoses: 1 });
    try { landmarker = await mk('GPU'); } catch { landmarker = await mk('CPU'); }
    cam.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' }, audio: false });
    await cam.play();
    await ref.play().then(() => ref.pause()).catch(() => {});
    $('btnPause').disabled = $('btnSkip').disabled = $('btnEnd').disabled = false;
    stage.classList.add('live'); document.body.classList.add('training'); syncFS();
    S.g = 0; S.m = 0; startRest();
  } catch (err) { exitFS(); lock(false); setMsg('启动失败:' + err.message + '(请用 http://localhost:8080 打开并允许摄像头)', 'bad'); $('btnStart').disabled = false; console.error(err); }
};

// ---------- 用户(只凭用户名区分,无密码) ----------
let USER = ''; try { USER = localStorage.getItem('user') || ''; } catch {}
const USER_RE = /^[\w.\-\u4e00-\u9fa5]{1,20}$/;
const _unusedUserIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;margin-right:6px"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></svg>';
const showUser = () => { $('btnUser').innerHTML = USER ? `<span class="av">${esc([...USER][0].toUpperCase())}</span><span class="nm">${esc(USER)}</span>` : '<span class="av">?</span><span class="nm">登录</span>';  loadToday(); };
const lock = on => { $('wsel').disabled = on; $('btnUser').disabled = on; };
async function showLogin(canCancel) {
  let users = []; try { users = await (await fetch('api/users')).json(); } catch {}
  openModal(`<h2>👤 ${USER ? '切换用户' : '登录'}</h2><div class="sub">输入用户名即可,无需密码。训练记录按用户名分开保存。</div>
    <input type="text" id="uName" maxlength="20" placeholder="用户名(字母/数字/汉字)" autocomplete="off" autocapitalize="off" value="${esc(USER)}">
    ${users.length ? `<div class="sub" style="margin-top:12px">已有用户,点一下直接进入</div><div class="ulist">${users.map(u => `<button data-u="${esc(u.name)}">${esc(u.name)}</button>`).join('')}</div>` : ''}
    <div class="btns"><button id="uGo" class="pri">进入</button>${canCancel ? '<button id="uCancel">取消</button>' : ''}</div><div id="note" class="note"></div>`, false);
  const go = name => {
    name = (name ?? $('uName').value).trim();
    if (!USER_RE.test(name)) { setNote('用户名只能包含字母、数字、汉字、_ . -,长度 1~20', 'bad'); return; }
    USER = (users.find(u => u.name.toLowerCase() === name.toLowerCase()) || { name }).name;
    try { localStorage.setItem('user', USER); } catch {}
    showUser(); closeModal();
  };
  $('uGo').onclick = () => go();
  $('uName').onkeydown = e => { if (e.key === 'Enter') go(); };
  mbox.querySelectorAll('[data-u]').forEach(b => b.onclick = () => go(b.dataset.u));
  if ($('uCancel')) $('uCancel').onclick = closeModal;
  if (!USER) setTimeout(() => $('uName').focus(), 50);
}
$('btnUser').onclick = () => showLogin(!!USER);
// 识别灵敏度:分段控件 <-> 隐藏的 select(识别代码读取 select 的值)
const sensSeg = $('sensSeg');
const syncSens = () => sensSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === $('sens').value));
sensSeg.addEventListener('click', e => { const v = e.target.closest('button')?.dataset.v; if (!v) return; $('sens').value = v; syncSens(); try { localStorage.setItem('sens', v); } catch {} });
try { const v = localStorage.getItem('sens'); if (v && [...$('sens').options].some(o => o.value === v)) $('sens').value = v; } catch {}
syncSens();
showUser();

// ---------- 休息音乐(用户上传 / 导入) ----------
let tracks = [], playlists = [], lastTrackId = null;
const blobCache = new Map();
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4' };
const chosen = () => { try { return localStorage.getItem('restMusic') || 'all'; } catch { return 'all'; } };
const mb = n => (n / 1048576).toFixed(1) + 'MB';
async function trackURL(t) { // 用 fetch 下载成 blob 再播放(兼容 iPhone 自签名 HTTPS)
  if (!blobCache.has(t.id)) {
    const r = await fetch(t.url); if (!r.ok) throw new Error('HTTP ' + r.status);
    blobCache.set(t.id, URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: MIME[t.ext] || 'audio/mpeg' })));
  }
  return blobCache.get(t.id);
}
function pickTrack(forceAll) {
  if (!tracks.length) return null;
  const c = chosen();
  if (c.startsWith('playlist:')) {
    const p = playlists.find(x => String(x.id) === c.slice(9));
    const ids = (p?.trackIds || []).filter(id => tracks.some(t => t.id === id));
    if (!ids.length) return null;
    const index = ids.indexOf(lastTrackId);
    return tracks.find(t => t.id === ids[(index + 1) % ids.length]);
  }
  if (!forceAll && c !== 'all') { const t = tracks.find(x => String(x.id) === c); if (t) return t; }
  const pool = tracks.length > 1 ? tracks.filter(x => x.id !== lastTrackId) : tracks;
  return pool[Math.floor(Math.random() * pool.length)];
}
async function prepareRest(forceAll = false) {
  if (restAudio.dataset.prev) return; // 音乐页正在试听,不打断
  const t = pickTrack(forceAll);
  if (!t) { restAudio.removeAttribute('src'); restAudio.load(); return; }
  try { restAudio.src = await trackURL(t); lastTrackId = t.id; restAudio.loop = !forceAll && chosen() !== 'all' && !chosen().startsWith('playlist:'); } catch (e) { console.warn('休息音乐加载失败', e); }
}
async function loadTracks() {
  const [r, pr] = await Promise.all([fetch('api/music'), fetch('api/playlists')]);
  const j = await r.json(), pj = await pr.json();
  tracks = Array.isArray(j) ? j : [];
  playlists = Array.isArray(pj) ? pj : [];
  await prepareRest();
}
// 休息结束时暂停并记住进度,下次休息从断点继续(同一首歌),而不是重新开始
let restPos = { src: '', t: 0 };
restAudio.addEventListener('pause', () => { if (!restAudio.ended && restAudio.currentTime > 0.5) restPos = { src: restAudio.src, t: restAudio.currentTime }; });
// 休息音乐进度条:训练中常驻在画面顶部,▶(绿)=正在播放,⏸=已暂停,一眼看出是否暂停
const mbar = $('musicBar'), mm = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
function syncMusicBar() {
  const has = !!restAudio.getAttribute('src') && restAudio.readyState > 0;
  mbar.classList.toggle('has', has); document.body.classList.toggle('musicOn', has); if (!has) return;
  const playing = !restAudio.paused, d = restAudio.duration, known = isFinite(d) && d > 0;
  mbar.classList.toggle('playing', playing); mbar.classList.toggle('indet', !known && playing);
  $('mbIcon').textContent = playing ? '♪' : '⏸';
  const t = tracks.find(x => x.id === lastTrackId); $('mbTitle').textContent = t ? t.title : '';
  $('mbFill').style.width = known ? (restAudio.currentTime / d * 100) + '%' : '0';
  $('mbTime').textContent = mm(restAudio.currentTime) + (known ? ' / ' + mm(d) : '');
}
['timeupdate', 'play', 'pause', 'loadedmetadata', 'emptied'].forEach(ev => restAudio.addEventListener(ev, syncMusicBar));
function playRestMusic() {
  if (!tracks.length) { $('bigS').textContent += '(还没有休息音乐,训练结束后可在页头「休息音乐」里添加)'; return; }
  restAudio.muted = false;
  if (restPos.src === restAudio.src && restAudio.currentTime < restPos.t - 1) { try { restAudio.currentTime = restPos.t; } catch {} }
  restAudio.play().catch(() => setMsg('休息音乐被浏览器拦截,点一下"音乐"按钮开启', 'bad'));
}
restAudio.addEventListener('ended', async () => { if (restAudio.dataset.prev) return; await prepareRest(); if (S.phase === 'rest' && S.groupBreak && !S.paused) playRestMusic(); else if (Date.now() < relaxUntil) restAudio.play().catch(() => {}); });
$('bSkipRest').onclick = () => { if (S.phase === 'rest') S.restLeft = 0; };
$('bPauseMusic').onclick = () => { if (restAudio.paused) playRestMusic(); else restAudio.pause(); $('bPauseMusic').textContent = restAudio.paused ? '▶ 音乐' : '⏸ 音乐'; };
$('bNextTrack').onclick = async () => { await prepareRest(true); playRestMusic(); $('bPauseMusic').textContent = '⏸ 音乐'; };

const IC = {
  up: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  x: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  clip: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 11h6M9 15h4"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M5 5l10 7-10 7z"/><path d="M19 5v14"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
};
const KIND = { netease: ['网易云', '#e5484d'], douyin: ['抖音', '#ff3b7f'], upload: ['上传', '#3390ec'], link: ['链接', '#7d8ea3'] };
const GRADS = [['#3390ec', '#7b5cff'], ['#ff6b6b', '#ffa94d'], ['#20c997', '#3390ec'], ['#845ef7', '#e64980'], ['#fab005', '#fd7e14'], ['#15aabf', '#4c6ef5']];
const grad = name => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0; const g = GRADS[h % GRADS.length]; return `linear-gradient(135deg,${g[0]},${g[1]})`; };
const dur = s => s ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : '--:--';
const totalDur = arr => { const t = arr.reduce((a, x) => a + (x.duration || 0), 0); return t ? (t >= 3600 ? (t / 3600).toFixed(1) + ' 小时' : Math.round(t / 60) + ' 分钟') : ''; };
const plTracks = p => (p?.trackIds || []).map(id => tracks.find(t => t.id === id)).filter(Boolean);
const setChosen = v => { lastTrackId = null; try { localStorage.setItem('restMusic', v); } catch {} prepareRest(); };
function toast(msg, ms = 2800) {
  const t = $('toast'); t.textContent = msg; t.hidden = false; t.classList.remove('out');
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.classList.add('out'); setTimeout(() => { t.hidden = true; }, 250); }, ms);
}
const mNote = (t, cls = '') => { const e = $('mNote'); e.textContent = t; e.className = 'note ' + cls; };

// ---------- 音乐页状态 ----------
const MV = { pl: null, edit: false, q: '', sel: new Set() };
const PV = { ctx: [] };   // 试听的上下文(用于"下一首")
const previewId = () => restAudio.dataset.prev ? +restAudio.dataset.prev : null;

async function openMusic() {
  try { await loadTracks(); } catch {}
  if (MV.pl && !playlists.some(p => p.id === MV.pl)) MV.pl = null;
  renderMusic();
  checkClipboard(false);
}
function songRow(t, opt = {}) {
  const k = KIND[t.kind] || KIND.link, on = previewId() === t.id;
  const lead = MV.edit ? `<input type="checkbox" class="ck" data-ck="${t.id}" ${MV.sel.has(t.id) ? 'checked' : ''} aria-label="选择">`
    : opt.radio ? `<input type="radio" name="one" data-one="${t.id}" ${opt.radio === t.id ? 'checked' : ''} aria-label="设为单曲循环">`
    : `<span class="sno">${on ? '<span class="eq' + (restAudio.paused ? ' paused' : '') + '"><i></i><i></i><i></i></span>' : (opt.idx ?? '')}</span>`;
  return `<div class="srow${on ? ' on' : ''}" data-id="${t.id}">
    <div class="sdel"><button data-sdel="${t.id}">删除</button></div>
    <div class="sfront">${lead}<span class="lt">${esc(t.title)}<small><b class="kb" style="background:${k[1]}">${k[0]}</b>${mb(t.size)}</small></span><span class="trail">${dur(t.duration)}</span></div></div>`;
}
function renderMusic() {
  const host = $('pgMusic');
  $('btnEditMusic').hidden = !tracks.length || !!MV.pl;
  $('btnEditMusic').textContent = MV.edit ? '完成' : '编辑';
  if (MV.pl) return renderPlaylist(host, playlists.find(p => p.id === MV.pl));
  const c = chosen(), mode = c === 'all' ? 'all' : c.startsWith('playlist:') ? 'pl' : 'one';
  const curPl = mode === 'pl' ? playlists.find(p => 'playlist:' + p.id === c) : null;
  const curT = mode === 'one' ? tracks.find(t => String(t.id) === c) : null;
  let nowTitle = '随机播放', nowSub = `${tracks.length} 首${totalDur(tracks) ? ' · ' + totalDur(tracks) : ''}`, nowCover = `<span class="nc-ic">${IC.shuffle}</span>`, nowBg = 'linear-gradient(135deg,#3390ec,#20c997)';
  if (curPl) { const a = plTracks(curPl); nowTitle = curPl.name; nowSub = `歌单 · ${a.length} 首${totalDur(a) ? ' · ' + totalDur(a) : ''} · 顺序播放`; nowCover = esc([...curPl.name][0] || '♪'); nowBg = grad(curPl.name); }
  if (curT) { nowTitle = curT.title; nowSub = `单曲循环 · ${dur(curT.duration)}`; nowCover = `<span class="nc-ic">${IC.note}</span>`; nowBg = grad(curT.title); }
  if (!tracks.length) {
    host.innerHTML = `<div id="clipBanner" class="clip" hidden></div>
      <div class="empty"><div class="empty-ic">${IC.note}</div><b>还没有休息音乐</b><span>上传文件,或粘贴抖音 / 网易云歌单链接</span><button class="pri" id="emptyAdd">添加音乐</button></div>`;
    $('emptyAdd').onclick = openAdd; return;
  }
  const q = MV.q.trim().toLowerCase(), list = q ? tracks.filter(t => t.title.toLowerCase().includes(q)) : tracks;
  host.innerHTML = `<div id="clipBanner" class="clip" hidden></div>
    <div class="nowCard glass">
      <div class="nc-cover" style="background:${nowBg}">${nowCover}</div>
      <div class="lt"><span class="nc-k">休息时播放</span>${esc(nowTitle)}<small>${nowSub}</small></div>
      <button class="nc-play" id="nowPlay" aria-label="试听">${IC.play}</button>
    </div>
    <div class="seg modeSeg" id="modeSeg">
      <button data-mode="all" class="${mode === 'all' ? 'on' : ''}">随机</button>
      <button data-mode="pl" class="${mode === 'pl' ? 'on' : ''}" ${playlists.length ? '' : 'disabled'}>歌单</button>
      <button data-mode="one" class="${mode === 'one' ? 'on' : ''}">单曲</button>
    </div>
    ${playlists.length ? `<div class="sect">歌单 · ${playlists.length}</div>
    <div class="plrow">${playlists.map(p => { const a = plTracks(p); return `<button class="plcard" data-pl="${p.id}">
      <span class="plcover" style="background:${grad(p.name)}">${esc([...p.name][0] || '♪')}${curPl?.id === p.id ? `<i class="chk">${IC.check}</i>` : ''}</span>
      <span class="t">${esc(p.name)}</span><span class="s">${a.length} 首${totalDur(a) ? ' · ' + totalDur(a) : ''}</span></button>`; }).join('')}</div>` : ''}
    <div class="sect">全部歌曲 · ${tracks.length}${mode === 'one' && !MV.edit ? '<span class="sect-r">选中 = 单曲循环</span>' : ''}</div>
    ${tracks.length > 10 ? `<label class="search">${IC.search}<input id="mSearch" type="text" placeholder="搜索歌曲" value="${esc(MV.q)}" autocomplete="off"></label>` : ''}
    ${MV.edit ? `<div class="editbar"><span>已选 ${MV.sel.size} 首</span><button id="selAll">${MV.sel.size === list.length ? '全不选' : '全选'}</button><button class="danger" id="delSel" ${MV.sel.size ? '' : 'disabled'}>删除所选</button><button class="danger" id="delAll">全部删除</button></div>` : ''}
    <div class="list songs" id="songList">${list.map(t => songRow(t, { radio: mode === 'one' ? curT?.id ?? -1 : 0 })).join('') || '<div class="li"><span class="sub">没有匹配的歌曲</span></div>'}</div>
    ${MV.edit ? '' : '<div class="hint">点歌曲试听,向左滑动可删除。</div>'}`;
  $('nowPlay').onclick = () => { const ctx = curPl ? plTracks(curPl) : curT ? [curT] : [...tracks].sort(() => Math.random() - 0.5); if (ctx.length) previewTrack(ctx[0].id, ctx.map(t => t.id)); };
  host.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
    const m = b.dataset.mode;
    if (m === 'all') setChosen('all');
    else if (m === 'pl') { if (!curPl && playlists[0]) setChosen('playlist:' + playlists[0].id); }
    else if (!curT && tracks[0]) setChosen(String(tracks[0].id));
    renderMusic();
  });
  host.querySelectorAll('[data-pl]').forEach(b => b.onclick = () => { MV.pl = +b.dataset.pl; MV.edit = false; renderMusic(); scrollTo(0, 0); });
  if ($('mSearch')) $('mSearch').oninput = e => { MV.q = e.target.value; const pos = e.target.selectionStart; renderMusic(); const s = $('mSearch'); s.focus(); try { s.setSelectionRange(pos, pos); } catch {} };
  if (MV.edit) {
    $('selAll').onclick = () => { if (MV.sel.size === list.length) MV.sel.clear(); else list.forEach(t => MV.sel.add(t.id)); renderMusic(); };
    $('delSel').onclick = async () => {
      if (!confirm(`删除所选的 ${MV.sel.size} 首歌曲?无法恢复。`)) return;
      for (const id of MV.sel) await deleteTrack(id, true);
      MV.sel.clear(); MV.edit = false; await openMusic(); toast('已删除');
    };
    $('delAll').onclick = async () => {
      if (!confirm(`确定删除全部 ${tracks.length} 首休息音乐和所有歌单吗?无法恢复。`)) return;
      stopPreview(); const r = await fetch('api/music', { method: 'DELETE' }); if (!r.ok) return toast('删除失败');
      blobCache.forEach(u => URL.revokeObjectURL(u)); blobCache.clear(); setChosen('all'); MV.edit = false; MV.sel.clear(); await openMusic(); toast('已全部删除');
    };
  }
  bindSongList(host, list.map(t => t.id));
}
function renderPlaylist(host, p) {
  const a = plTracks(p), using = chosen() === 'playlist:' + p.id;
  host.innerHTML = `<button class="backbtn" id="plBack">${IC.back}音乐</button>
    <div class="pldHead"><div class="plcover big" style="background:${grad(p.name)}">${esc([...p.name][0] || '♪')}</div>
      <div class="lt"><b>${esc(p.name)}</b><small>${a.length} 首${totalDur(a) ? ' · ' + totalDur(a) : ''}</small></div></div>
    <div class="pldActs"><button class="pri" id="plPlay">${IC.play}试听</button><button id="plUse" ${using ? 'disabled' : ''}>${using ? '正在使用' : '设为休息音乐'}</button><button class="danger" id="plDel">删除歌单</button></div>
    <div class="list songs" id="songList">${a.map((t, i) => songRow(t, { idx: i + 1 })).join('') || '<div class="li"><span class="sub">歌单中暂无歌曲</span></div>'}</div>
    <div class="hint">删除歌单会一并删除其中的歌曲(被其他歌单使用的除外)。</div>`;
  $('plBack').onclick = () => { MV.pl = null; renderMusic(); };
  $('plPlay').onclick = () => { if (a.length) previewTrack(a[0].id, a.map(t => t.id)); };
  $('plUse').onclick = () => { setChosen('playlist:' + p.id); toast('已设为休息音乐'); renderMusic(); };
  $('plDel').onclick = async () => {
    if (!confirm('删除歌单?歌单里的歌曲也会一并删除(被其他歌单使用的除外),无法恢复。')) return;
    stopPreview(); const r = await fetch('api/playlists/' + p.id, { method: 'DELETE' }); if (!r.ok) return toast('删除歌单失败');
    if (chosen() === 'playlist:' + p.id) setChosen('all');
    MV.pl = null; await openMusic(); toast('歌单已删除');
  };
  bindSongList(host, a.map(t => t.id));
}
async function deleteTrack(id, silent) {
  if (previewId() === id) stopPreview();
  const r = await fetch('api/music/' + id, { method: 'DELETE' });
  const old = blobCache.get(id); if (old) { URL.revokeObjectURL(old); blobCache.delete(id); }
  if (chosen() === String(id)) setChosen('all');
  if (!silent) { if (!r.ok) toast('删除失败'); else { await openMusic(); toast('已删除'); } }
}
function bindSongList(host, ctx) {
  host.querySelectorAll('.srow').forEach(row => {
    const id = +row.dataset.id, f = row.querySelector('.sfront');
    let x0 = null, y0 = 0, dx = 0, drag = false;
    f.addEventListener('pointerdown', e => { if (MV.edit || e.target.matches('input')) return; x0 = e.clientX; y0 = e.clientY; dx = 0; drag = false; });
    f.addEventListener('pointermove', e => {
      if (x0 == null) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!drag) { if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my)) { drag = true; row.classList.add('drag'); f.style.transition = 'none'; try { f.setPointerCapture(e.pointerId); } catch {} } else if (Math.abs(my) > 10) { x0 = null; return; } }
      if (drag) { dx = Math.max(-110, Math.min(0, (row.classList.contains('open') ? -88 : 0) + mx)); f.style.transform = `translateX(${dx}px)`; }
    });
    const end = () => { if (x0 == null) return; x0 = null; if (!drag) return; setTimeout(() => row.classList.remove('drag'), 260); f.style.transition = ''; f.style.transform = ''; row.classList.toggle('open', dx < -44); row._sw = Date.now(); };
    f.addEventListener('pointerup', end); f.addEventListener('pointercancel', end);
    f.addEventListener('click', e => {
      if (Date.now() - (row._sw || 0) < 300) return;
      if (row.classList.contains('open')) { row.classList.remove('open'); return; }
      const ck = e.target.closest('[data-ck]'), one = e.target.closest('[data-one]');
      if (ck) { ck.checked ? MV.sel.add(id) : MV.sel.delete(id); const s = $('pgMusic').querySelector('.editbar span'); if (s) s.textContent = `已选 ${MV.sel.size} 首`; const d = $('delSel'); if (d) d.disabled = !MV.sel.size; return; }
      if (one) { setChosen(String(id)); renderMusic(); return; }
      if (MV.edit) { f.querySelector('[data-ck]').click(); return; }
      host.querySelectorAll('.srow.open').forEach(r => r.classList.remove('open'));
      previewTrack(id, ctx);
    });
    row.querySelector('[data-sdel]').onclick = async () => { const t = tracks.find(x => x.id === id); if (confirm(`删除「${t?.title || ''}」?`)) await deleteTrack(id); };
  });
}

// ---------- 试听 + 迷你播放条 ----------
async function previewTrack(id, ctx) {
  const t = tracks.find(x => x.id === id); if (!t) return;
  if (previewId() === id) { if (restAudio.paused) restAudio.play().catch(() => {}); else restAudio.pause(); return; }
  PV.ctx = ctx || [id];
  try { restAudio.src = await trackURL(t); restAudio.loop = false; restAudio.dataset.prev = id; restAudio.muted = false; await restAudio.play(); }
  catch (err) { toast('无法播放:' + err.message); }
  syncMini(); markPlaying();
}
function stopPreview() { if (!restAudio.dataset.prev) return; restAudio.pause(); delete restAudio.dataset.prev; syncMini(); markPlaying(); prepareRest(); }
function nextPreview() { const i = PV.ctx.indexOf(previewId()); const n = PV.ctx[(i + 1) % PV.ctx.length]; if (n != null) { delete restAudio.dataset.prev; previewTrack(n, PV.ctx); } }
function markPlaying() {
  document.querySelectorAll('#pgMusic .srow').forEach(r => {
    const on = +r.dataset.id === previewId(); r.classList.toggle('on', on);
    const sno = r.querySelector('.sno'); if (sno) sno.innerHTML = on ? `<span class="eq${restAudio.paused ? ' paused' : ''}"><i></i><i></i><i></i></span>` : '';
  });
}
function syncMini() {
  const id = previewId(), t = id != null && tracks.find(x => x.id === id), m = $('mini');
  m.hidden = !(t && TAB === 'music');
  if (m.hidden) return;
  $('miniCover').style.background = grad(t.title); $('miniTitle').textContent = t.title;
  $('miniPlay').innerHTML = restAudio.paused ? IC.play : IC.pause; $('miniPlay').setAttribute('aria-label', restAudio.paused ? '播放' : '暂停');
  const d = restAudio.duration; $('miniFill').style.width = (isFinite(d) && d > 0 ? restAudio.currentTime / d * 100 : 0) + '%';
  $('miniTime').textContent = dur(restAudio.currentTime || 0.001).replace('--:--', '0:00') + ' / ' + dur(isFinite(d) ? d : t.duration);
}
['timeupdate', 'play', 'pause', 'loadedmetadata'].forEach(ev => restAudio.addEventListener(ev, () => { if (restAudio.dataset.prev) { syncMini(); if (ev !== 'timeupdate') markPlaying(); } }));
restAudio.addEventListener('ended', () => { if (restAudio.dataset.prev) nextPreview(); });
$('miniPlay').onclick = () => { if (restAudio.paused) restAudio.play().catch(() => {}); else restAudio.pause(); };
$('miniNext').onclick = nextPreview;
$('miniClose').onclick = stopPreview;
$('miniNext').innerHTML = IC.next; $('miniClose').innerHTML = IC.close;

// ---------- 添加音乐面板 ----------
const addSheet = $('addSheet');
function openAdd() { mNote(''); addSheet.hidden = false; }
$('btnAddMusic').onclick = openAdd;
$('addDone').onclick = () => { addSheet.hidden = true; };
addSheet.addEventListener('click', e => { if (e.target === addSheet) addSheet.hidden = true; });
$('btnEditMusic').onclick = () => { MV.edit = !MV.edit; MV.sel.clear(); if (MV.edit) stopPreview(); renderMusic(); };
$('mUpload').innerHTML = `<span class="ico">${IC.up}</span><span class="lt">上传音频 / 视频文件<small>mp3 · m4a · wav · mp4(只取声音)</small></span>`;
$('mLinkIc').innerHTML = IC.link; $('mClear').innerHTML = IC.x;
const lk = $('mLink'), syncClr = () => { $('mClear').hidden = !lk.value; };
lk.oninput = syncClr;
$('mClear').onclick = () => { lk.value = ''; syncClr(); mNote(''); lk.focus(); };
$('mPaste').onclick = () => checkClipboard(true);
$('mUpload').onclick = () => $('mFile').click();
$('mFile').onchange = async e => {
  const files = [...e.target.files]; if (!files.length) return;
  let ok = 0;
  for (const [i, f] of files.entries()) {
    mNote(`上传中 ${i + 1}/${files.length}:${f.name}(${mb(f.size)})`);
    try {
      const r = await fetch('api/music?name=' + encodeURIComponent(f.name), { method: 'PUT', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      ok++;
    } catch (err) { mNote(`「${f.name}」上传失败:${err.message}`, 'bad'); }
  }
  e.target.value = '';
  if (ok) { addSheet.hidden = true; await openMusic(); toast(`已上传 ${ok} 首`); }
};
async function importLink(kind) {
  const url = lk.value.trim(); if (!url) return mNote(kind === 'playlist' ? '请先粘贴网易云歌单链接' : '请先粘贴链接', 'bad');
  dismissedClip = url;
  $('mImport').disabled = $('mPlaylist').disabled = true;
  mNote(kind === 'playlist' ? '正在导入歌单,歌曲较多时可能需要几分钟…' : '正在下载…');
  try {
    const r = await fetch(kind === 'playlist' ? 'api/music/playlist' : 'api/music/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    lk.value = ''; syncClr(); addSheet.hidden = true; await openMusic();
    toast(kind === 'playlist' ? `歌单「${j.name}」:导入 ${j.imported} 首,已存在 ${j.skipped} 首` + (j.vip ? `,VIP/无版权 ${j.vip} 首` : '') + (j.failed ? `,失败 ${j.failed} 首` : '') : `已导入「${j.title || '新歌曲'}」`, 4500);
  } catch (err) { mNote(err.message, 'bad'); }
  $('mImport').disabled = $('mPlaylist').disabled = false;
}
$('mImport').onclick = () => importLink(/163cn\.tv|music\.163\.com/.test(lk.value) && /playlist|163cn/.test(lk.value) ? 'playlist' : 'link');
$('mPlaylist').onclick = () => importLink('playlist');

// ---------- 剪贴板:自动识别链接,一键导入 ----------
let dismissedClip = '';
function classifyClip(t) {
  const m = (t || '').match(/https?:\/\/[^\s　"'<>]+/); if (!m) return null;
  let u; try { u = new URL(m[0].replace(/[.,;)\]}，。]+$/, '')); } catch { return null; }
  const h = u.hostname;
  if (/(^|\.)(163cn\.tv|music\.163\.com)$/.test(h)) return { kind: 'playlist', label: '网易云歌单' };
  if (/(^|\.)(douyin|iesdouyin|tiktok)\.com$/.test(h)) return { kind: 'link', label: '抖音链接' };
  if (/\.(mp3|m4a|aac|wav|ogg|flac|mp4)$/i.test(u.pathname)) return { kind: 'link', label: '音频链接' };
  return null;
}
function showClipBanner(text, c) {
  const box = $('clipBanner'); if (!box) return;
  const brief = (text.match(/https?:\/\/\S+/) || [text])[0];
  box.innerHTML = `<span class="ico">${IC.clip}</span><span class="lt">检测到剪贴板里的${c.label}<small>${esc(brief)}</small></span><button id="cbGo" class="pri">${c.kind === 'playlist' ? '导入歌单' : '导入'}</button><button id="cbNo" class="ib" aria-label="忽略">${IC.close}</button>`;
  box.hidden = false;
  $('cbNo').onclick = () => { dismissedClip = text; box.hidden = true; };
  $('cbGo').onclick = () => { dismissedClip = text; box.hidden = true; lk.value = text.trim(); syncClr(); openAdd(); importLink(c.kind); };
}
async function checkClipboard(manual) {
  if (!manual && TAB !== 'music') return;
  let t = '';
  try { t = (await navigator.clipboard.readText()) || ''; }
  catch { if (manual) mNote('浏览器不允许读取剪贴板:请长按输入框粘贴', 'bad'); return; }
  if (!t.trim()) { if (manual) mNote('剪贴板是空的', 'bad'); return; }
  const c = classifyClip(t);
  if (manual) { lk.value = t.trim(); syncClr(); mNote(c ? `已识别为${c.label}` : '已粘贴,但没识别出支持的链接类型', c ? 'ok' : 'bad'); return; }
  if (c && t.trim() !== dismissedClip.trim()) showClipBanner(t, c);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkClipboard(false); });
addEventListener('focus', () => checkClipboard(false));

// ---------- 底部 Tab:训练 / 项目 / 音乐 / 记录 ----------
const TABS = { train: ['pgTrain', '训练'], work: ['pgWork', '项目'], music: ['pgMusic', '音乐'], hist: ['pgHist', '记录'] };
let TAB = 'train';
function renderWorkouts() {
  const box = $('workList');
  if (!WLIST.length) { box.innerHTML = '<div class="sub">没有找到运动项目(workouts 目录)</div>'; return; }
  box.innerHTML = WLIST.map(w => `<article class="glass wcard ${w.id === WID ? 'cur' : ''}">
    ${w.cover ? `<img class="wcover" src="workouts/${encodeURIComponent(w.id)}/${encodeURIComponent(w.cover)}" alt="" loading="lazy">` : ''}<div class="wbody">
    <h3>${esc(w.name)}${w.id === WID ? '<span class="badge">当前</span>' : ''}</h3>
    <p>${esc(w.desc || '')}</p>
    <div class="tags"><span>${w.groups} 组</span><span>每组 ${w.movesPerGroup} 个动作</span><span>每个 ${w.reps} ${esc(w.unit || '次')}</span></div>
    ${w.id === WID ? '' : `<button class="pri" data-pick="${esc(w.id)}">切换到此项目</button>`}</div></article>`).join('');
  box.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    try { localStorage.setItem('workout', b.dataset.pick); } catch {}
    location.href = location.pathname + '?w=' + encodeURIComponent(b.dataset.pick) + '#train';
  });
}
function switchTab(t) {
  if (!TABS[t]) t = 'train';
  if (S.phase === 'active' || S.phase === 'rest') return; // 训练中不切换
  if (TAB === 'music' && t !== 'music') { stopPreview(); MV.edit = false; MV.sel.clear(); } // 离开音乐页:停掉试听
  TAB = t; document.body.dataset.tab = t;
  $('tabbar').style.setProperty('--i', Object.keys(TABS).indexOf(t));
  for (const [k, [id, title]] of Object.entries(TABS)) {
    $(id).hidden = k !== t;
    if (k === t) { $('pageTitle').textContent = title; document.title = title + ' · 跟练打卡'; }
  }
  document.querySelectorAll('.tab').forEach(b => { if (b.dataset.tab === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  try { history.replaceState(null, '', location.pathname + location.search + '#' + t); } catch {}
  scrollTo(0, 0);
  if (t !== 'music') $('mini').hidden = true;
  if (t === 'music') { MV.pl = null; openMusic(); } else if (t === 'hist') openHistory(); else if (t === 'work') renderWorkouts();
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
addEventListener('hashchange', () => { const h = location.hash.slice(1); if (TABS[h] && h !== TAB) switchTab(h); });
$('btnChangeWork').onclick = () => switchTab('work');
const setSheet = $('setSheet');
$('btnSet').onclick = () => { setSheet.hidden = false; };
$('setDone').onclick = () => { setSheet.hidden = true; };
setSheet.addEventListener('click', e => { if (e.target === setSheet) setSheet.hidden = true; });
// 在 iOS App 里运行时:设置面板多一项"切换服务器地址"
if (window.webkit?.messageHandlers?.app) {
  const row = document.createElement('button'); row.className = 'prow'; row.style.cssText = 'width:100%;background:none;border-radius:0;padding:13px 0';
  row.innerHTML = '<span>服务器地址</span><span style="color:var(--ac);font-size:14px">修改 ›</span>';
  row.onclick = () => { setSheet.hidden = true; window.webkit.messageHandlers.app.postMessage('server'); };
  setSheet.querySelector('.prefs').appendChild(row);
}

init().then(() => { const h = location.hash.slice(1); if (TABS[h] && h !== 'train') switchTab(h); });
if (!USER) showLogin(false);
requestAnimationFrame(loop);
