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
  if (!tracks.length && !isNcmRest()) return false;
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
  stopPreview();
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
const showUser = () => {
  const me = self.ncmMe, b = $('btnUser');
  b.innerHTML = (me?.avatar ? `<img class="av" src="${String(me.avatar).replace(/^http:/, 'https:')}?param=80y80" alt="">` : `<span class="av">${USER ? esc([...USER][0].toUpperCase()) : '?'}</span>`)
    + (me?.vip ? '<i class="vb" aria-label="黑胶 VIP">V</i>' : '') + `<span class="nm">${USER ? esc(USER) : '登录'}</span>`;
  b.title = (USER ? '训练账户:' + USER : '登录') + (me ? ' · 网易云:' + me.name : '');
  loadToday();
};
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
$('btnUser').onclick = () => USER ? openNcmLogin() : showLogin(false);
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
// 网易云歌单作为休息音乐:chosen = 'ncm:<歌单id>',每次休息按歌单顺序取下一首,播放地址现取(约 20 分钟过期)
const NR = { pid: null, list: [], i: -1, cur: null };
const isNcmRest = () => chosen().startsWith('ncm:');
async function ncmRestList(pid) {
  if (NR.pid !== pid || !NR.list.length) {
    const j = await ncm('/playlist/track/all', { id: pid, limit: 1000 });
    NR.pid = pid; NR.list = (j.songs || []).map(itemNet); NR.i = +lsGet('restNcmIdx:' + pid, '-1');
  }
  return NR.list;
}
async function prepNcmRest(pid) {
  const list = await ncmRestList(pid);
  for (let n = 0; n < Math.min(8, list.length); n++) {   // 遇到无版权/试听片段就跳过,最多试 8 首
    NR.i = (NR.i + 1) % list.length; lsSet('restNcmIdx:' + pid, String(NR.i));
    const it = list[NR.i], d = (await ncm('/song/url/v1', { id: it.nid, level: 'exhigh' })).data?.[0];
    if (d?.url && !d.freeTrialInfo) {
      if (restAudio.dataset.prev) return;
      restAudio.src = https_(d.url); restAudio.loop = false; restAudio.dataset.ncm = it.nid; restAudio.dataset.urlAt = Date.now(); NR.cur = it; lastTrackId = null; return;
    }
  }
  throw new Error('歌单里没有可播放的歌曲');
}
async function freshNcmUrl(resume) {   // 播放地址过期时重新获取并回到原位置
  const nid = restAudio.dataset.ncm; if (!nid) return;
  const pos = restAudio.currentTime || restPos.t;
  const d = (await ncm('/song/url/v1', { id: nid, level: 'exhigh' })).data?.[0]; if (!d?.url) return;
  restAudio.src = https_(d.url); restAudio.dataset.urlAt = Date.now();
  await new Promise(r => { restAudio.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 4000); });
  try { restAudio.currentTime = pos; } catch {}
  restPos = { src: restAudio.src, t: pos };
  if (resume) restAudio.play().catch(() => {});
}
async function prepareRest(forceAll = false) {
  if (restAudio.dataset.prev) return; // 音乐页正在试听,不打断
  if (isNcmRest()) { try { await prepNcmRest(chosen().slice(4)); } catch (e) { console.warn('网易云休息音乐加载失败', e); } return; }
  delete restAudio.dataset.ncm;
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
restAudio.addEventListener('error', () => { if (!restAudio.dataset.prev && isNcmRest() && restAudio.dataset.ncm) freshNcmUrl(S.phase === 'rest' && S.groupBreak && !S.paused).catch(() => {}); });
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
  if (isNcmRest() && restAudio.dataset.ncm && Date.now() - (+restAudio.dataset.urlAt || 0) > 15 * 60e3) { freshNcmUrl(true); return; }
  if (!tracks.length && !isNcmRest()) { $('bigS').textContent += '(还没有休息音乐,训练结束后可在页头「休息音乐」里添加)'; return; }
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
const MV = { lib: 'pl', pl: null, edit: false, q: '', sel: new Set(), mode: null, view: '', sq: '', sr: [], me: undefined, myPl: [], npl: null, nplItems: {}, importing: {} };
const PV = { ctx: [] };   // 试听的上下文(用于"下一首")
const previewId = () => { const k = restAudio.dataset.prev || ''; return k.startsWith('l:') ? +k.slice(2) : null; };

async function openMusic() {
  try { await loadTracks(); } catch {}
  if (MV.pl && !playlists.some(p => p.id === MV.pl)) MV.pl = null;
  renderMusic();
  checkClipboard(false);
  const before = META.size; await ensureMeta(tracks.map(t => t.nid));          // 网易云歌曲补封面/歌手
  const me = await ncmStatus(); let changed = !!me !== !!MV.me || me?.vip !== MV.me?.vip; MV.me = me;
  const nb = MV.myPl.length; await loadMyPlaylists(); if (MV.myPl.length !== nb) changed = true;
  if (TAB === 'music' && !MV.view && (META.size !== before || changed)) renderMusic();
}
function bindMusicTop() {
  $('goSearch').onclick = () => { MV.view = 'search'; MV.edit = false; renderMusic(); scrollTo(0, 0); };
  document.querySelectorAll('#pgMusic [data-npl]').forEach(b => b.onclick = () => { MV.view = 'npl'; MV.npl = +b.dataset.npl; MV.edit = false; renderMusic(); scrollTo(0, 0); });
}
function songRow(t, opt = {}) {
  const it = itemLocal(t), k = KIND[t.kind] || KIND.link, on = restAudio.dataset.prev === it.key, eq = `<span class="eq${restAudio.paused ? ' paused' : ''}"><i></i><i></i><i></i></span>`;
  const lead = MV.edit ? `<input type="checkbox" class="ck" data-ck="${t.id}" ${MV.sel.has(t.id) ? 'checked' : ''} aria-label="选择">`
    : opt.radio ? `<input type="radio" name="one" data-one="${t.id}" ${opt.radio === t.id ? 'checked' : ''} aria-label="设为单曲循环">` : '';
  const pic = it.cover ? `<span class="thumb" style="background-image:url('${it.cover}')"><span class="thumbEq" ${on ? '' : 'hidden'}>${eq}</span></span>`
    : `<span class="sno" data-idx="${opt.idx ?? ''}">${on ? eq : (opt.idx ?? '')}</span>`;
  return `<div class="srow${on ? ' on' : ''}" data-id="${t.id}" data-key="${it.key}">
    <div class="sdel"><button data-sdel="${t.id}">删除</button></div>
    <div class="sfront">${lead}${pic}<span class="lt">${esc(t.title)}<small><b class="kb" style="background:${k[1]}">${k[0]}</b>${t.nid && META.get(t.nid)?.artist ? esc(META.get(t.nid).artist) + ' · ' : ''}${mb(t.size)}</small></span><span class="trail">${dur(t.duration)}</span></div></div>`;
}
function renderMusic() {
  const host = $('pgMusic');
  MV.lib ||= 'pl';
  $('btnEditMusic').hidden = !tracks.length || !!MV.pl || !!MV.view || MV.lib !== 'song';
  if (MV.view === 'search') return renderSearch(host);
  if (MV.view === 'npl') return renderNetPlaylist(host);
  $('btnEditMusic').textContent = MV.edit ? '完成' : '编辑';
  if (MV.pl) return renderPlaylist(host, playlists.find(p => p.id === MV.pl));
  const c = chosen(), real = c === 'all' ? 'all' : c.startsWith('playlist:') ? 'pl' : 'one';
  const curPl = real === 'pl' ? playlists.find(p => 'playlist:' + p.id === c) : null;
  const curT = real === 'one' && !c.startsWith('ncm:') ? tracks.find(t => String(t.id) === c) : null;
  let nowTitle = '随机播放全部', nowSub = tracks.length ? `${tracks.length} 首${totalDur(tracks) ? ' · ' + totalDur(tracks) : ''}` : '还没有休息音乐', nowCover = `<span class="nc-ic">${IC.shuffle}</span>`, nowBg = 'linear-gradient(135deg,#3390ec,#20c997)';
  if (curPl) { const a = plTracks(curPl); nowTitle = curPl.name; nowSub = `歌单顺序播放 · ${a.length} 首${totalDur(a) ? ' · ' + totalDur(a) : ''}`; nowCover = esc([...curPl.name][0] || '♪'); nowBg = grad(curPl.name); }
  if (real === 'one' && c.startsWith('ncm:')) {
    const cover = lsGet('restNcmCover'); nowTitle = lsGet('restNcmName', '网易云歌单'); nowSub = '网易云歌单 · 在线播放';
    nowCover = cover ? '' : `<span class="nc-ic">${IC.note}</span>`; nowBg = cover ? `center/cover url('${cover}')` : grad(nowTitle);
  }
  if (curT) { const it = itemLocal(curT); nowTitle = curT.title; nowSub = `单曲循环 · ${dur(curT.duration)}`; nowCover = it.cover ? '' : `<span class="nc-ic">${IC.note}</span>`; nowBg = it.cover ? `center/cover url('${it.cover}')` : grad(curT.title); }
  const oneMode = MV.mode === 'one';
  const q = MV.q.trim().toLowerCase(), list = q ? tracks.filter(t => t.title.toLowerCase().includes(q)) : tracks;
  const plCard = p => { const a = plTracks(p); return `<button class="plcard" data-pl="${p.id}">
      <span class="plcover" style="background:${grad(p.name)}">${esc([...p.name][0] || '♪')}${curPl?.id === p.id ? `<i class="chk">${IC.check}</i>` : ''}</span>
      <span class="t">${esc(p.name)}</span><span class="s">${a.length} 首${totalDur(a) ? ' · ' + totalDur(a) : ''}</span></button>`; };
  const npCard = p => `<button class="plcard" data-npl="${p.id}"><span class="plcover img" style="background-image:url('${p.cover}')">${p.like ? '<i class="heart">♥</i>' : ''}${c === 'ncm:' + p.id ? `<i class="chk">${IC.check}</i>` : ''}</span>
      <span class="t">${esc(p.name)}</span><span class="s">${p.count} 首${p.mine ? '' : ' · 收藏'}</span></button>`;
  const plTab = `
    <div class="sect">休息音乐歌单${playlists.length ? ' · ' + playlists.length : ''}</div>
    ${playlists.length ? `<div class="plgrid">${playlists.map(plCard).join('')}</div>`
      : `<div class="list"><button class="li" id="plImport"><span class="ico">${PIC.plus}</span><span class="lt">还没有歌单<small>从下方网易云歌单导入,或粘贴歌单链接</small></span></button></div>`}
    <div class="sect">我的网易云歌单${MV.myPl.length ? ' · ' + MV.myPl.length : ''}</div>
    ${MV.me ? (MV.myPl.length ? `<div class="plgrid">${MV.myPl.map(npCard).join('')}</div>` : '<div class="hint">正在同步网易云歌单…</div>')
      : `<div class="list"><button class="li" id="ncmLoginRow"><span class="ico r">${IC.note}</span><span class="lt">登录网易云<small>同步你的歌单,VIP 歌曲也能播放</small></span></button></div>`}`;
  const songTab = !tracks.length
    ? `<div class="empty"><div class="empty-ic">${IC.note}</div><b>还没有休息音乐</b><span>搜索网易云歌曲,或上传 / 粘贴链接添加</span><button class="pri" id="emptyAdd">添加音乐</button></div>`
    : `${oneMode ? '<div class="clip" style="background:#22456b"><span class="lt">选一首作为休息时单曲循环<small>点歌曲前面的圆点</small></span><button class="ib" id="oneCancel" aria-label="取消">' + IC.close + '</button></div>' : ''}
    ${tracks.length > 10 ? `<label class="search">${IC.search}<input id="mSearch" type="text" placeholder="在已添加的歌曲中筛选" value="${esc(MV.q)}" autocomplete="off"></label>` : ''}
    ${MV.edit ? `<div class="editbar"><span>已选 ${MV.sel.size} 首</span><button id="selAll">${MV.sel.size === list.length ? '全不选' : '全选'}</button><button class="danger" id="delSel" ${MV.sel.size ? '' : 'disabled'}>删除所选</button><button class="danger" id="delAll">全部删除</button></div>` : ''}
    <div class="list songs" id="songList">${list.map(t => songRow(t, { radio: oneMode ? curT?.id ?? -1 : 0 })).join('') || '<div class="li"><span class="sub">没有匹配的歌曲</span></div>'}</div>
    ${MV.edit || oneMode ? '' : '<div class="hint">点歌曲试听,点底部播放条打开歌词页;向左滑动可删除。</div>'}`;
  host.innerHTML = `<div id="clipBanner" class="clip" hidden></div>
    <button class="search sbig fake" id="goSearch">${IC.search}<span>搜索网易云歌曲</span></button>
    <div class="nowCard glass" id="nowCard" role="button" aria-label="更换休息时播放的内容">
      <div class="nc-cover" style="background:${nowBg}">${nowCover}</div>
      <div class="lt"><span class="nc-k">休息时播放 · 点击更换</span>${esc(nowTitle)}<small>${nowSub}</small></div>
      <button class="nc-play" id="nowPlay" aria-label="试听">${IC.play}</button>
    </div>
    <div class="seg libSeg"><button data-lib="pl" class="${MV.lib === 'pl' ? 'on' : ''}">歌单</button><button data-lib="song" class="${MV.lib === 'song' ? 'on' : ''}">歌曲${tracks.length ? ' · ' + tracks.length : ''}</button></div>
    ${MV.lib === 'pl' ? plTab : songTab}`;
  bindMusicTop();
  host.querySelectorAll('[data-lib]').forEach(b => b.onclick = () => { MV.lib = b.dataset.lib; MV.edit = false; MV.sel.clear(); if (MV.lib === 'pl') MV.mode = null; renderMusic(); });
  if ($('plImport')) $('plImport').onclick = openAdd;
  if ($('emptyAdd')) $('emptyAdd').onclick = openAdd;
  if ($('ncmLoginRow')) $('ncmLoginRow').onclick = openNcmLogin;
  if ($('oneCancel')) $('oneCancel').onclick = () => { MV.mode = null; renderMusic(); };
  $('nowCard').onclick = e => { if (!e.target.closest('#nowPlay')) openModeSheet(); };
  $('nowPlay').onclick = async () => {
    if (c.startsWith('ncm:')) { try { const l = await ncmRestList(c.slice(4)); if (l.length) playItem(l[Math.max(0, NR.i)] || l[0], l); } catch (e) { toast('加载失败:' + e.message); } return; }
    const ctx = curPl ? plTracks(curPl) : curT ? [curT] : [...tracks].sort(() => Math.random() - 0.5); if (ctx.length) previewTrack(ctx[0].id, ctx.map(t => t.id));
  };
  host.querySelectorAll('[data-pl]').forEach(b => b.onclick = () => { MV.pl = +b.dataset.pl; MV.edit = false; renderMusic(); scrollTo(0, 0); });
  if ($('mSearch')) $('mSearch').oninput = e => { MV.q = e.target.value; const pos = e.target.selectionStart; renderMusic(); const s = $('mSearch'); s.focus(); try { s.setSelectionRange(pos, pos); } catch {} };
  if (MV.edit && $('selAll')) {
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
  if ($('songList')) bindSongList(host, list.map(t => t.id));
  if (oneMode) host.querySelectorAll('[data-one]').forEach(r => r.addEventListener('change', () => { MV.mode = null; toast('已设为单曲循环', 1500); }));
}
// 休息时播放:选择 随机全部 / 某个歌单 / 单曲循环
function openModeSheet() {
  const c = chosen(), box = $('modeBody');
  box.innerHTML = `<div class="list">
    <label class="li"><span class="ico g">${IC.shuffle}</span><span class="lt">随机播放全部<small>${tracks.length} 首,休息时随机选歌</small></span><input type="radio" name="msel" value="all" ${c === 'all' ? 'checked' : ''}></label>
    ${playlists.map(p => `<label class="li"><span class="ico" style="background:${grad(p.name)}">${esc([...p.name][0] || '♪')}</span><span class="lt">${esc(p.name)}<small>歌单 · ${plTracks(p).length} 首 · 顺序播放</small></span><input type="radio" name="msel" value="playlist:${p.id}" ${c === 'playlist:' + p.id ? 'checked' : ''}></label>`).join('')}
    ${MV.myPl.length ? `</div><div class="sect">网易云歌单 · 在线播放 · ${MV.myPl.length}</div>${MV.myPl.length > 8 ? `<label class="search">${IC.search}<input id="mselQ" type="text" placeholder="筛选网易云歌单" autocomplete="off"></label>` : ''}<div class="list" id="mselNcm">${MV.myPl.map(p => `<label class="li" data-n="${esc(p.name.toLowerCase())}"><span class="ico" style="background:#223 center/cover url('${p.cover}')"></span><span class="lt">${esc(p.name)}<small>${p.count} 首 · 按歌单顺序 · 需联网</small></span><input type="radio" name="msel" value="ncm:${p.id}" ${c === 'ncm:' + p.id ? 'checked' : ''}></label>`).join('')}</div><div class="sect">其他</div><div class="list">` : ''}
    <label class="li"><span class="ico o">${IC.note}</span><span class="lt">单曲循环<small>${c !== 'all' && !c.startsWith('playlist:') && !c.startsWith('ncm:') ? esc(tracks.find(t => String(t.id) === c)?.title || '') : '在歌曲列表里选一首'}</small></span><input type="radio" name="msel" value="one" ${c !== 'all' && !c.startsWith('playlist:') && !c.startsWith('ncm:') ? 'checked' : ''}></label>
  </div>${MV.me ? '<div class="hint">网易云歌单不用下载,休息时在线播放;网络不好时建议在歌单详情里"导入为休息音乐"。</div>' : '<div class="hint">登录网易云(点右上角头像)后,可以直接选你的网易云歌单。</div>'}`;
  box.querySelectorAll('input[name=msel]').forEach(r => r.onchange = () => {
    $('modeSheet').hidden = true;
    if (r.value === 'one') { if (!tracks.length) return toast('还没有歌曲'); MV.mode = 'one'; MV.lib = 'song'; renderMusic(); return; }
    if (r.value.startsWith('ncm:')) { const p = MV.myPl.find(x => 'ncm:' + x.id === r.value); lsSet('restNcmName', p?.name || ''); lsSet('restNcmCover', p?.cover || ''); }
    MV.mode = null; setChosen(r.value); renderMusic(); toast('已更换休息时播放', 1500);
  });
  if ($('mselQ')) $('mselQ').oninput = e => { const q = e.target.value.trim().toLowerCase(); $('mselNcm').querySelectorAll('[data-n]').forEach(li => li.hidden = !!q && !li.dataset.n.includes(q)); };
  $('modeSheet').hidden = false;
  box.scrollTop = 0;
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

// ---------- 网易云 API(部署在 Vercel,可在设置里改) ----------
restAudio.crossOrigin = 'anonymous';
const NCM_DEFAULT = 'https://netease-api-iota.vercel.app';
const lsGet = (k, d = '') => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };
const NCM = () => lsGet('ncmApi', NCM_DEFAULT).replace(/\/+$/, '');
// 优先走服务器本机的 netease-api(经 server.py 转发,国内直连很快);本机不可用时退回 Vercel
const NCMLOC = { ok: null, until: 0 };
async function ncmLocalOk() {
  if (NCMLOC.ok !== null && Date.now() < NCMLOC.until) return NCMLOC.ok;
  try { NCMLOC.ok = !!(await (await fetch('api/ncm-status')).json()).local; } catch { NCMLOC.ok = false; }
  NCMLOC.until = Date.now() + 60e3; return NCMLOC.ok;
}
async function ncm(path, params = {}) {
  const q = new URLSearchParams(params);
  const c = lsGet('ncmCookie'); if (c) q.set('cookie', c);
  if (await ncmLocalOk()) {
    try {
      const r = await fetch(`api/ncm${path}?${q}`);
      if (r.status !== 502) { const j = await r.json(); return j; }
    } catch {}
    NCMLOC.ok = false; NCMLOC.until = Date.now() + 60e3;   // 本机接口出问题:1 分钟内改走 Vercel
  }
  q.set('realIP', '116.25.146.177');   // Vercel 部署在海外,告诉网易云按国内 IP 处理
  const r = await fetch(`${NCM()}${path}?${q}`); if (!r.ok) throw new Error('音乐服务 HTTP ' + r.status);
  return r.json();
}
const https_ = u => u ? String(u).replace(/^http:/, 'https:') : '';
const coverOf = (u, n = 300) => u ? https_(u) + `?param=${n}y${n}` : '';
const META = new Map();   // 网易云歌曲 id -> { cover, artist, album }
async function ensureMeta(nids) {
  const need = [...new Set(nids.filter(n => n && !META.has(n)))];
  for (let i = 0; i < need.length; i += 200) {
    try {
      const j = await ncm('/song/detail', { ids: need.slice(i, i + 200).join(',') });
      for (const s of j.songs || []) META.set(s.id, { cover: s.al?.picUrl || '', artist: (s.ar || []).map(a => a.name).join(' / '), album: s.al?.name || '' });
    } catch { break; }
  }
}
const itemLocal = t => { const m = t.nid ? META.get(t.nid) : null; return { key: 'l:' + t.id, lid: t.id, nid: t.nid || null, title: t.title, artist: m?.artist || (KIND[t.kind] || KIND.link)[0], album: m?.album || '', cover: m?.cover ? coverOf(m.cover) : '', duration: t.duration }; };
const itemNet = s => ({ key: 'n:' + s.id, nid: s.id, title: s.name, artist: (s.ar || []).map(a => a.name).join(' / '), album: s.al?.name || '', cover: coverOf(s.al?.picUrl), duration: (s.dt || 0) / 1000, fee: s.fee });

// ---------- 播放器(试听 / 在线播放):队列 + 播放模式 ----------
const PL = { q: [], i: -1, mode: lsGet('plMode', 'list') };   // list 顺序 | shuffle 随机 | one 单曲
const curItem = () => PL.q[PL.i];
async function playItem(item, queue) {
  if (queue) PL.q = queue;
  PL.i = PL.q.findIndex(x => x.key === item.key); if (PL.i < 0) { PL.q = [item]; PL.i = 0; }
  if (restAudio.dataset.prev === item.key && restAudio.getAttribute('src')) { if (restAudio.paused) restAudio.play().catch(() => {}); else restAudio.pause(); return; }
  restAudio.dataset.prev = item.key; restAudio.pause();
  syncMini(); syncPlayer(); markPlaying(); loadLyrics(item);
  try {
    let src;
    if (item.lid) { const t = tracks.find(x => x.id === item.lid); if (!t) throw new Error('歌曲已删除'); src = await trackURL(t); }
    else {
      const j = await ncm('/song/url/v1', { id: item.nid, level: 'exhigh' }), d = j.data?.[0];
      if (!d?.url) throw new Error(d?.fee === 1 || item.fee === 1 ? 'VIP 歌曲:登录网易云 VIP 账号后可播放' : '这首歌暂时无法播放(无版权)');
      src = https_(d.url);
      if (d.freeTrialInfo) toast('非 VIP 只能试听片段,登录 VIP 账号可播放完整版');
    }
    if (restAudio.dataset.prev !== item.key) return;   // 期间又点了别的歌
    restAudio.src = src; restAudio.loop = PL.mode === 'one'; restAudio.muted = false;
    await restAudio.play();
  } catch (err) { toast('无法播放:' + err.message); }
  syncMini(); syncPlayer(); markPlaying();
}
function previewTrack(id, ctx) {   // 播放本地歌曲(休息音乐列表)
  const t = tracks.find(x => x.id === id); if (!t) return;
  const q = (ctx || [id]).map(i => tracks.find(x => x.id === i)).filter(Boolean).map(itemLocal);
  playItem(itemLocal(t), q);
}
function stopPreview() { if (!restAudio.dataset.prev) return; restAudio.pause(); delete restAudio.dataset.prev; closePlayer(); syncMini(); markPlaying(); prepareRest(); }
function stepPlay(dir) {
  if (!PL.q.length) return;
  let i = PL.mode === 'shuffle' && PL.q.length > 1 ? (PL.i + 1 + Math.floor(Math.random() * (PL.q.length - 1))) % PL.q.length : (PL.i + dir + PL.q.length) % PL.q.length;
  const it = PL.q[i]; delete restAudio.dataset.prev; playItem(it);
}
const nextPreview = () => stepPlay(1);
function markPlaying() {
  const k = restAudio.dataset.prev || '';
  document.querySelectorAll('#pgMusic [data-key]').forEach(r => {
    const on = r.dataset.key === k; r.classList.toggle('on', on);
    const sno = r.querySelector('.sno'); if (sno && !sno.dataset.img) sno.innerHTML = on ? `<span class="eq${restAudio.paused ? ' paused' : ''}"><i></i><i></i><i></i></span>` : (sno.dataset.idx || '');
    const eq = r.querySelector('.thumbEq'); if (eq) { eq.hidden = !on; eq.firstElementChild?.classList.toggle('paused', restAudio.paused); }
  });
}
function syncMini() {
  const it = restAudio.dataset.prev ? curItem() : null, m = $('mini');
  m.hidden = !it || document.body.classList.contains('training') || !$('player').hidden;
  document.body.classList.toggle('miniOn', !!it && !document.body.classList.contains('training'));
  if (m.hidden) return;
  $('miniCover').style.background = it.cover ? `center/cover url("${it.cover}")` : grad(it.title); $('miniTitle').textContent = it.title;
  $('miniPlay').innerHTML = restAudio.paused ? IC.play : IC.pause; $('miniPlay').setAttribute('aria-label', restAudio.paused ? '播放' : '暂停');
  const d = restAudio.duration; $('miniFill').style.width = (isFinite(d) && d > 0 ? restAudio.currentTime / d * 100 : 0) + '%';
  $('miniTime').textContent = it.artist ? it.artist : dur(restAudio.currentTime || 0.001) + ' / ' + dur(isFinite(d) ? d : it.duration);
}
['timeupdate', 'play', 'pause', 'loadedmetadata'].forEach(ev => restAudio.addEventListener(ev, () => { if (restAudio.dataset.prev) { syncMini(); if (ev !== 'timeupdate') { markPlaying(); syncPlayer(); } } }));
restAudio.addEventListener('ended', () => { if (restAudio.dataset.prev && PL.mode !== 'one') nextPreview(); });
$('miniPlay').onclick = () => { if (restAudio.paused) restAudio.play().catch(() => {}); else restAudio.pause(); };
$('miniNext').onclick = nextPreview;
$('miniClose').onclick = stopPreview;
$('miniNext').innerHTML = IC.next; $('miniClose').innerHTML = IC.close;
$('mini').onclick = e => { if (!e.target.closest('button')) openPlayer(); };   // 点播放条任意位置(按钮除外)打开歌词页
function bindSeek(el, fill, onLabel) {   // 进度条:点击/拖动快进快退
  let on = false;
  const seek = e => {
    const r = el.firstElementChild.getBoundingClientRect(), p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), d = restAudio.duration;
    if (!isFinite(d) || d <= 0) return;
    restAudio.currentTime = p * d; fill.style.width = p * 100 + '%'; onLabel?.(p * d, d);
  };
  el.addEventListener('pointerdown', e => { on = true; el.classList.add('drag'); try { el.setPointerCapture(e.pointerId); } catch {} seek(e); });
  el.addEventListener('pointermove', e => { if (on) seek(e); });
  const end = () => { on = false; el.classList.remove('drag'); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
// 迷你播放条只显示进度,不可拖动(避免误触);快进在歌词页里操作

// ---------- 全屏播放页(封面取色背景 + 逐行/逐字歌词) ----------
const PIC = {
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  lyric: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 10h10M4 14h16M4 18h8"/></svg>',
  disc: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M19 5L9 12l10 7z"/><path d="M5 5v14"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M4 7h12M4 12h12M4 17h8M18 15v5l3-2.5z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  one: '<svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/><path d="M11 10h1.5v5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};
const MODES = { list: ['list', '顺序播放'], shuffle: ['shuffle', '随机播放'], one: ['one', '单曲循环'] };
const player = $('player');
$('pClose').innerHTML = PIC.down; $('pStyle').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>'; $('pStyle').onclick = openLySheet; $('pPrev').innerHTML = PIC.prev; $('pNext').innerHTML = IC.next;
function openPlayer() { if (!curItem()) return; player.hidden = false; fxAudio(); requestAnimationFrame(() => { fxResize(); stageApply(); }); requestAnimationFrame(() => player.classList.add('show')); syncPlayer(); syncMini(); lyTick(true); }
function closePlayer() { player.classList.remove('show'); setTimeout(() => { player.hidden = true; syncMini(); }, 280); }
$('pClose').onclick = closePlayer;
$('pView').onclick = () => { player.classList.toggle('v-lyric'); $('pView').innerHTML = player.classList.contains('v-lyric') ? PIC.disc : PIC.lyric; lyTick(true); };
$('pView').innerHTML = PIC.disc; player.classList.add('v-lyric');
$('pCoverWrap').onclick = () => $('pView').click();
$('pPlay').onclick = () => { if (restAudio.paused) restAudio.play().catch(() => {}); else restAudio.pause(); };
$('pPrev').onclick = () => { if (restAudio.currentTime > 4) restAudio.currentTime = 0; else stepPlay(-1); };
$('pNext').onclick = () => stepPlay(1);
$('pMode').onclick = () => { const ks = Object.keys(MODES); PL.mode = ks[(ks.indexOf(PL.mode) + 1) % ks.length]; lsSet('plMode', PL.mode); restAudio.loop = PL.mode === 'one'; toast(MODES[PL.mode][1], 1200); syncPlayer(); };
$('pAdd').onclick = async () => {
  const it = curItem(); if (!it || it.lid) return;
  $('pAdd').disabled = true; toast('正在加入休息音乐…', 6000);
  try {
    const j = await ncm('/song/url/v1', { id: it.nid, level: 'exhigh' }), u = j.data?.[0]?.url;
    if (!u) throw new Error('拿不到音频地址(VIP 或无版权)');
    const r = await fetch('api/music/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: https_(u), nid: it.nid, title: it.title + (it.artist ? ' - ' + it.artist : '') }) });
    const s = await r.json().catch(() => ({})); if (!r.ok) throw new Error(s.error || 'HTTP ' + r.status);
    await loadTracks(); toast(s.existed ? '已经在休息音乐里了' : '已加入休息音乐');
    if (TAB === 'music') renderMusic();
  } catch (e) { toast('加入失败:' + e.message); }
  $('pAdd').disabled = false; syncPlayer();
};
let pcColor = '';
function coverColor(url) {   // 取封面平均色,用作背景氛围
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 16; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 16, 16);
      const d = x.getImageData(0, 0, 16, 16).data; let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4; player.style.setProperty('--pc', `rgb(${r / n | 0},${g / n | 0},${b / n | 0})`); fxSetColor(r / n, g / n, b / n);
    } catch {}
  };
  img.src = url;
}
function syncPlayer() {
  const it = curItem(); if (!it || player.hidden) return;
  if (player.dataset.key !== it.key) {
    player.dataset.key = it.key;
    $('pTitle').textContent = it.title; $('pArtist').textContent = [it.artist, it.album].filter(Boolean).join(' · ');
    $('pCover').hidden = !it.cover; $('pCoverFb').hidden = !!it.cover;
    if (it.cover) { const big = it.cover.replace(/param=\d+y\d+/, 'param=600y600'); $('pCover').src = big; $('pBg').style.backgroundImage = `url("${it.cover}")`; coverColor(it.cover); }
    else { $('pCoverFb').style.background = grad(it.title); $('pCoverFb').textContent = [...it.title][0] || '♪'; $('pBg').style.backgroundImage = grad(it.title); player.style.removeProperty('--pc'); }
    if (ST.img) $('pBg').style.backgroundImage = `url("${ST.img}")`;   // 自定义背景图优先
    stageSource(it.cover);
  }
  const playing = !restAudio.paused;
  player.classList.toggle('playing', playing);
  $('pPlay').innerHTML = playing ? IC.pause : IC.play; $('pPlay').setAttribute('aria-label', playing ? '暂停' : '播放');
  $('pMode').innerHTML = PIC[MODES[PL.mode][0]]; $('pMode').setAttribute('aria-label', MODES[PL.mode][1]);
  const inRest = it.lid || tracks.some(t => t.nid && t.nid === it.nid);
  $('pAdd').innerHTML = inRest ? PIC.ok : PIC.plus; $('pAdd').disabled = !!inRest; $('pAdd').setAttribute('aria-label', inRest ? '已在休息音乐' : '加入休息音乐');
}
bindSeek($('pSeek'), $('pFill'), (t, d) => { $('pCurT').textContent = dur(t || 0.001); $('pDurT').textContent = dur(d); lyTick(true); });

// 歌词:LRC(逐行)/ YRC(逐字),含翻译;当前行逐字填充,其余行按距离模糊变淡
const LY = { key: '', lines: [], cur: -2 };
function parseLrc(text) {
  const out = [];
  for (const raw of (text || '').split('\n')) {
    const ts = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]; if (!ts.length) continue;
    const tx = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of ts) out.push({ t: +m[1] * 60 + +m[2], text: tx });
  }
  return out.sort((a, b) => a.t - b.t);
}
function parseYrc(text) {
  const out = [];
  for (const raw of (text || '').split('\n')) {
    const m = raw.match(/^\[(\d+),(\d+)\](.*)$/); if (!m) continue;
    const words = [...m[3].matchAll(/\((\d+),(\d+),\d+\)([^(]*)/g)].map(w => ({ t: +w[1] / 1000, d: +w[2] / 1000, w: w[3] }));
    out.push({ t: +m[1] / 1000, d: +m[2] / 1000, text: words.map(w => w.w).join(''), words });
  }
  return out;
}
async function loadLyrics(it) {
  LY.key = it.key; LY.lines = []; LY.cur = -2; renderLyrics(it.nid ? '歌词加载中…' : '暂无歌词');
  if (!it.nid) return;
  try {
    const j = await ncm('/lyric/new', { id: it.nid });
    if (LY.key !== it.key) return;
    let lines = j.yrc?.lyric ? parseYrc(j.yrc.lyric) : [];
    if (!lines.length) lines = parseLrc(j.lrc?.lyric);
    lines = lines.filter(l => l.text && !/^(作词|作曲|编曲|制作人|原唱|和声|混音|母带|吉他|贝斯|鼓|弦乐|录音|监制|出品|发行)[\s::]/.test(l.text));
    const tr = parseLrc(j.tlyric?.lyric).filter(l => l.text);
    for (const l of lines) { const m = tr.find(x => Math.abs(x.t - l.t) < 0.6); if (m) l.tr = m.text; }
    if (j.pureMusic || j.nolyric) { renderLyrics('纯音乐,请欣赏'); return; }
    LY.lines = lines; renderLyrics(lines.length ? '' : '暂无歌词');
  } catch { if (LY.key === it.key) renderLyrics('歌词加载失败'); }
}
// ---------- 歌词渲染:逐字拆分(每个字有自己的时间),多种动画风格 ----------
const LYS = { style: lsGet('lyStyle', 'flow'), fx: lsGet('lyFx', '1') === '1', tr: lsGet('lyTr', '1') === '1' };
const LY_STYLES = { flow: ['流光', '逐字填充,其余行按距离模糊'], focus: ['聚焦', '只显示当前一句,大字居中逐字浮现'], bounce: ['跃动', '每个字弹跳出场,唱到时轻轻上浮'], rise: ['浮现', '文字从四周飘散聚拢,像粒子拼成句子'] };
function applyLyStyle() {
  for (const k of Object.keys(LY_STYLES)) player.classList.toggle('ly-' + k, LYS.style === k);
  player.classList.toggle('no-tr', !LYS.tr);
}
function lineChars(l, next) {
  const out = [];
  if (l.words) {
    for (const w of l.words) { const cs = [...w.w]; cs.forEach((ch, j) => out.push({ ch, t: w.t + w.d * j / cs.length, d: Math.max(0.04, w.d / cs.length) })); }
  } else {
    const cs = [...l.text], span = Math.min((next ?? l.t + 5) - l.t, Math.max(1.2, cs.length * 0.32));
    cs.forEach((ch, j) => out.push({ ch, t: l.t + span * j / cs.length, d: Math.max(0.04, span / cs.length) }));
  }
  return out;
}
function renderLyrics(msg) {
  const box = $('lyIn'); applyLyStyle();
  if (msg || !LY.lines.length) { box.innerHTML = `<div class="lyempty">${esc(msg || '暂无歌词')}</div>`; box.style.transform = ''; $('pMini').textContent = ''; return; }
  LY.lines.forEach((l, i) => { l.chars = lineChars(l, LY.lines[i + 1]?.t); });
  const rnd = (a) => (Math.random() * 2 - 1) * a;
  box.innerHTML = LY.lines.map((l, i) => `<div class="lyl" data-i="${i}"><div class="lyt">${l.chars.map((c, j) =>
    `<span class="c" style="--i:${j};--rx:${rnd(60) | 0}px;--ry:${rnd(40) | 0}px;--rr:${rnd(40) | 0}deg">${c.ch === ' ' ? '&nbsp;' : esc(c.ch)}</span>`).join('')}</div>${l.tr ? `<div class="lytr">${esc(l.tr)}</div>` : ''}</div>`).join('');
  box.querySelectorAll('.lyl').forEach(el => el.onclick = () => { restAudio.currentTime = LY.lines[+el.dataset.i].t + 0.01; if (restAudio.paused) restAudio.play().catch(() => {}); lyTick(true); });
  LY.cur = -2; lyTick(true);
}
function lyTick(force) {
  if (player.hidden || !LY.lines.length) return;
  const t = restAudio.currentTime + 0.12, L = LY.lines, els = $('lyIn').children;
  let i = -1; for (let k = 0; k < L.length; k++) { if (L[k].t <= t) i = k; else break; }
  if (i !== LY.cur || force) {
    const prev = LY.cur; LY.cur = i;
    for (let k = 0; k < els.length; k++) {
      const e = els[k], dd = Math.abs(k - i);
      e.classList.toggle('cur', k === i); e.classList.toggle('past', k < i); e.classList.toggle('next', k === i + 1);
      e.classList.toggle('leave', k === prev && k !== i);
      e.style.setProperty('--d', Math.min(dd, 6));
      if (k !== i) e.querySelectorAll('.c').forEach(c => c.style.removeProperty('--k'));
    }
    const el = els[Math.max(0, i)], box = $('lyBox');
    if (el) {
      el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');   // 重新触发出场动画
      $('lyIn').style.transform = LYS.style === 'focus' ? '' : `translateY(${box.clientHeight * 0.36 - el.offsetTop - el.offsetHeight / 2}px)`;
      if (i !== prev && i >= 0 && !force) fxBurstAt(el);
    }
    $('pMini').textContent = i >= 0 ? L[i].text : '';
  }
  const el = els[i]; if (!el) return;
  const cs = L[i].chars, spans = el.firstElementChild.children; let head = -1;
  for (let j = 0; j < cs.length; j++) {
    const k = Math.round(Math.max(0, Math.min(1, (t - cs[j].t) / cs[j].d)) * 100);
    if (spans[j]._k !== k) { spans[j]._k = k; spans[j].style.setProperty('--k', k); }
    if (k > 0 && k < 100) head = j;
  }
  FX.head = head >= 0 ? spans[head] : null;
}

// ---------- 粒子特效(Canvas):环境光尘 + 唱词光点 + 换行迸发;随音乐能量律动 ----------
const FX = { cvs: $('pFx'), ctx: null, ps: [], w: 0, h: 0, dpr: 1, rgb: [130, 190, 255], sprite: null, energy: 0, head: null, frame: 0, an: null, buf: null };
FX.ctx = FX.cvs.getContext('2d');
function fxSprite() {
  const s = document.createElement('canvas'); s.width = s.height = 64; const x = s.getContext('2d'), [r, g, b] = FX.rgb;
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, `rgba(255,255,255,1)`); gr.addColorStop(0.25, `rgba(${r},${g},${b},.85)`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64); FX.sprite = s;
}
function fxSetColor(r, g, b) {   // 封面颜色提亮后作为粒子颜色
  const m = Math.max(r, g, b, 1), k = 235 / m; FX.rgb = [Math.min(255, r * k + 30), Math.min(255, g * k + 30), Math.min(255, b * k + 30)].map(v => v | 0); fxSprite();
}
fxSprite();
function fxResize() {
  FX.dpr = Math.min(2, devicePixelRatio || 1); FX.w = player.clientWidth; FX.h = player.clientHeight;
  FX.cvs.width = FX.w * FX.dpr; FX.cvs.height = FX.h * FX.dpr;
}
addEventListener('resize', () => { if (!player.hidden) fxResize(); });
function fxAdd(x, y, vx, vy, life, size, a = 1) { if (FX.ps.length < 260) FX.ps.push({ x, y, vx, vy, life, max: life, size, a, tw: Math.random() * 6.28 }); }
function fxAmbient() {   // 维持一层缓慢上浮的光尘
  let n = 0; for (const p of FX.ps) if (p.amb) n++;
  while (n++ < 46) { fxAdd(Math.random() * FX.w, FX.h + Math.random() * FX.h * 0.2, (Math.random() - 0.5) * 6, -(8 + Math.random() * 22), 9 + Math.random() * 8, 1 + Math.random() * 3, 0.5); FX.ps[FX.ps.length - 1].amb = true; FX.ps[FX.ps.length - 1].y = Math.random() * FX.h; }
}
function fxRel(el) { const r = el.getBoundingClientRect(), pr = player.getBoundingClientRect(); return [r.left - pr.left, r.top - pr.top, r.width, r.height]; }
function fxBurstAt(el) {
  if (!LYS.fx || player.hidden) return;
  const [x, y, w, h] = fxRel(el.firstElementChild || el), n = 26 + (FX.energy * 30 | 0);
  for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, v = 40 + Math.random() * 140; fxAdd(x + Math.random() * Math.min(w, FX.w * 0.8), y + h / 2 + (Math.random() - 0.5) * h, Math.cos(a) * v, Math.sin(a) * v - 30, 0.8 + Math.random() * 0.9, 2 + Math.random() * 4); }
}
let fxCtx = null;
function fxAudio() {   // 首次打开播放页时(用户点击)接入音频分析;失败也不影响播放
  if (FX.an || !window.AudioContext) return;
  try {
    fxCtx = new AudioContext(); const src = fxCtx.createMediaElementSource(restAudio);
    FX.an = fxCtx.createAnalyser(); FX.an.fftSize = 256; FX.buf = new Uint8Array(FX.an.frequencyBinCount);
    src.connect(FX.an); FX.an.connect(fxCtx.destination);
    restAudio.addEventListener('play', () => { if (fxCtx.state !== 'running') fxCtx.resume().catch(() => {}); });
    fxCtx.resume().catch(() => {});
  } catch (e) { console.warn('音频分析不可用', e); FX.an = null; }
}
let fxLast = performance.now();
function fxFrame(now) {
  const dt = Math.min(0.05, (now - fxLast) / 1000); fxLast = now;
  if (player.hidden) return;
  if (FX.an && !restAudio.paused) {   // 低频能量 -> 律动
    FX.an.getByteFrequencyData(FX.buf); let s = 0; for (let i = 1; i < 12; i++) s += FX.buf[i];
    const avg = s / 11; FX.base = (FX.base ?? avg) + (avg - (FX.base ?? avg)) * 0.02;   // 相对近期平均的起伏 = 节拍
    const e = Math.max(0, Math.min(1, (avg - FX.base) / 45 + 0.12)); FX.energy += (e - FX.energy) * (e > FX.energy ? 0.45 : 0.08);
  } else FX.energy *= 0.95;
  player.style.setProperty('--beat', FX.energy.toFixed(3));
  const c = FX.ctx; c.setTransform(FX.dpr, 0, 0, FX.dpr, 0, 0); c.clearRect(0, 0, FX.w, FX.h);
  if (!LYS.fx) return;
  fxAmbient();
  if (FX.head && !restAudio.paused && (FX.frame++ % 2 === 0)) {   // 唱到的字迸出光点
    const [x, y, w, h] = fxRel(FX.head);
    for (let i = 0; i < 1 + (FX.energy * 2 | 0); i++) fxAdd(x + w * Math.random(), y + h * (0.3 + Math.random() * 0.5), (Math.random() - 0.5) * 50, -(30 + Math.random() * 60), 0.6 + Math.random() * 0.7, 1.5 + Math.random() * 3);
  }
  c.globalCompositeOperation = 'lighter';
  const sp = 1 + FX.energy * 2.2;
  for (let i = FX.ps.length - 1; i >= 0; i--) {
    const p = FX.ps[i]; p.life -= dt * (p.amb ? 1 : 1);
    p.x += p.vx * dt * (p.amb ? sp : 1); p.y += p.vy * dt * (p.amb ? sp : 1);
    if (!p.amb) { p.vx *= 0.97; p.vy = p.vy * 0.97 + 12 * dt; }
    else p.x += Math.sin(now / 1000 + p.tw) * 0.15;
    if (p.life <= 0 || p.y < -20) { FX.ps.splice(i, 1); continue; }
    const fade = p.amb ? Math.min(1, p.life / 2, (p.max - p.life) / 2) : p.life / p.max;
    const tw = p.amb ? 0.55 + 0.45 * Math.sin(now / 400 + p.tw) : 1;
    const s = p.size * (p.amb ? 1 + FX.energy * 0.6 : 1) * 1.5;
    c.globalAlpha = Math.max(0, fade * tw * p.a * (p.amb ? 0.55 + FX.energy * 0.45 : 1));
    c.drawImage(FX.sprite, p.x - s, p.y - s, s * 2, s * 2);
  }
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
}
let stLast = performance.now();
(function lyLoop(now) {
  now = now || performance.now(); const sdt = Math.min(0.05, (now - stLast) / 1000); stLast = now;
  if (!player.hidden) {
    stageFrame(now, sdt);
    if (!restAudio.paused) { lyTick(false); const d = restAudio.duration; if (isFinite(d) && d > 0) { $('pFill').style.width = restAudio.currentTime / d * 100 + '%'; $('pCurT').textContent = dur(restAudio.currentTime || 0.001); $('pDurT').textContent = dur(d); } }
    fxFrame(now || performance.now());
  }
  requestAnimationFrame(lyLoop);
})();
restAudio.addEventListener('loadedmetadata', () => { const d = restAudio.duration; if (isFinite(d)) $('pDurT').textContent = dur(d); });

// ---------- 粒子舞台(WebGL):用背景图(默认封面)生成一圈粒子地形,随音乐频谱起伏 ----------
// 中心对应低频、外圈对应高频;粒子颜色取自图片,亮的地方起伏更高
const ST = { on: lsGet('lyBg', 'stage') === 'stage', img: lsGet('stageImg'), gl: null, prog: null, n: 0, buf: null, spec: null, specTex: null, cvs: $('pStage'), w: 0, h: 0, src: '', loading: '', rot: 0, specArr: new Uint8Array(128) };
function stageInit() {
  if (ST.gl) return true;
  const gl = ST.cvs.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: false });
  if (!gl) return false;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const vs = `attribute vec2 aPos; attribute vec3 aCol; attribute float aSeed;
    uniform mat4 uMVP; uniform sampler2D uSpec; uniform float uTime, uBeat, uPx;
    varying vec3 vCol; varying float vA;
    void main(){
      float r = length(aPos);
      float s = texture2D(uSpec, vec2(0.02 + r * 0.7, 0.5)).r;
      float lum = dot(aCol, vec3(0.3, 0.59, 0.11));
      float h = s * (0.18 + 0.82 * lum) * 0.75 + sin(uTime * 1.3 + aSeed * 6.283 + r * 7.0) * 0.012 + uBeat * 0.06 * (1.0 - r);
      vec4 p = uMVP * vec4(aPos.x, h, aPos.y, 1.0);
      gl_Position = p;
      gl_PointSize = uPx * (0.8 + s * 1.6 + lum * 0.6) / p.w;
      vCol = aCol * (0.45 + 1.1 * s) + vec3(0.10, 0.28, 0.42) * s * 1.4;
      vA = smoothstep(1.0, 0.72, r) * (0.22 + 0.5 * min(1.0, s * 1.6 + lum * 0.5));
    }`;
  const fs = `precision mediump float; varying vec3 vCol; varying float vA;
    void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.05, length(d)); gl_FragColor = vec4(vCol, a * vA); }`;
  try {
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    ST.prog = p;
  } catch (e) { console.warn('粒子舞台不可用', e); return false; }
  ST.gl = gl; ST.buf = gl.createBuffer();
  ST.specTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, ST.specTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 128, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, ST.specArr);
  return true;
}
function stageBuild(imgOrCanvas) {   // 把图片采样成粒子:圆盘内 ~1 万个点
  const gl = ST.gl; if (!gl) return;
  const G = 112, c = document.createElement('canvas'); c.width = c.height = G; const x = c.getContext('2d');
  try { x.drawImage(imgOrCanvas, 0, 0, G, G); } catch { return; }
  let px; try { px = x.getImageData(0, 0, G, G).data; } catch { return; }
  const out = [];
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const u = (i + 0.5) / G * 2 - 1, v = (j + 0.5) / G * 2 - 1, r = Math.hypot(u, v); if (r > 1) continue;
    const o = (j * G + i) * 4, jit = 0.6 / G;
    out.push(u + (Math.random() - 0.5) * jit, v + (Math.random() - 0.5) * jit, px[o] / 255, px[o + 1] / 255, px[o + 2] / 255, Math.random());
  }
  ST.n = out.length / 6;
  gl.bindBuffer(gl.ARRAY_BUFFER, ST.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
}
function stageSource(coverUrl) {   // 选择图片来源:自定义 > 封面 > 渐变
  if (!ST.on || !stageInit()) return;
  const src = ST.img || coverUrl || 'grad:' + ($('pTitle').textContent || '');
  if (src === ST.src) return;
  ST.src = src;
  if (src.startsWith('grad:')) {
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 2, 32, 32, 34); g.addColorStop(0, '#9be7ff'); g.addColorStop(0.5, '#3390ec'); g.addColorStop(1, '#0b1a33');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64); stageBuild(c); return;
  }
  const im = new Image(); im.crossOrigin = 'anonymous'; ST.loading = src;
  im.onload = () => { if (ST.loading === src) stageBuild(im); };
  im.onerror = () => { if (ST.loading === src) { ST.src = ''; stageSource(''); } };
  im.src = src.startsWith('data:') ? src : src.replace(/param=\d+y\d+/, 'param=200y200');
}
function stageResize() {
  if (!ST.gl) return;
  const dpr = Math.min(2, devicePixelRatio || 1); ST.w = player.clientWidth; ST.h = player.clientHeight;
  ST.cvs.width = ST.w * dpr; ST.cvs.height = ST.h * dpr; ST.gl.viewport(0, 0, ST.cvs.width, ST.cvs.height); ST.dpr = dpr;
}
addEventListener('resize', () => { if (!player.hidden) stageResize(); });
function m4persp(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; }
function m4look(e, c) {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2], l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = zz, xy = 0, xz = -zx; l = Math.hypot(xx, xz) || 1; xx /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
}
function m4mul(a, b) { const o = new Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; }
function stageFrame(now, dt) {
  if (!ST.on || !ST.gl || !ST.n) return;
  const gl = ST.gl, t = now / 1000;
  // 频谱:有音频分析用真实频谱,否则用柔和的模拟波动
  if (FX.an && !restAudio.paused) FX.an.getByteFrequencyData(ST.specArr);
  else for (let i = 0; i < 128; i++) ST.specArr[i] = ST.specArr[i] * 0.92 + (restAudio.paused ? 0 : (0.5 + 0.5 * Math.sin(t * 2 + i * 0.25)) * 60) * 0.08;
  gl.bindTexture(gl.TEXTURE_2D, ST.specTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, ST.specArr);
  ST.rot += dt * (0.05 + FX.energy * 0.12);
  const asp = ST.w / Math.max(1, ST.h), th = Math.tan(0.78 / 2), dist = asp > 1 ? 3.1 : Math.max(2.2, 0.98 / (th * asp));   // 竖屏退远让整盘可见;横屏固定距离   // 竖屏时退远,整盘可见
  const ey = dist * 0.48, er = dist * 0.88;
  const mvp = m4mul(m4persp(0.78, asp, 0.05, 20), m4look([Math.sin(ST.rot) * er, ey, Math.cos(ST.rot) * er], [0, asp > 1 ? 0.75 : 0.62, 0]));
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(ST.prog); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.bindBuffer(gl.ARRAY_BUFFER, ST.buf);
  const at = n => gl.getAttribLocation(ST.prog, n), un = n => gl.getUniformLocation(ST.prog, n);
  gl.enableVertexAttribArray(at('aPos')); gl.vertexAttribPointer(at('aPos'), 2, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(at('aCol')); gl.vertexAttribPointer(at('aCol'), 3, gl.FLOAT, false, 24, 8);
  gl.enableVertexAttribArray(at('aSeed')); gl.vertexAttribPointer(at('aSeed'), 1, gl.FLOAT, false, 24, 20);
  gl.uniformMatrix4fv(un('uMVP'), false, new Float32Array(mvp));
  gl.uniform1f(un('uTime'), t); gl.uniform1f(un('uBeat'), FX.energy); gl.uniform1f(un('uPx'), 2.6 * (ST.dpr || 1) * dist * Math.min(ST.w, ST.h) / 390);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ST.specTex); gl.uniform1i(un('uSpec'), 0);
  gl.drawArrays(gl.POINTS, 0, ST.n);
}
function stageApply() {
  player.classList.toggle('stage-on', ST.on);
  if (ST.on) { stageInit(); stageResize(); ST.src = ''; const it = curItem(); stageSource(it?.cover || ''); }
  else if (ST.gl) { ST.gl.clearColor(0, 0, 0, 0); ST.gl.clear(ST.gl.COLOR_BUFFER_BIT); }
}
function stageCustomImage(file) {   // 导入背景图:缩到 256px 存本地
  const fr = new FileReader();
  fr.onload = () => {
    const im = new Image();
    im.onload = () => {
      const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d');
      const k = Math.max(S / im.width, S / im.height), w = im.width * k, h = im.height * k; x.drawImage(im, (S - w) / 2, (S - h) / 2, w, h);
      ST.img = c.toDataURL('image/jpeg', 0.85); lsSet('stageImg', ST.img); lsSet('stageImgBg', '1');
      ST.src = ''; stageSource(''); $('pBg').style.backgroundImage = `url("${ST.img}")`; toast('已设为背景图', 1500); openLySheet();
    };
    im.src = fr.result;
  };
  fr.readAsDataURL(file);
}

// ---------- 歌词风格面板 ----------
function openLySheet() {
  const box = $('lyBody');
  box.innerHTML = `<div class="sect" style="padding-top:0">歌词动画</div><div class="list">${Object.entries(LY_STYLES).map(([k, [n, d]]) =>
    `<label class="li"><span class="lt">${n}<small>${d}</small></span><input type="radio" name="lys" value="${k}" ${LYS.style === k ? 'checked' : ''}></label>`).join('')}</div>
    <div class="sect">背景</div><div class="list">
      <label class="li"><span class="lt">粒子舞台<small>用背景图生成粒子地形,随音乐频谱起伏旋转</small></span><input type="radio" name="lybg" value="stage" ${ST.on ? 'checked' : ''}></label>
      <label class="li"><span class="lt">模糊封面<small>封面大面积模糊流动</small></span><input type="radio" name="lybg" value="blur" ${ST.on ? '' : 'checked'}></label></div>
    <div class="sect">背景图片</div><div class="list">
      <div class="li"><span class="ico" style="background:#223 center/cover url('${ST.img || curItem()?.cover || ''}')"></span><span class="lt">${ST.img ? '自定义图片' : '使用歌曲封面'}<small>${ST.img ? '所有歌曲都用这张图做背景' : '每首歌自动用自己的封面'}</small></span>
        <button class="ib txt" id="stPick">${ST.img ? '更换' : '导入图片'}</button>${ST.img ? '<button class="ib txt" id="stReset">用封面</button>' : ''}</div></div>
    <input type="file" id="stFile" accept="image/*" hidden>
    <div class="sect">效果</div><div class="list">
      <label class="li"><span class="lt">粒子特效<small>光尘漂浮、唱到的字迸出光点、换行时迸发,随音乐律动</small></span><input type="checkbox" class="sw" id="lyFxSw" ${LYS.fx ? 'checked' : ''}></label>
      <label class="li"><span class="lt">显示翻译<small>外文歌词下方显示中文翻译</small></span><input type="checkbox" class="sw" id="lyTrSw" ${LYS.tr ? 'checked' : ''}></label></div>`;
  box.querySelectorAll('input[name=lys]').forEach(r => r.onchange = () => { LYS.style = r.value; lsSet('lyStyle', r.value); renderLyrics(LY.lines.length ? '' : undefined); });
  box.querySelectorAll('input[name=lybg]').forEach(r => r.onchange = () => { ST.on = r.value === 'stage'; lsSet('lyBg', r.value); stageApply(); });
  $('stPick').onclick = () => $('stFile').click();
  $('stFile').onchange = e => { const f = e.target.files[0]; if (f) stageCustomImage(f); };
  if ($('stReset')) $('stReset').onclick = () => { ST.img = ''; lsSet('stageImg', ''); ST.src = ''; const it = curItem(); player.dataset.key = ''; syncPlayer(); stageSource(it?.cover || ''); openLySheet(); };
  $('lyFxSw').onchange = e => { LYS.fx = e.target.checked; lsSet('lyFx', LYS.fx ? '1' : '0'); if (!LYS.fx) FX.ps.length = 0; };
  $('lyTrSw').onchange = e => { LYS.tr = e.target.checked; lsSet('lyTr', LYS.tr ? '1' : '0'); applyLyStyle(); lyTick(true); };
  $('lySheet').hidden = false;
}


// ---------- 我的网易云歌单(登录后同步) ----------
async function loadMyPlaylists() {
  if (!MV.me?.uid) { MV.myPl = []; return; }
  try {
    const j = await ncm('/user/playlist', { uid: MV.me.uid, limit: 200, timestamp: Date.now() });
    MV.myPl = (j.playlist || []).map(p => ({ id: p.id, name: p.specialType === 5 ? '我喜欢的音乐' : p.name, count: p.trackCount, cover: coverOf(p.coverImgUrl, 300), mine: p.userId === MV.me.uid, like: p.specialType === 5 }));
  } catch { MV.myPl = []; }
}
const myPlSection = () => MV.myPl.length ? `<div class="sect">我的网易云歌单 · ${MV.myPl.length}<span class="sect-r">点开可播放或导入</span></div>
  <div class="plrow">${MV.myPl.map(p => `<button class="plcard" data-npl="${p.id}"><span class="plcover img" style="background-image:url('${p.cover}')">${p.like ? '<i class="heart">♥</i>' : ''}${playlists.some(x => x.name === p.name) ? `<i class="chk">${IC.check}</i>` : ''}</span>
    <span class="t">${esc(p.name)}</span><span class="s">${p.count} 首${p.mine ? '' : ' · 收藏'}</span></button>`).join('')}</div>` : '';
const netRow = (it, i) => `<div class="srow net" data-key="${it.key}"><div class="sfront">
    <span class="thumb" style="background-image:url('${it.cover}')"><span class="thumbEq" hidden><span class="eq"><i></i><i></i><i></i></span></span></span>
    <span class="lt">${esc(it.title)}<small>${it.fee === 1 ? '<b class="kb" style="background:#e5484d">VIP</b>' : ''}${esc(it.artist)}${it.album ? ' · ' + esc(it.album) : ''}</small></span>
    <span class="trail">${dur(it.duration)}</span></div></div>`;
async function renderNetPlaylist(host) {
  const p = MV.myPl.find(x => x.id === MV.npl); if (!p) { MV.view = ''; return renderMusic(); }
  const busy = MV.importing[p.id];
  host.innerHTML = `<button class="backbtn" id="nplBack">${IC.back}音乐</button>
    <div class="pldHead"><div class="plcover big img" style="background-image:url('${p.cover}')"></div>
      <div class="lt"><b>${esc(p.name)}</b><small>网易云歌单 · ${p.count} 首</small></div></div>
    <div class="pldActs"><button class="pri" id="nplPlay">${IC.play}播放全部</button><button id="nplImport" ${busy ? 'disabled' : ''}>${busy || '导入为休息音乐'}</button></div>
    <div id="nplList"><div class="hint" style="text-align:center;padding:30px 0">加载歌曲中…</div></div>
    <div class="hint">"导入为休息音乐"会把歌曲下载到你的服务器,并在"歌单"里生成同名歌单,训练休息时可直接选用;已登录黑胶 VIP 时 VIP 歌曲也能导入。</div>`;
  $('nplBack').onclick = () => { MV.view = ''; renderMusic(); };
  let items = MV.nplItems[p.id];
  if (!items) {
    try { const j = await ncm('/playlist/track/all', { id: p.id, limit: 1000, timestamp: Date.now() }); items = MV.nplItems[p.id] = (j.songs || []).map(itemNet); }
    catch (e) { if ($('nplList')) $('nplList').innerHTML = `<div class="note bad" style="text-align:center">加载失败:${esc(e.message)}</div>`; return; }
  }
  if (MV.view !== 'npl' || MV.npl !== p.id) return;
  $('nplList').innerHTML = items.length ? `<div class="list songs">${items.map(netRow).join('')}</div>` : '<div class="hint" style="text-align:center;padding:30px 0">歌单是空的</div>';
  $('nplList').querySelectorAll('.srow').forEach(r => r.querySelector('.sfront').onclick = () => playItem(items.find(x => x.key === r.dataset.key), items));
  $('nplPlay').onclick = () => { if (items.length) playItem(PL.mode === 'shuffle' ? items[Math.floor(Math.random() * items.length)] : items[0], items); };
  $('nplImport').onclick = () => importNetPlaylist(p, items);
  markPlaying();
}
async function importNetPlaylist(p, items) {
  if (MV.importing[p.id] || !items.length) return;
  if (!confirm(`把「${p.name}」的 ${items.length} 首歌下载到服务器作为休息音乐?歌曲多时需要几分钟,期间可以离开这个页面。`)) return;
  const have = new Map(tracks.filter(t => t.nid).map(t => [t.nid, t.id]));
  const ids = []; let ok = 0, skip = 0, fail = 0, vip = 0;
  const upd = txt => { MV.importing[p.id] = txt; const b = $('nplImport'); if (b && MV.npl === p.id) { b.textContent = txt; b.disabled = true; } };
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10), need = batch.filter(it => !have.has(it.nid));
    let urls = new Map();
    if (need.length) {
      try { const j = await ncm('/song/url/v1', { id: need.map(it => it.nid).join(','), level: 'exhigh' }); urls = new Map((j.data || []).map(d => [d.id, d])); } catch {}
    }
    for (const it of batch) {
      upd(`导入中 ${ids.length + fail + vip + 1}/${items.length}…`);
      if (have.has(it.nid)) { ids.push(have.get(it.nid)); skip++; continue; }
      const d = urls.get(it.nid);
      if (!d?.url || d.freeTrialInfo) { vip++; continue; }   // 无版权 / 非 VIP 只能试听片段:跳过
      try {
        const r = await fetch('api/music/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: https_(d.url), nid: it.nid, title: it.title + (it.artist ? ' - ' + it.artist : '') }) });
        const sj = await r.json().catch(() => ({})); if (!r.ok) throw new Error(sj.error);
        ids.push(sj.id); have.set(it.nid, sj.id); ok++;
      } catch { fail++; }
    }
  }
  try { await fetch('api/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'netease:' + p.id, name: p.name, ids }) }); } catch {}
  delete MV.importing[p.id];
  await loadTracks();
  toast(`「${p.name}」导入完成:新增 ${ok} 首,已有 ${skip} 首` + (vip ? `,无版权/需 VIP ${vip} 首` : '') + (fail ? `,失败 ${fail} 首` : ''), 6000);
  if (TAB === 'music') renderMusic();
}

// ---------- 在线搜索 ----------
async function renderSearch(host) {
  host.innerHTML = `<button class="backbtn" id="srBack">${IC.back}音乐</button>
    <label class="search sbig">${IC.search}<input id="srQ" type="search" enterkeyhint="search" placeholder="搜索网易云:歌名 / 歌手" value="${esc(MV.sq || '')}" autocomplete="off"></label>
    <div id="srRes"></div>`;
  $('srBack').onclick = () => { MV.view = ''; renderMusic(); };
  const q = $('srQ'); let timer;
  const run = async () => {
    const kw = q.value.trim(); MV.sq = kw; const box = $('srRes');
    if (!kw) { box.innerHTML = '<div class="hint" style="text-align:center;padding:30px 0">输入歌名或歌手,搜索后点歌曲即可播放,点 + 加入休息音乐</div>'; return; }
    box.innerHTML = '<div class="hint" style="text-align:center;padding:30px 0">搜索中…</div>';
    try {
      const j = await ncm('/cloudsearch', { keywords: kw, limit: 40 }); if (MV.sq !== kw) return;
      const songs = j.result?.songs || [];
      MV.sr = songs.map(itemNet);
      box.innerHTML = songs.length ? `<div class="list songs">${MV.sr.map(it => `<div class="srow net" data-key="${it.key}"><div class="sfront">
        <span class="thumb" style="background-image:url('${it.cover}')"><span class="thumbEq" hidden><span class="eq"><i></i><i></i><i></i></span></span></span>
        <span class="lt">${esc(it.title)}<small>${it.fee === 1 ? '<b class="kb" style="background:#e5484d">VIP</b>' : ''}${esc(it.artist)}${it.album ? ' · ' + esc(it.album) : ''}</small></span>
        <span class="trail">${dur(it.duration)}</span><button class="ib addb" data-add="${it.nid}" aria-label="加入休息音乐">${tracks.some(t => t.nid === it.nid) ? PIC.ok : PIC.plus}</button></div></div>`).join('')}</div>` : '<div class="hint" style="text-align:center;padding:30px 0">没有找到相关歌曲</div>';
      box.querySelectorAll('.srow').forEach(r => r.querySelector('.sfront').onclick = e => {
        const it = MV.sr.find(x => x.key === r.dataset.key);
        if (e.target.closest('[data-add]')) { delete restAudio.dataset.prev; playItem(it, MV.sr).then(() => $('pAdd').click()); return; }
        playItem(it, MV.sr);
      });
      markPlaying();
    } catch (e) { box.innerHTML = `<div class="note bad" style="text-align:center">搜索失败:${esc(e.message)}</div>`; }
  };
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 450); };
  q.onkeydown = e => { if (e.key === 'Enter') { clearTimeout(timer); run(); q.blur(); } };
  run(); if (!MV.sq) setTimeout(() => q.focus(), 60);
}

// ---------- 网易云账号(扫码 / 验证码登录,用于 VIP 歌曲) ----------
const ncmSheet = $('ncmSheet');
async function ncmStatus() {
  if (!lsGet('ncmCookie')) { self.ncmMe = null; showUser(); return null; }
  try { const j = await ncm('/login/status', { timestamp: Date.now() }); const p = j.data?.profile || j.profile; self.ncmMe = p ? { uid: p.userId, name: p.nickname, avatar: p.avatarUrl, vip: (j.data?.account?.vipType || 0) > 0 } : null; } catch { self.ncmMe = null; }
  showUser(); return self.ncmMe;
}
let qrTimer = null;
function bindAcct() { $('acSwitch').onclick = () => { ncmSheet.hidden = true; clearInterval(qrTimer); showLogin(true); }; }
async function openNcmLogin() {
  ncmSheet.hidden = false; clearInterval(qrTimer);
  const box = $('ncmBody'); box.innerHTML = '<div class="hint" style="text-align:center;padding:20px">加载中…</div>';
  const me = await ncmStatus();
  if (me) {
    box.innerHTML = `<div class="sect" style="padding-top:0">训练账户</div><div class="list"><div class="li"><span class="av lg">${esc([...USER][0]?.toUpperCase() || '?')}</span><span class="lt">${esc(USER)}<small>训练记录按用户名保存</small></span><button class="ib txt" id="acSwitch">切换</button></div></div><div class="sect">网易云音乐</div>` + `<div class="ncmMe"><img src="${coverOf(me.avatar, 120)}" alt=""><b>${esc(me.name)}</b><span>${me.vip ? '黑胶 VIP · 可播放 VIP 歌曲' : '普通账号'}</span></div>
      <div class="btns"><button class="danger" id="ncmOut">退出网易云登录</button></div>`;
    bindAcct();
    $('ncmOut').onclick = async () => { try { await ncm('/logout'); } catch {} lsSet('ncmCookie', ''); ncmSheet.hidden = true; toast('已退出网易云'); MV.me = null; MV.myPl = []; self.ncmMe = null; showUser(); if (TAB === 'music') renderMusic(); };
    return;
  }
  box.innerHTML = `<div class="sect" style="padding-top:0">训练账户</div><div class="list"><div class="li"><span class="av lg">${esc([...USER][0]?.toUpperCase() || '?')}</span><span class="lt">${esc(USER)}<small>训练记录按用户名保存</small></span><button class="ib txt" id="acSwitch">切换</button></div></div><div class="sect">网易云音乐</div>` + `<div class="seg ncmSeg"><button class="on" data-lg="qr">扫码登录</button><button data-lg="sms">验证码登录</button></div><div id="ncmPane"></div>`;
  bindAcct();
  const pane = $('ncmPane');
  const showQr = async () => {
    pane.innerHTML = '<div class="hint" style="text-align:center;padding:20px">生成二维码…</div>';
    try {
      const k = (await ncm('/login/qr/key', { timestamp: Date.now() })).data?.unikey;
      const c = await ncm('/login/qr/create', { key: k, qrimg: true, timestamp: Date.now() });
      pane.innerHTML = `<div class="qr"><img src="${c.data.qrimg}" alt="登录二维码"></div><div class="hint" style="text-align:center" id="qrSt">用网易云音乐 App 扫码(可用另一台手机,或截图后在网易云 App 里扫相册)</div>
        <div class="btns"><a class="btnlink" href="${esc(c.data.qrurl)}" target="_blank" rel="noopener">在本机网易云 App 中打开</a></div>`;
      qrTimer = setInterval(async () => {
        if (ncmSheet.hidden) return clearInterval(qrTimer);
        try {
          const s = await ncm('/login/qr/check', { key: k, timestamp: Date.now() });
          if (s.code === 802) $('qrSt').textContent = '已扫码,请在手机上确认登录';
          if (s.code === 800) { clearInterval(qrTimer); $('qrSt').textContent = '二维码已过期,切换一下标签重新生成'; }
          if (s.code === 803) { clearInterval(qrTimer); lsSet('ncmCookie', s.cookie); toast('网易云登录成功'); openNcmLogin(); MV.me = undefined; if (TAB === 'music') openMusic(); }
        } catch {}
      }, 2500);
    } catch (e) { pane.innerHTML = `<div class="note bad">二维码生成失败:${esc(e.message)}</div>`; }
  };
  const showSms = () => {
    pane.innerHTML = `<div class="list"><div class="li inp"><input id="lgPhone" type="tel" inputmode="tel" placeholder="手机号" autocomplete="tel"></div>
      <div class="li inp"><input id="lgCode" type="text" inputmode="numeric" placeholder="短信验证码" autocomplete="one-time-code"><button class="ib txt" id="lgSend">获取验证码</button></div></div>
      <div class="btns"><button class="pri" id="lgGo">登录</button></div><div id="lgNote" class="note"></div>`;
    const note = (t, c = '') => { $('lgNote').textContent = t; $('lgNote').className = 'note ' + c; };
    $('lgSend').onclick = async () => {
      const ph = $('lgPhone').value.trim(); if (!/^1\d{10}$/.test(ph)) return note('请输入 11 位手机号', 'bad');
      try { const j = await ncm('/captcha/sent', { phone: ph, timestamp: Date.now() }); if (j.code !== 200) throw new Error(j.message || j.msg || '发送失败'); note('验证码已发送', 'ok'); } catch (e) { note(e.message, 'bad'); }
    };
    $('lgGo').onclick = async () => {
      const ph = $('lgPhone').value.trim(), code = $('lgCode').value.trim(); if (!ph || !code) return note('请填写手机号和验证码', 'bad');
      try { const j = await ncm('/login/cellphone', { phone: ph, captcha: code, timestamp: Date.now() }); if (j.code !== 200 || !j.cookie) throw new Error(j.message || j.msg || '登录失败'); lsSet('ncmCookie', j.cookie); toast('网易云登录成功'); openNcmLogin(); MV.me = undefined; if (TAB === 'music') openMusic(); }
      catch (e) { note(e.message + '(网易云风控时请改用扫码登录)', 'bad'); }
    };
  };
  box.querySelectorAll('[data-lg]').forEach(b => b.onclick = () => { box.querySelectorAll('[data-lg]').forEach(x => x.classList.toggle('on', x === b)); clearInterval(qrTimer); b.dataset.lg === 'qr' ? showQr() : showSms(); });
  showQr();
}
$('ncmDone').onclick = () => { ncmSheet.hidden = true; clearInterval(qrTimer); };
ncmSheet.addEventListener('click', e => { if (e.target === ncmSheet) { ncmSheet.hidden = true; clearInterval(qrTimer); } });

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
  if (TAB === 'music' && t !== 'music') { MV.edit = false; MV.sel.clear(); MV.mode = null; } // 试听继续播放,迷你播放条跟随
  TAB = t; document.body.dataset.tab = t;
  $('tabbar').style.setProperty('--i', Object.keys(TABS).indexOf(t));
  for (const [k, [id, title]] of Object.entries(TABS)) {
    $(id).hidden = k !== t;
    if (k === t) { $('pageTitle').textContent = title; document.title = title + ' · 跟练打卡'; }
  }
  document.querySelectorAll('.tab').forEach(b => { if (b.dataset.tab === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  try { history.replaceState(null, '', location.pathname + location.search + '#' + t); } catch {}
  scrollTo(0, 0);
  syncMini();
  if (t === 'music') { MV.pl = null; MV.view = ''; openMusic(); } else if (t === 'hist') openHistory(); else if (t === 'work') renderWorkouts();
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

ncmStatus();
init().then(() => { const h = location.hash.slice(1); if (TABS[h] && h !== 'train') switchTab(h); });
if (!USER) showLogin(false);
requestAnimationFrame(loop);
