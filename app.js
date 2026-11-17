import { FilesetResolver, PoseLandmarker } from './lib/package/vision_bundle.mjs';

const $ = id => document.getElementById(id);
const CNUM = '一二三四五六七八九十';
const gname = g => g < 10 ? `第${CNUM[g]}组` : `第${g + 1}组`;
const cam = $('cam'), overlay = $('overlay'), ctx = overlay.getContext('2d'), ref = $('ref'), bgm = $('bgm'), restAudio = $('restAudio');
// 示范画面(视频,可选/静音)与独立音频(bgm)一起按当前动作的片段同步;视频缺失也不影响声音
ref.muted = true;
let refOk = true;
ref.addEventListener('error', () => { refOk = false; ref.closest('.card').style.display = 'none'; document.body.classList.add('hideRef'); $('fsRef').style.display = 'none'; });
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
let bgmReady = false, DATA, WID, landmarker = null;
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
  const sel = $('wsel'); sel.innerHTML = list.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join(''); sel.value = WID;
  sel.onchange = () => { try { localStorage.setItem('workout', sel.value); } catch {} location.href = location.pathname + '?w=' + encodeURIComponent(sel.value); };
  const base = `workouts/${WID}/`;
  DATA = await (await fetch(base + 'workout.json')).json();
  DATA.groups ??= 1; DATA.movesPerGroup ??= DATA.templates.length; DATA.groupRestSec ??= 120; DATA.restSec ??= 10;
  document.title = `${DATA.name} · 跟练打卡`;
  $('title').textContent = `🏋️ ${DATA.name} · ${NG()}组 × ${NM()}动作 × ${DATA.reps}次`;
  $('cntMax').textContent = '/' + DATA.reps; $('sDone').textContent = `0/${NMOV()}`;
  if (DATA.counter && DATA.counter !== 'kneeLift') { setMsg(`「${DATA.name}」需要的识别方式(${DATA.counter})暂未支持`, 'bad'); btn.textContent = label; return; }
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
const syncRef = () => { $('fsRef').textContent = document.body.classList.contains('hideRef') ? '显示示范' : '隐藏示范'; };
$('fsRef').onclick = () => { document.body.classList.toggle('hideRef'); try { localStorage.setItem('hideRef', document.body.classList.contains('hideRef') ? '1' : '0'); } catch {} syncRef(); };
syncRef();
const syncFS = () => { $('fsPause').textContent = $('btnPause').textContent; $('fsExit').textContent = stage.classList.contains('full') ? '退出全屏' : '全屏'; };
$('fsPause').onclick = () => { $('btnPause').click(); syncFS(); };
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
  $('cnt').textContent = S.rep; $('hTimer').textContent = fmt(S.moveTime); $('sTotal').textContent = fmt(S.totalTime);
  $('sDone').textContent = S.doneSet.size + '/' + NMOV(); $('sL').textContent = S.sideCnt.L; $('sR').textContent = S.sideCnt.R;
}

// ---------- 流程 ----------
function resetCount() { S.rep = 0; S.flags = { L: false, R: false }; S.sideCnt = { L: 0, R: 0 }; S.moveTime = 0; S.lifts = { L: mkLift(), R: mkLift() }; }
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
  setMsg('开始!左右腿各抬一次算 1 次', '');
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
  return { workout: WID, workout_name: DATA.name, day: dayOf(t0), started_at: t0.toISOString(), duration_sec: Math.round(S.totalTime), active_sec: Math.round(S.active), moves_done: S.doneSet.size, moves, images };
}
function endWorkout() {
  if (S.phase === 'idle') return;
  if (S.phase === 'active') {
    if (S.moveTime > 1 && S.moveTimes[idx()] === undefined) { S.moveTimes[idx()] = S.moveTime; S.moveReps[idx()] = S.rep; }
    if (S.imgs[S.g] === undefined) capture(S.g);
  }
  S.phase = 'done'; mPause(); hideBig(); renderChips(); exitFS(); stage.classList.remove('live'); $('wsel').disabled = false;
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
    const html = list.map(s => `<div class="sess"><b>${esc(new Date(s.started_at).toLocaleTimeString())}</b> · 总用时 ${fmtDur(s.duration_sec)} · 动作用时 ${fmtDur(s.active_sec)} · ${esc(s.workout_name || '')} · 完成 ${s.moves_done} 个动作
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
    const f = l.feat; let hint = `「${tpl().name}」手部/抬腿不标准,请对照右侧示范`;
    if (DATA.id === 'fatburn' && S.m === 1) hint = f[7] > -0.12 ? '提膝下压:膝盖再抬高一点(至少到腰部)' : Math.max(f[0], f[1]) > 0.75 ? '提膝下压:双手要按到抬起的膝盖上' : hint;
    setMsg(all[0][0] < lim && all[0][1] !== S.m ? `这个更像「${DATA.templates[all[0][1]].name}」,请做「${tpl().name}」` : hint, 'bad');
  }
  if ($('debug').checked) $('dbgBox').textContent = `side=${side} score=${sc.toFixed(2)} lim=${lim}\nfeat=` + l.feat.map(v => v.toFixed(2)).join(' ') + '\n' + DATA.templates.map(t => t.name + ':' + score(t, l.feat).toFixed(2)).join('  ');
}
function track(lm) {
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
    const ok = lm && [11, 12, 23, 24, 25, 26].every(i => (lm[i].visibility ?? 1) > 0.4);
    if (!ok && S.phase === 'active') setMsg('请后退,让头到膝盖都进入画面', 'bad');
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
  S.paused = !S.paused; $('btnPause').textContent = S.paused ? '继续' : '暂停'; syncFS();
  if (S.paused) mPause(); else if (S.phase === 'active') mPlay(); else if (S.phase === 'rest' && S.groupBreak) playRestMusic();
  setMsg(S.paused ? '已暂停' : '继续');
};
addEventListener('keydown', e => { if (e.key === 'n') $('btnSkip').click(); if (e.key === ' ') { e.preventDefault(); $('btnPause').click(); } });

$('btnStart').onclick = async () => {
  enterFS(); $('wsel').disabled = true;
  try { actx ??= new AudioContext(); actx.resume(); } catch {}
  bgm.muted = true; { const up = bgm.play(); if (up) up.then(() => { bgm.pause(); bgm.muted = !$('sound').checked; }).catch(() => {}); } // 解锁音乐(iOS)
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
    stage.classList.add('live'); syncFS();
    S.g = 0; S.m = 0; startRest();
  } catch (err) { exitFS(); $('wsel').disabled = false; setMsg('启动失败:' + err.message + '(请用 http://localhost:8080 打开并允许摄像头)', 'bad'); $('btnStart').disabled = false; console.error(err); }
};

// ---------- 休息音乐(用户上传 / 导入) ----------
let tracks = [], lastTrackId = null;
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
  if (!forceAll && c !== 'all') { const t = tracks.find(x => String(x.id) === c); if (t) return t; }
  const pool = tracks.length > 1 ? tracks.filter(x => x.id !== lastTrackId) : tracks;
  return pool[Math.floor(Math.random() * pool.length)];
}
async function prepareRest(forceAll = false) {
  const t = pickTrack(forceAll);
  if (!t) { restAudio.removeAttribute('src'); restAudio.load(); return; }
  try { restAudio.src = await trackURL(t); lastTrackId = t.id; restAudio.loop = !forceAll && chosen() !== 'all'; } catch (e) { console.warn('休息音乐加载失败', e); }
}
async function loadTracks() {
  const r = await fetch('api/music'); const j = await r.json();
  tracks = Array.isArray(j) ? j : [];
  await prepareRest();
}
function playRestMusic() {
  if (!tracks.length) { $('bigS').textContent += '(还没有休息音乐,训练结束后可在页头「休息音乐」里添加)'; return; }
  restAudio.muted = false;
  restAudio.play().catch(() => setMsg('休息音乐被浏览器拦截,点一下"音乐"按钮开启', 'bad'));
}
restAudio.addEventListener('ended', async () => { await prepareRest(); if (S.phase === 'rest' && S.groupBreak && !S.paused) playRestMusic(); });
$('bSkipRest').onclick = () => { if (S.phase === 'rest') S.restLeft = 0; };
$('bPauseMusic').onclick = () => { if (restAudio.paused) playRestMusic(); else restAudio.pause(); $('bPauseMusic').textContent = restAudio.paused ? '▶ 音乐' : '⏸ 音乐'; };
$('bNextTrack').onclick = async () => { await prepareRest(true); playRestMusic(); $('bPauseMusic').textContent = '⏸ 音乐'; };

async function openMusic() {
  try { await loadTracks(); } catch {}
  const c = chosen();
  const rows = tracks.map(t => `<div class="dayrow" style="cursor:default"><label style="flex:1;gap:8px;color:var(--fg)"><input type="radio" name="rm" value="${t.id}" ${String(t.id) === c ? 'checked' : ''}>${esc(t.title)} <span style="color:var(--mut)">${mb(t.size)}</span></label>
    <span><button data-prev="${t.id}">试听</button> <button class="danger" data-del="${t.id}">删除</button></span></div>`).join('');
  openModal(`<h2>休息音乐</h2><div class="sub">每组结束后会中场休息 2 分钟,期间播放这里选中的音乐。</div>
    <div class="btns" style="margin-top:6px"><button id="mUpload" class="pri">上传音频/视频文件</button></div>
    <input id="mFile" type="file" accept=".mp3,.m4a,.aac,.wav,.ogg,.flac,.mp4,audio/*,video/mp4" style="display:none">
    <div style="display:flex;gap:8px;margin-top:10px"><input id="mLink" placeholder="粘贴音频直链(以 http 开头的 mp3/m4a 文件地址)" style="flex:1;min-width:0;padding:9px;border-radius:8px;border:1px solid var(--line);background:#0003;color:var(--fg)"><button id="mImport">导入</button></div>
    <div class="note" style="color:var(--mut)">可直接粘贴抖音分享文字/链接(需服务器已配置 PARSER_URL 并启动 media-parser,见 README);未配置时请在抖音里「保存视频」,再点上方上传该文件(mp4 也行,只播放声音)。</div>
    <div id="note" class="note"></div>
    <div style="margin:12px 0 6px;font-size:13px;color:var(--mut)">播放方式</div>
    <div class="dayrow" style="cursor:default"><label style="flex:1;gap:8px;color:var(--fg)"><input type="radio" name="rm" value="all" ${c === 'all' ? 'checked' : ''}>全部随机播放</label></div>
    ${rows || '<div class="sub">还没有音乐,先上传一个吧</div>'}
    <div class="btns"><button id="bClose">完成</button></div>`, true);
  $('bClose').onclick = () => { restAudio.pause(); closeModal(); prepareRest(); };
  mbox.querySelectorAll('input[name=rm]').forEach(r => r.onchange = () => { try { localStorage.setItem('restMusic', r.value); } catch {} });
  $('mUpload').onclick = () => $('mFile').click();
  $('mFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    setNote(`上传中…(${mb(f.size)})`);
    try {
      const r = await fetch('api/music?name=' + encodeURIComponent(f.name), { method: 'PUT', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      openMusic();
    } catch (err) { setNote('上传失败:' + err.message, 'bad'); }
  };
  $('mImport').onclick = async () => {
    const url = $('mLink').value.trim(); if (!url) return setNote('请先粘贴链接', 'bad');
    setNote('正在下载…'); $('mImport').disabled = true;
    try {
      const r = await fetch('api/music/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      openMusic();
    } catch (err) { setNote(err.message, 'bad'); $('mImport').disabled = false; }
  };
  mbox.querySelectorAll('[data-prev]').forEach(b => b.onclick = async () => {
    const t = tracks.find(x => String(x.id) === b.dataset.prev); if (!t) return;
    if (!restAudio.paused && restAudio.dataset.prev === b.dataset.prev) { restAudio.pause(); b.textContent = '试听'; return; }
    try { restAudio.src = await trackURL(t); restAudio.loop = false; restAudio.dataset.prev = b.dataset.prev; restAudio.muted = false; await restAudio.play(); b.textContent = '停止'; } catch (err) { setNote('无法播放:' + err.message, 'bad'); }
  });
  mbox.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('确定删除这首音乐吗?')) return;
    restAudio.pause(); await fetch('api/music/' + b.dataset.del, { method: 'DELETE' });
    const old = blobCache.get(+b.dataset.del); if (old) { URL.revokeObjectURL(old); blobCache.delete(+b.dataset.del); }
    if (chosen() === b.dataset.del) { try { localStorage.setItem('restMusic', 'all'); } catch {} }
    openMusic();
  });
}
$('btnMusic').onclick = openMusic;
init();
requestAnimationFrame(loop);
