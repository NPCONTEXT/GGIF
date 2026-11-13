// 单张编辑页：拖入 → 预览 + 裁时长 → 用途 →「一键」或「自定义」→ 体积 → 导出（可取消）。
// 10-18 作者：只留「一键 / 自定义」两种；自定义把全部参数一次摊开（用一键的结果预填，所见即所得）；
// 裁画面要锁定才生效、有明确反馈；体积按当前参数实时真编（「我都手动了，肯定不在乎是否快速高效和性能开销了，只在乎我能不能调对」）。
const $ = (id) => document.getElementById(id);
const api = window.gifkit;
const CMD = (e) => (api?.platform === 'win32' ? e.ctrlKey : e.metaKey); // ⌘ 那些组合键：Windows 上是 Ctrl（Windows版 11-08）

// 一键的三档（引擎 opts.mode）。说明只留一句，细节在「?」里。
const SPEEDS = [
  { id: 'fast', name: '极速', sub: '约 10 秒', hint: '日常素材 10 秒内；难压的自动多花点时间' },
  { id: 'standard', name: '标准', sub: '慢一点', hint: '每次都检查画质，慢一点' },
  { id: 'best', name: '极限', sub: '最慢最清楚', hint: '最慢（可能几分钟），画质最好' },
];
// 牌子上的图标（10-22 重做）
const TILE_ICON = {
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M3.5 15l4.5-4 4 3.5 3-2.5 5.5 4.5"/><circle cx="15.5" cy="9.5" r="1.4"/></svg>',
  paste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="6" y="4.5" width="12" height="16" rx="2.5"/><path d="M9.5 4.5V3.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v.7"/><path d="M9 11h6M9 14.5h4"/></svg>',
};
const SPEED_ICON = {
  fast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M13.5 3L5.5 13.5H12L10.5 21l8-10.5H12z"/></svg>',
  standard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7l-2.5 6a3 3 0 0 0 5 0zM19 7l-2.5 6a3 3 0 0 0 5 0z"/></svg>',
  best: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 4h10l4 5-9 11L3 9z"/><path d="M3 9h18M9.5 4L12 9l2.5-5M12 9v11"/></svg>',
};

// 自定义参数的默认值（范围和引擎 manual.js 的 MANUAL_LIMITS 一致）
const CUSTOM_DEF = {
  width: 900, fps: 10, encoder: 'lessgif', qualityAuto: true, quality: 70, colors: 256, dither: 0.5, lossy: 0,
  speed: 1, hold: 0, loop: 0, saturation: 1, color: 'auto', fill: true,
};

const S = {
  file: null, kind: null, duration: 0, srcW: 0, srcH: 0, srcFps: 0, start: 0, end: 0,
  preset: null, speed: 'fast', mode: 'auto',
  custom: { ...CUSTOM_DEF }, customReady: false, // customReady：这个文件已经预填过（之后切来切去不再覆盖用户改的值）
  crop: null, // 已锁定（生效）的裁切
  cropDraft: null, cropEditing: false, // 正在拖的框（虚线，还没生效）
  ratioLock: true,
  lastChosen: null, // 最近一次一键导出的选档（预填自定义用）
  busy: false, estSeq: 0, liveSeq: 0, liveKey: null, presets: [], cfg: null,
  editJob: null, // 从菜单栏列表点进来编辑的那一条：导出后回写它
  // 打标（10-19 深夜，作者选 A）：切出来的段（marks.cjs），空 = 没切过（整个文件是一段，起止就是 start / end）；sel 选中第几段（-1 没选）
  segs: [], sel: -1, undo: [], markSet: null, markRec: false, markPrefix: '', tlOpen: false, progPrefix: '',
  // 多选（11.14 多选导出，11-06 作者选 A）：pick 多选的几段（升序，两段以上才算，这时 sel = -1），anchor 上次点的段号（⇧点从它连选），
  // joinLoaded 从菜单栏「拼起来的那一行」点进来时记下它的行号和几段（选的还是这几段时，导出归到那一行）
  pick: [], anchor: -1, joinLoaded: null,
};
const M = window.Marks;
// 这次运行里切过的文件 → 段：同一个文件重新打开，刀还在（换别的文件不带过去）
const MARKS_MEM = new Map();
const markKey = () => `${S.file}|${S.duration}`;
const fmtClock = (s) => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };

const fmtMB = (b) => `${(b / 1e6).toFixed(2)} MB`;
const fmtSec = (s) => `${s.toFixed(1)}`;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
// 输出宽度往下取偶数：原片是奇数宽（比如 899）时按四舍五入会变成 900，比原片宽、导出时冒出「不放大」的提示（10-19 晚查出）
const evenDown = (x) => Math.max(2, Math.floor(x / 2) * 2);
const clampNum = (v, lo, hi, fallback) => {
  const x = Number(v);
  if (v === '' || !Number.isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, x));
};
const presetLimit = () => S.presets.find((x) => x.id === S.preset)?.limit || 9.9e6;

async function init() {
  S.cfg = await api.info();
  S.presets = S.cfg.presets;
  S.preset = S.cfg.defaultPreset;
  S.speed = S.cfg.defaultSpeed || 'fast'; // 设置里「记住主界面的档位和速度」开着就是上次的（10-22 设置卷）
  S.prefs = S.cfg.prefs || null;
  if (S.prefs) CUSTOM_DEF.fill = S.custom.fill = S.prefs.fill; // 自定义里的凑帧默认跟着设置的总开关
  if (S.cfg.missing.length) {
    $('missing').textContent = `缺外部程序：${S.cfg.missing.join('、')}`;
    $('missing').classList.remove('hidden');
  }
  for (const box of [$('presets'), $('c_presets')]) {
    for (const p of S.presets) {
      const b = document.createElement('button');
      const mb = (p.limit / 1e6).toFixed(1);
      const dot = p.id === 'paste' ? 'paste' : 'upload';
      if (box.id === 'c_presets') {
        b.innerHTML = `<i class="dot ${dot}"></i>${mb}MB`;
        b.title = p.name;
      } else {
        // 大牌子：图标 + 名字 + 一句小字 + 大号上限；说明平时收着，悬停才展开（原型同款）
        const name = p.name.replace('公众号 · ', '');
        b.className = `tile ${dot}`;
        b.innerHTML = `<span class="tIcon">${TILE_ICON[dot]}</span><span class="tName">${esc(name)}<small>${dot === 'paste' ? '复制粘贴到公众号' : '公众号编辑器上传'}</small></span><span class="tVal">${mb}<small>MB</small></span><span class="tHint">${esc(p.hint || '')}</span>`;
      }
      b.dataset.id = p.id;
      b.onclick = () => { if (S.busy) return; S.preset = p.id; renderPresets(); refreshSize(); api.setPref({ mainPreset: p.id }); }; // 导出时不改（10-20 审查 C2）
      box.appendChild(b);
    }
  }
  for (const box of [$('speeds')]) {
    for (const sp of SPEEDS) {
      const b = document.createElement('button');
      b.className = 'sp';
      b.innerHTML = `${SPEED_ICON[sp.id]}${sp.name}<small>${sp.sub}</small>`;
      b.dataset.speed = sp.id;
      b.onclick = () => { if (S.busy) return; S.speed = sp.id; renderSpeeds(); api.setPref({ mainSpeed: sp.id }); };
      box.appendChild(b);
    }
  }
  $('helpPresets').innerHTML = `<ul>${S.presets.map((p) => `<li><b>${esc(p.name)}（${(p.limit / 1e6).toFixed(1)}MB）</b>：${esc(p.hint)}</li>`).join('')}</ul>`;
  renderPresets();
  renderSpeeds();
  bindUi();
  bindCustom();
  bindHandoff();
  bindSettings();
  setTimeline(Boolean(S.cfg.timelineOpen), { save: false });
  requestAnimationFrame(() => requestAnimationFrame(() => $('trim').classList.remove('noanim')));
  if (S.cfg.debugOpen) await openFile(S.cfg.debugOpen);
  if (S.cfg.debugBatch) {
    // 调试：当作在主界面拖进这几个（或文件夹），等这批压完、提示换成汇总后截图
    api.onBatchDone(() => setTimeout(() => api.debugShot(), 400));
    await handoff(S.cfg.debugBatch);
  }
  if (S.cfg.debugHelp) { openSettings(S.cfg.debugHelp === 'help' ? 'help' : 'set'); setTimeout(() => api.debugShot(), 1000); }
}

function renderPresets() {
  for (const b of [...$('presets').children, ...$('c_presets').children]) b.classList.toggle('on', b.dataset.id === S.preset);
}

function renderSpeeds() {
  for (const b of [...$('speeds').children]) b.classList.toggle('on', b.dataset.speed === S.speed);
  $('speedHint').textContent = SPEEDS.find((x) => x.id === S.speed).hint;
}

function bindUi() {
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (S.draggingOut) { e.dataTransfer.dropEffect = 'none'; return; } // 正在把预览往外拖：自己这里不接（9.6d）
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (S.draggingOut) { S.draggingOut = 0; return; } // 预览拖出去又在主界面里松手：不导入（9.6d）
    // 拖一个进来精修；拖多个或文件夹就交给菜单栏批量压（文件夹要在这一刻同步认出来，await 之后就读不到了）
    const isDir = [...(e.dataTransfer.items || [])].some((it) => it.webkitGetAsEntry?.()?.isDirectory);
    const paths = [...e.dataTransfer.files].map((f) => api.pathOf(f)).filter(Boolean);
    if (!paths.length) return;
    if (paths.length > 1 || isDir) await handoff(paths);
    else await openFile(paths[0]);
  });
  $('pick').onclick = pickAndOpen;
  for (const b of document.querySelectorAll('#modeTabs [data-mode]')) b.onclick = () => { if (!S.busy) setMode(b.dataset.mode); };
  bindTrim();
  bindCrop();
  bindSizeBar();
  bindPreviewDrag();
  $('export').onclick = doExport;
  $('cancel').onclick = () => { $('progressText').textContent = '正在取消…'; api.cancel(); };
  $('helpBtn').onclick = () => openSettings();
  $('helpClose').onclick = closeSettings;
  $('help').onclick = (e) => { if (e.target === $('help')) closeSettings(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      releaseFocus();
      const helpOpen = !$('help').classList.contains('hidden');
      closeSettings();
      openPanel(false);
      if (S.cropEditing) cancelCropEdit();
      else if (!helpOpen && S.sel >= 0) selectSeg(S.sel); // 取消选中的段
      else if (!helpOpen && isMulti()) pickSeg({ sel: -1, pick: [] }, -1); // 取消多选
    }
    // 切一刀（默认 ⌥空格）：在播放到的地方切一刀（作者：主界面打标，和录屏同一个键；10-22 起设置里能换）；空格本身还是播放 / 暂停
    if (H.match(e, S.prefs?.hotkeys?.mark || H.DEFAULTS.mark) && !typingIn(document.activeElement) && $('help').classList.contains('hidden') && S.file) {
      e.preventDefault();
      releaseFocus();
      if (!e.repeat && !S.busy) cutHere();
      return;
    }
    // ⌘A：切过两段以上时选中全部段（11.14，和菜单栏列表一样）；光标在输入框里照常全选文字
    if ((e.key === 'a' || e.key === 'A') && CMD(e) && !e.shiftKey && !e.altKey && !typingIn(document.activeElement) && S.file && S.segs.length >= 2 && !S.busy && $('help').classList.contains('hidden')) {
      e.preventDefault();
      pickSeg({ sel: -1, pick: S.segs.map((_, i) => i) }, -1);
      return;
    }
    // ⌘Z：撤销最后一次切 / 删（光标在输入框里时照常撤销输入）
    if ((e.key === 'z' || e.key === 'Z') && CMD(e) && !e.shiftKey && !e.altKey && !typingIn(document.activeElement) && S.file) {
      if (undoMarks()) e.preventDefault();
      return;
    }
    // 回车：和右键一样，裁画面的框锁定 / 解锁都能用（作者：「做了回车锁定，但没做回车解锁」）。不让它顺带按下刚点过的按钮
    if (e.key === 'Enter' && !typingIn(document.activeElement)) {
      if (S.cropEditing) {
        e.preventDefault();
        releaseFocus();
        lockCrop();
      } else if (S.crop && S.mode === 'custom') {
        e.preventDefault();
        releaseFocus();
        startCropEdit();
      }
    }
    // 空格：播放 / 暂停（作者）。只要不是在打字，就只管播放：不让它去按刚点过的按钮（比如再点一次「导出」）、勾复选框
    if (e.code === 'Space' && !e.altKey && !e.metaKey && !e.ctrlKey && !typingIn(document.activeElement) && $('help').classList.contains('hidden') && S.file && activeVideo()) {
      e.preventDefault();
      releaseFocus();
      if (!e.repeat) (activeVideo().paused ? playPreview : pausePreview)();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !typingIn(document.activeElement) && S.file && activeVideo()) e.preventDefault();
  });
  const v = $('video');
  // 像 GIF 一样循环放选段；暂停时不动（拖时间轴、拖把手只停在那一帧，作者：「剪切时还是要精准的不动的」）
  v.addEventListener('timeupdate', () => {
    if (!v.paused && (v.currentTime >= S.end || v.currentTime < S.start - 0.2)) v.currentTime = S.start;
    else skipGap(v);
    renderPlayhead();
  });
  // 多选时跳过没选的段（11.14）：每画一帧看一眼（timeupdate 一秒只来约 4 次，跳得晚会露出一截没选的）；不播放时不回调，不费电
  const onFrame = (_now, meta) => {
    skipGap(v, meta?.mediaTime);
    v.requestVideoFrameCallback(onFrame);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
  v.addEventListener('ended', () => {
    if (S.paused) return;
    v.currentTime = S.start;
    v.play().catch(() => {});
  });
  // 点画面：播放 / 暂停（作者）；拉裁画面的框时点击是用来拉框的，不切换
  $('drop').addEventListener('click', (ev) => {
    if (S.cropEditing || !S.file || ev.target.closest('#dropHint, .notes')) return;
    const vv = activeVideo();
    if (!vv) return;
    if (vv.paused) playPreview();
    else pausePreview();
  });
  v.addEventListener('loadedmetadata', () => renderCrop());
  // 展开 / 收起时预览框会变高变矮：裁画面的框跟着画面走（GPT 10-19 23:30 的提醒：比例、裁切范围、播放位置都不能变）
  new ResizeObserver(() => renderCrop()).observe($('drop'));
  api.onLoadJob((load) => loadJob(load));
  api.onProgress((p) => {
    if (!S.busy) return;
    const tier = p.width ? ` · ${p.width} 宽${p.fps ? `、每秒 ${p.fps} 帧` : ''}` : '';
    $('progressText').textContent = `${S.progPrefix ? `${S.progPrefix} · ` : ''}${p.stage}${tier}`;
  });
}

// ---------- 标题行的体积条 ----------
// 数字固定宽度、说明只占一行（放不下显示省略号），点一下展开下拉面板看完整说明、详情和导出结果。
// 作者：调参数时「实时预估的滚动字体没有固定宽度，会直接把下面的参数列影响抖动」。
function setSize({ cls = 'idle', big = '—', label = '', verdict = '', details = [] } = {}) {
  if (S.file && S.segs.length && verdict && (S.sel >= 0 || isMulti())) verdict = `第 ${S.sel >= 0 ? S.sel + 1 : M.pickLabel(S.pick)} 段 · ${verdict}`;
  $('sizeBox').className = `sizeBar ${cls}`;
  const m = /^([\d.]+)\s*(MB|KB|秒|段)$/.exec(String(big)); // 「12.40 MB」：数字大、单位小（原型同款）
  if (m) $('sizeBig').innerHTML = `${m[1]}<small>${m[2]}</small>`;
  else $('sizeBig').textContent = big;
  $('sizeLabel').textContent = label;
  $('sizeVerdict').textContent = verdict;
  $('sizeStatus').title = ''; // 鼠标移上去就落下完整说明（10-22 重做），不用浏览器自带的提示
  $('spTitle').textContent = label || '说明';
  $('spVerdict').textContent = verdict;
  const [a = '', b = '', c = ''] = details;
  $('sizeRange').textContent = a;
  $('tierLine').textContent = b;
  $('colorLine').textContent = c;
}

function openPanel(open = true) {
  $('sizePanel').classList.toggle('hidden', !open);
}

function bindSizeBar() {
  $('sizeStatus').onclick = () => openPanel($('sizePanel').classList.contains('hidden'));
  $('spClose').onclick = () => openPanel(false);
  document.addEventListener('mousedown', (e) => {
    if (!$('sizePanel').classList.contains('hidden') && !$('sizeBox').contains(e.target)) openPanel(false);
  });
  $('importBtn').onclick = pickAndOpen;
  $('recBtn').onclick = () => { releaseFocus(); api.recStart(); }; // 主界面会先收起来，免得挡住要录的画面
  $('clearBtn').onclick = clearEditor;
}

/** 移除：清空编辑区回到空白（不删任何文件；作者要的传统按钮）。 */
function clearEditor() {
  if (S.busy) return;
  rememberMarks();
  clearTimeout(timer);
  clearTimeout(liveTimer);
  S.estSeq++;
  S.liveSeq++;
  Object.assign(S, { file: null, kind: null, duration: 0, srcW: 0, srcH: 0, srcFps: 0, start: 0, end: 0, crop: null, cropDraft: null, cropEditing: false, customReady: false, lastChosen: null, liveKey: null, editJob: null });
  Object.assign(S, { segs: [], sel: -1, undo: [], markSet: null, markRec: false, markPrefix: '', pick: [], anchor: -1, joinLoaded: null });
  renderMarks();
  renderMarkHint();
  const v = $('video');
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.classList.add('hidden');
  $('gifPreview').removeAttribute('src');
  $('gifPreview').classList.add('hidden');
  S.paused = false;
  renderPlayState();
  $('dropHint').classList.remove('hidden');
  $('drop').classList.remove('has');
  $('fileName').textContent = '';
  $('amb').classList.remove('on');
  $('amb').style.backgroundImage = '';
  $('editNote').classList.add('hidden');
  $('trim').classList.add('hidden');
  $('thumbs').innerHTML = '';
  $('result').classList.add('hidden');
  $('export').disabled = true;
  $('clearBtn').disabled = true;
  renderCrop();
  renderCustom();
  openPanel(false);
  setSize({ verdict: '拖入或导入一个 GIF / 视频' });
}

// ---------- 一键 / 自定义 ----------
function setMode(mode) {
  S.mode = mode;
  for (const b of document.querySelectorAll('#modeTabs [data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
  $('autoPane').classList.toggle('hidden', mode !== 'auto');
  $('customPane').classList.toggle('hidden', mode !== 'custom');
  if (mode === 'custom' && !S.customReady) prefillCustom();
  if (mode !== 'custom' && S.cropEditing) cancelCropEdit();
  renderCustom();
  renderCrop();
  refreshSize(true);
}

/** 一键会先试的那一档（预估和预填用）。 */
function autoTier() {
  const top = Math.min(S.srcW || 900, 1080);
  const w = Math.min(900, top - (top % 2));
  if (S.lockFps) return { width: w, fps: S.lockFps };
  const F = S.srcFps;
  const fps = S.kind === 'gif' && F ? (S.gifSteady ? Math.round((F <= 15.5 ? F : F / Math.ceil(F / 15.5)) * 100) / 100 : Math.min(Math.round(F), 15)) : 10;
  return { width: w, fps };
}

/** 用一键的结果预填（作者：「把自动都内容都顺便打开到可调整状态」）：最近一次一键导出的选档，没有就用一键会先试的那档。 */
function prefillCustom() {
  const c = S.lastChosen;
  const t = autoTier();
  const enc = c?.encoder === 'lessgif' ? 'lessgif' : c?.encoder ? 'ffmpeg' : 'lessgif';
  const q = c?.encoder === 'lessgif' && c.q !== undefined ? c.q : c?.lossy !== undefined ? Math.round(100 - c.lossy / 2) : null;
  S.custom = {
    ...CUSTOM_DEF,
    width: evenDown(Math.min(c?.width || t.width, S.srcW || 1080)),
    fps: Math.round(c?.fps || t.fps),
    encoder: enc,
    qualityAuto: q === null,
    quality: q ?? CUSTOM_DEF.quality,
  };
  S.customReady = true;
}

function renderCustom() {
  const c = S.custom;
  $('c_width').value = c.width;
  const aspect = S.crop ? S.crop.h / S.crop.w : S.srcH && S.srcW ? S.srcH / S.srcW : 0;
  $('c_height').textContent = aspect ? `× ${Math.max(1, Math.round(c.width * aspect))}${S.crop ? '（裁后）' : ''}` : '';
  $('c_fps').value = c.fps;
  const fpsReal = S.srcFps ? Math.min(c.fps, Math.round(S.srcFps)) : c.fps;
  const n = Math.round((S.end - S.start) * fpsReal);
  $('c_frames').textContent = S.file ? `约 ${n} 帧${n > 300 ? '（超过 300，剪短或降帧率）' : ''}` : '';
  $('c_frames').classList.toggle('warnText', n > 300);
  $('c_encoder').value = c.encoder;
  $('c_qAuto').checked = c.qualityAuto;
  $('c_qRange').value = c.quality;
  $('c_q').value = c.quality;
  $('c_qRange').disabled = c.qualityAuto;
  $('c_q').disabled = c.qualityAuto;
  $('c_colors').value = c.colors;
  $('c_dither').value = c.dither;
  $('c_dither').disabled = c.encoder === 'gifski';
  $('c_dither').closest('.pctl').classList.toggle('off', c.encoder === 'gifski');
  $('c_lossyRange').value = c.lossy;
  $('c_lossy').value = c.lossy;
  $('c_speed').value = c.speed;
  $('c_hold').value = c.hold;
  $('c_loopMode').value = c.loop > 0 ? 'n' : '0';
  $('c_loop').value = c.loop > 0 ? c.loop : 1;
  $('c_loop').classList.toggle('hidden', !(c.loop > 0));
  $('c_loopUnit').classList.toggle('hidden', !(c.loop > 0));
  $('c_satRange').value = c.saturation;
  $('c_sat').value = c.saturation;
  $('c_color').value = c.color;
  $('c_fill').checked = c.fill;
  $('c_ratio').checked = S.ratioLock;
  // 裁画面的状态（明确反馈：作者「目前没有明确反馈裁切完成，只能导出后才发现裁切了」）
  $('c_crop').textContent = S.cropEditing ? '锁定' : S.crop ? '改框' : '框选';
  $('c_cropClear').classList.toggle('hidden', !S.crop && !S.cropEditing);
  $('c_cropState').textContent = S.cropEditing ? `${S.cropDraft.w}×${S.cropDraft.h} 未锁定` : S.crop ? `已裁 ${S.crop.w}×${S.crop.h}` : '整个画面';
  // 四组的摘要（10-22 重做：参数收成四组，平时只看一行）
  const hh = aspect ? Math.max(1, Math.round(c.width * aspect)) : null;
  const encName = { lessgif: 'lessgif', ffmpeg: 'ffmpeg + gifsicle', gifski: 'gifski' }[c.encoder] || c.encoder;
  $('g_view').textContent = `${c.width}${hh ? `×${hh}` : ' 宽'} · 每秒 ${c.fps} 帧${S.crop ? ` · 已裁 ${S.crop.w}×${S.crop.h}` : ''}`;
  $('g_enc').textContent = `${encName} · 画质${c.qualityAuto ? '自动' : ` ${c.quality}`} · ${c.colors} 色${c.encoder !== 'gifski' ? ` · 抖动 ${c.dither}` : ''}${c.lossy > 0 ? ` · 额外有损 ${c.lossy}` : ''}`;
  $('g_play').textContent = `${c.speed}× · ${c.hold > 0 ? `末帧停 ${c.hold} 秒` : '末帧不停留'} · ${c.loop > 0 ? `放 ${c.loop} 遍` : '无限循环'}`;
  $('g_etc').textContent = `饱和度 ${c.saturation} · 色彩${{ auto: '自动', none: '不转', p3: '按 P3 转' }[c.color] || c.color} · ${c.fill ? '凑到 61 帧' : '不凑帧'}`;
  const notes = [];
  if (c.encoder === 'gifski') notes.push('gifski 没有抖动选项；颜色数编完用 gifsicle 减。');
  if (!c.qualityAuto) notes.push('编码画质固定时，超过上限就不出文件，体积框会显示超了多少。');
  $('c_hint').textContent = notes.join(' ');
  if (S.segs.length) renderMarks(); // 帧率、一键 / 自定义改了，「太长」的线跟着变
}

function bindCustom() {
  for (const h of document.querySelectorAll('#customPane .grpHead')) {
    h.onclick = () => {
      const g = h.closest('.grp');
      const was = g.classList.contains('open');
      for (const x of document.querySelectorAll('#customPane .grp')) x.classList.remove('open');
      if (!was) g.classList.add('open');
      releaseFocus();
    };
  }
  const set = (k, v, { live = true } = {}) => {
    if (S.busy) {
      renderCustom(); // 导出时不改参数：输入框退回原来的值（10-20 审查 C2）
      return;
    }
    S.custom[k] = v;
    renderCustom();
    if (live) refreshSize();
  };
  const num = (id, k, lo, hi, step = 1) => {
    $(id).addEventListener('change', () => {
      let v = clampNum($(id).value, lo, hi, S.custom[k]);
      v = step >= 1 ? Math.round(v / step) * step : Math.round(v * 100) / 100;
      set(k, v);
    });
  };
  $('c_width').addEventListener('change', () => set('width', evenDown(clampNum($('c_width').value, 100, Math.min(1080, S.crop?.w || S.srcW || 1080), S.custom.width))));
  num('c_fps', 'fps', 1, 50);
  $('c_encoder').onchange = () => set('encoder', $('c_encoder').value);
  $('c_qAuto').onchange = () => set('qualityAuto', $('c_qAuto').checked);
  $('c_qRange').oninput = () => { $('c_q').value = $('c_qRange').value; };
  $('c_qRange').onchange = () => set('quality', Number($('c_qRange').value));
  num('c_q', 'quality', 0, 100);
  num('c_colors', 'colors', 16, 256);
  num('c_dither', 'dither', 0, 1, 0.05);
  $('c_lossyRange').oninput = () => { $('c_lossy').value = $('c_lossyRange').value; };
  $('c_lossyRange').onchange = () => set('lossy', Number($('c_lossyRange').value));
  num('c_lossy', 'lossy', 0, 200);
  num('c_speed', 'speed', 0.5, 2, 0.05);
  num('c_hold', 'hold', 0, 10, 0.5);
  $('c_loopMode').onchange = () => set('loop', $('c_loopMode').value === 'n' ? Math.max(1, Number($('c_loop').value) || 1) : 0);
  num('c_loop', 'loop', 1, 100);
  $('c_satRange').oninput = () => { $('c_sat').value = $('c_satRange').value; };
  $('c_satRange').onchange = () => set('saturation', Number($('c_satRange').value));
  num('c_sat', 'saturation', 0.5, 1.5, 0.05);
  $('c_color').onchange = () => set('color', $('c_color').value);
  $('c_fill').onchange = () => set('fill', $('c_fill').checked);
  $('c_ratio').onchange = () => { S.ratioLock = $('c_ratio').checked; };
  $('c_crop').onclick = () => (S.cropEditing ? lockCrop() : startCropEdit());
  $('c_cropClear').onclick = clearCrop;
}

/** 自定义的参数 → 引擎的 manual（等于默认的不传，引擎也当自动）。 */
function customManual() {
  const c = S.custom;
  const m = { encoder: c.encoder, width: c.width, fps: c.fps };
  if (!c.qualityAuto) m.quality = c.quality;
  if (c.colors < 256) m.colors = c.colors;
  if (c.encoder !== 'gifski') m.dither = c.dither;
  if (c.lossy > 0) m.lossy = c.lossy;
  if (c.speed !== 1) m.speed = c.speed;
  if (c.hold > 0) m.hold = c.hold;
  if (c.loop > 0) m.loop = c.loop;
  if (c.saturation !== 1) m.saturation = c.saturation;
  return m;
}

/** 导出（和实时真编）的参数。一键不带裁画面（裁画面只在自定义里）。 */
function exportArgs() {
  const a = { file: S.file, start: S.start, dur: curDur(), preset: S.preset };
  const parts = curParts();
  if (parts) a.ranges = parts; // 多选：按时间顺序拼成一张（11.14）
  if (S.mode === 'custom') {
    Object.assign(a, { mode: 'fast', crop: S.crop || undefined, fill: S.custom.fill, color: S.custom.color === 'auto' ? undefined : S.custom.color, manual: customManual() });
  } else {
    Object.assign(a, { mode: S.speed, fill: S.prefs?.fill !== false });
  }
  return a;
}
const liveKeyOf = (a) => JSON.stringify({ ...a, edit: undefined, groupId: undefined });

/** 参数变了：一键刷新预估，自定义按当前参数真编一次。 */
function refreshSize(now) {
  if (!S.file) return;
  if (S.segs.length && S.sel < 0 && !isMulti()) {
    showSegsSummary();
    return;
  }
  if (S.mode === 'custom') scheduleLive(now);
  else scheduleEstimate(now);
}

// ---------- 自定义：实时真编 ----------
let liveTimer = null;
function scheduleLive(now) {
  if (!S.file || S.mode !== 'custom' || S.busy) return; // 导出时不起实时真编（10-20 审查 C4：锁裁画面框会顺带起一次，和导出同时编两遍）
  clearTimeout(liveTimer);
  const seq = ++S.liveSeq;
  S.liveKey = null;
  setSize({ cls: 'busy', big: $('sizeBig').textContent, label: '实测', verdict: '参数改了，停一下就按当前参数真编一次…' });
  liveTimer = setTimeout(() => runLive(seq), now ? 0 : 800);
}

async function runLive(seq) {
  if (S.busy) return; // 导出开始前排上的那次也不跑了
  const args = exportArgs();
  const key = liveKeyOf(args);
  const t0 = Date.now();
  const big0 = $('sizeBig').textContent;
  const tick = () => { if (seq === S.liveSeq) setSize({ cls: 'busy', big: big0, label: '实测', verdict: `正在按当前参数编码… ${Math.floor((Date.now() - t0) / 1000)} 秒` }); };
  tick();
  const clock = setInterval(tick, 500);
  let r;
  try {
    r = await api.liveEncode({ ...args, liveKey: key });
  } catch (e) {
    r = { ok: false, reason: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  } finally {
    clearInterval(clock);
  }
  if (seq !== S.liveSeq || r.cancelled) return; // 参数又变了，这次作废
  const cap = presetLimit();
  const capMB = (cap / 1e6).toFixed(1);
  const sec = r.ms ? `编了 ${(r.ms / 1000).toFixed(1)} 秒` : '';
  const notes = (r.notes || []).join('；');
  if (r.bytes) {
    const fits = r.bytes <= cap;
    S.liveKey = key;
    setSize({
      cls: fits ? 'ok' : 'bad', big: fmtMB(r.bytes), label: '实测',
      verdict: `${fits ? `能装进 ${capMB}MB` : `超过 ${capMB}MB 上限`} · ${r.width}×${r.height} · ${r.frames} 帧 · ${sec}`,
      details: [notes],
    });
  } else {
    setSize({
      cls: 'bad', big: r.overBytes ? fmtMB(r.overBytes) : '—', label: '实测',
      verdict: r.overBytes ? `超过 ${capMB}MB 上限，没出文件 · ${sec}` : `没编出来：${r.reason || ''}`,
      details: [r.overBytes ? r.reason || '' : '', notes],
    });
  }
  if (S.cfg.debugCustom && !S.debugLiveDone) {
    S.debugLiveDone = true;
    if (S.cfg.debugExport) await doExport();
    if (S.cfg.debugPanel) openPanel(true);
    setTimeout(() => api.debugShot(), 300);
  }
}

// ---------- 载入素材 ----------
/** 菜单栏列表双击 / 编辑：载入素材，带上次的用途、模式和参数。 */
async function loadJob(load) {
  if (S.busy) return;
  S.preset = load.preset || S.preset;
  if (SPEEDS.some((x) => x.id === load.mode)) S.speed = load.mode;
  renderPresets();
  renderSpeeds();
  await openFile(load.file, { keepEdit: true });
  S.editJob = load;
  if (load.marks?.segs?.length) {
    // 从菜单栏打开某一段：条上是同一组的全部段，这一段选好（TODO 2.74）；在这里改的会同步回菜单栏那几行
    S.segs = load.marks.segs.map((x) => ({ start: x.start, end: x.end, gid: x.gid, done: Boolean(x.done), orig: { start: x.start, end: x.end } }));
    // 拼起来的那一行（11.14）：还原成拼的几段加中间没选的，选好那几段；导出时还是这几段就归到这一行
    const pick = (load.marks.pick || []).length >= 2 ? [...load.marks.pick] : [];
    S.sel = pick.length ? -1 : Math.max(0, S.segs.findIndex((x) => x.gid === load.groupId));
    Object.assign(S, { undo: [], markSet: load.marks.set, markRec: Boolean(load.marks.rec), markPrefix: load.marks.prefix || '', pick, anchor: -1 });
    if (pick.length) S.joinLoaded = { gid: load.groupId, key: JSON.stringify(curParts()) };
    marksChanged({ sync: false, seek: rangeNow().start });
  }
  const e = load.edit;
  if (e?.dur && !isMulti()) setTrim(Math.min(e.start || 0, S.duration), Math.min(S.duration, (e.start || 0) + e.dur));
  if (load.suggestDur && S.duration > load.suggestDur && !e?.dur) setTrim(0, load.suggestDur, { seek: 0 });
  if (e?.mode === 'custom' && e.custom) {
    S.custom = { ...CUSTOM_DEF, ...e.custom };
    S.customReady = true;
    S.crop = e.crop ? { ...e.crop } : null;
    setMode('custom');
  } else if (S.mode !== 'auto') {
    // 上次是一键（菜单栏压的也算一键）、主界面却停在自定义：切回一键，和「带上次的模式」一致（10-19 晚查出）
    setMode('auto');
  }
  const note = $('editNote');
  note.classList.remove('hidden');
  note.classList.toggle('warn', Boolean(load.sourceMissing));
  note.textContent = load.sourceMissing
    ? `原素材找不到了，正在用「${load.name}」最近的压缩结果编辑；再压一次画质会再损失一点。导出后新版本归到这个素材下。`
    : load.range
      ? editNoteText()
      : `正在编辑菜单栏里的「${load.name}」（用的是原素材）。导出后新版本归到这个素材下，旧版本保留。`;
  if (load.suggestDur && S.duration > load.suggestDur) note.textContent += `这段太长，已经先选好前 ${load.suggestDur} 秒，拖时间轴两头可以改。`;
  refreshSize(true);
  if (S.cfg.debugEditPreset) {
    S.preset = S.cfg.debugEditPreset;
    renderPresets();
  }
  if (S.cfg.debugExport) setTimeout(doExport, 500);
}

async function openFile(p, { keepEdit = false } = {}) {
  if (S.busy) return;
  rememberMarks();
  if (!keepEdit) {
    S.editJob = null;
    $('editNote').classList.add('hidden');
  }
  // 只认 GIF 和视频：拖进图片、文档等原来会进编辑区，到导出才报错（10-19 晚查出）
  const ext = (p.match(/\.[^./\\]+$/)?.[0] || '').toLowerCase();
  if (S.cfg.mediaExt && !S.cfg.mediaExt.includes(ext)) {
    alert(`只能压 GIF 和视频（${S.cfg.mediaExt.map((x) => x.slice(1)).join('、')}），这个文件是${ext ? ` ${ext.slice(1)} ` : '没有扩展名的'}文件。`);
    return;
  }
  $('result').classList.add('hidden');
  let r;
  try {
    r = await api.probe(p);
  } catch (e) {
    alert(`打不开这个文件：${e.message}`);
    return;
  }
  if (r.limit && !r.limit.ok) {
    alert(r.limit.reason);
    return;
  }
  if (S.file !== p) S.exported = {}; // 预览拖走用的「刚导出的」只认这个文件（9.6d）
  S.file = p;
  S.kind = r.info.kind;
  S.duration = r.info.duration || 0;
  S.srcW = r.info.width;
  S.srcH = r.info.height;
  S.srcFps = r.info.gifRate?.fps || r.info.fps || 0; // GIF 用帧数 ÷ 时长（ffprobe 的平均帧率在 GIF 上不准，11.13）
  S.gifSteady = Boolean(r.info.gifRate?.steady);
  S.lockFps = r.info.lockFps || 0; // 11.13 录制时选了帧率的录像：导出锁在这个帧率
  S.start = 0;
  S.end = S.duration;
  Object.assign(S, { segs: [], sel: -1, undo: [], markSet: null, markRec: false, markPrefix: '', pick: [], anchor: -1, joinLoaded: null });
  const mem = MARKS_MEM.get(markKey());
  if (mem) {
    Object.assign(S, { segs: mem.segs.map((s) => ({ ...s, orig: s.orig && { ...s.orig } })), markSet: mem.markSet, markRec: mem.markRec, markPrefix: mem.markPrefix });
    const r = M.span(S.segs);
    S.start = r.start;
    S.end = r.end;
  }
  S.crop = null;
  S.cropDraft = null;
  S.cropEditing = false;
  S.customReady = false;
  S.lastChosen = null;
  S.liveKey = null;
  if (S.mode === 'custom') prefillCustom();
  const fext = (p.split('.').pop() || '').toUpperCase();
  $('fileName').innerHTML = `<b>${esc(p.split(/[\\/]/).pop())}</b><span class="tags"><span>${r.info.width}×${r.info.height}</span><span>${fmtSec(S.duration)} 秒</span>${fext ? `<span>${esc(fext)}</span>` : ''}</span>`;
  $('amb').classList.remove('on');
  $('dropHint').classList.add('hidden');
  $('drop').classList.add('has');
  const url = r.url;
  S.paused = false;
  renderPlayState();
  if (S.kind === 'gif') {
    $('video').classList.add('hidden');
    $('gifPreview').src = url;
    $('gifPreview').classList.remove('hidden');
    // GIF 转一个低分辨率预览视频（<img> 没法定位到某一秒），好了就换上，裁时长时能拖动定位
    api.gifPreview(p).then((u) => {
      if (S.file !== p) return;
      const v = $('video');
      v.src = u;
      v.classList.remove('hidden');
      $('gifPreview').classList.add('hidden');
      v.play().catch(() => {});
    }).catch(() => {});
  } else {
    $('gifPreview').classList.add('hidden');
    const v = $('video');
    v.src = url;
    v.classList.remove('hidden');
    v.play().catch(() => {});
  }
  $('trim').classList.remove('hidden');
  $('thumbs').innerHTML = '';
  renderTrim();
  renderMarks();
  renderMarkHint();
  renderCrop();
  renderCustom();
  loadThumbs(p);
  $('export').disabled = false;
  $('clearBtn').disabled = false;
  refreshSize(true);
}

// ---------- 裁时长（单独一块，一键和自定义都能用） ----------
// 轻量：缩略图稀疏（固定 12 张、每张直接定位取一帧），拖动时只改参数和预览位置、不编码；
// 导出时从原片按真实帧边界切（作者：「编辑阶段操作低分辨率预览…最终导出时才处理原始高清素材」）。
const MIN_SEL = 0.3;
const activeVideo = () => ($('video').classList.contains('hidden') ? null : $('video'));
const mediaEl = () => activeVideo() || (!$('gifPreview').classList.contains('hidden') ? $('gifPreview') : null);

function setTrim(s, e, { seek } = {}) {
  if (!S.duration) return;
  if (S.busy) {
    renderTrim(); // 导出时起止先定住，拖把手、改秒数都不改（10-20 审查 C2：导几段时会改到还没导的段）
    return;
  }
  s = Math.max(0, Math.min(Number(s) || 0, S.duration - MIN_SEL));
  e = Math.min(S.duration, Math.max(Number(e) || 0, s + MIN_SEL));
  S.start = Math.round(s * 100) / 100;
  S.end = Math.round(e * 100) / 100;
  if (S.segs.length) {
    // 选中了某段就改这段（可以伸到相邻段里，不带动别的段）；没选中就改整体的头尾
    S.segs = M.setRange(S.segs, S.sel, S.start, S.end, S.pick);
    const r = rangeNow();
    S.start = r.start;
    S.end = r.end;
    renderMarks();
    scheduleSync();
  }
  renderTrim();
  renderCustom();
  const v = activeVideo();
  if (v && seek !== undefined) v.currentTime = Math.min(S.end - 0.02, Math.max(S.start, seek));
  refreshSize();
}

function renderTrim() {
  const d = S.duration || 1;
  const l = (S.start / d) * 100;
  const r = (S.end / d) * 100;
  $('shadeL').style.width = `${l}%`;
  $('shadeR').style.width = `${100 - r}%`;
  $('handleL').style.left = `${l}%`;
  $('handleR').style.left = `${r}%`;
  $('startNum').value = S.start.toFixed(2);
  $('endNum').value = S.end.toFixed(2);
  $('startNum').max = S.duration;
  $('endNum').max = S.duration;
  const n = S.segs.length;
  const multi = isMulti();
  $('segLabel').textContent = S.sel >= 0 ? `第 ${S.sel + 1} 段` : multi ? `第 ${M.pickLabel(S.pick)} 段` : n ? `共 ${n} 段` : '';
  // 原片多长在上面文件名那一行；这里不再重复（作者：最小宽度下「收起」被挤出去）
  $('durLine').textContent = `${S.sel >= 0 ? '共' : multi ? '拼起来' : n ? '合起来' : '选段'} ${fmtSec(curDur())} 秒`;
  $('durLine').title = `原片 ${fmtSec(S.duration)} 秒`;
  const rb = $('trimReset');
  rb.classList.toggle('hidden', n > 0 && S.sel < 0);
  rb.textContent = S.sel >= 0 ? '还原这段' : '还原整段';
  rb.title = S.sel >= 0 ? '回到切出来时的起止' : '恢复整段';
  renderPlayhead();
}

function renderPlayhead() {
  const v = activeVideo();
  $('playhead').classList.toggle('hidden', !v);
  if (v && S.duration) $('playhead').style.left = `${(v.currentTime / S.duration) * 100}%`;
  $('tlFill').style.width = v && S.duration ? `${(v.currentTime / S.duration) * 100}%` : '0';
}

async function loadThumbs(file) {
  let list = [];
  try {
    list = await api.thumbs({ file });
  } catch {}
  if (S.file !== file) return;
  $('thumbs').innerHTML = list.map((x) => (x.src ? `<img src="${x.src}" alt="" draggable="false">` : '<span></span>')).join('');
  const mid = list.filter((x) => x.src)[Math.floor(list.filter((x) => x.src).length / 2)];
  if (mid) {
    $('amb').style.backgroundImage = `url("${mid.src}")`;
    $('amb').classList.add('on');
  }
}

function bindTrim() {
  const strip = $('strip');
  const timeAt = (ev) => {
    const r = strip.getBoundingClientRect();
    return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * S.duration;
  };
  for (const [id, which] of [['handleL', 'L'], ['handleR', 'R']]) {
    const h = $(id);
    h.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      pausePreview(); // 拖把手：停在那一帧看准
      h.setPointerCapture(ev.pointerId);
      h.dataset.drag = '1';
    });
    h.addEventListener('pointermove', (ev) => {
      if (!h.dataset.drag) return;
      const t = timeAt(ev);
      if (which === 'L') setTrim(t, S.end, { seek: t });
      else setTrim(S.start, t, { seek: t - 0.05 });
    });
    h.addEventListener('pointerup', () => { delete h.dataset.drag; });
  }
  // 点或拖时间轴：先暂停，停在那一帧不动；再点画面才从这里放（作者）
  const seekTo = (ev) => {
    const v = activeVideo();
    if (v) v.currentTime = Math.min(S.end - 0.02, Math.max(S.start, timeAt(ev)));
    renderPlayhead();
  };
  let scrubbing = false;
  strip.addEventListener('pointerdown', (ev) => {
    if (ev.target.classList.contains('handle') || ev.target.closest('.mnum') || ev.button !== 0) return;
    pausePreview();
    scrubbing = true;
    strip.setPointerCapture(ev.pointerId);
    seekTo(ev);
  });
  strip.addEventListener('pointermove', (ev) => {
    if (scrubbing) seekTo(ev);
  });
  strip.addEventListener('pointerup', () => { scrubbing = false; });
  strip.addEventListener('click', (ev) => {
    if (ev.target.classList.contains('handle') || ev.target.closest('.mnum')) return;
    pausePreview();
    seekTo(ev);
  });
  // 双击一段：只看这一段（再双击取消）；点段号也一样
  strip.addEventListener('dblclick', (ev) => {
    if (!S.segs.length || ev.target.classList.contains('handle') || ev.target.closest('.mnum')) return;
    const t = timeAt(ev);
    const i = S.sel >= 0 && S.segs[S.sel].start <= t && t <= S.segs[S.sel].end ? S.sel : S.segs.findIndex((s) => s.start <= t && t <= s.end);
    if (i >= 0) selectSeg(i);
  });
  const marks = $('marks');
  marks.addEventListener('pointerdown', (ev) => {
    const num = ev.target.closest('.mnum');
    if (!num || ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const i = Number(num.dataset.i);
    if (CMD(ev)) pickSeg(M.togglePick(S.sel, S.pick, i), i); // ⌘点：加进 / 移出多选（11.14）
    else if (ev.shiftKey) pickSeg(M.rangePick(S.sel, S.pick, S.anchor, i), i); // ⇧点：从上次点的那段连着选
    else selectSeg(i);
  });
  // 右键切点：删掉这一刀（和前一段合成一段）
  marks.addEventListener('contextmenu', (ev) => {
    const c = ev.target.closest('.mcut');
    if (!c) return;
    ev.preventDefault();
    mergeAt(Number(c.dataset.k));
  });
  strip.addEventListener('transitionend', (ev) => { if (ev.target === strip && ev.propertyName === 'height') renderMarks(); });
  $('tlOpen').onclick = () => { releaseFocus(); setTimeline(true); };
  $('tlClose').onclick = () => { releaseFocus(); setTimeline(false); };
  $('startNum').addEventListener('change', () => { pausePreview(); setTrim($('startNum').value, S.end, { seek: Number($('startNum').value) }); });
  $('endNum').addEventListener('change', () => { pausePreview(); setTrim(S.start, $('endNum').value, { seek: Number($('endNum').value) - 0.05 }); });
  $('trimReset').onclick = () => {
    const s = S.sel >= 0 ? S.segs[S.sel] : null;
    if (s?.orig) setTrim(s.orig.start, s.orig.end, { seek: s.orig.start });
    else setTrim(0, S.duration);
  };
  window.addEventListener('resize', renderCrop);
}

// ---------- 预览播放 / 暂停（作者）：S.paused 是用户的意思；暂停时画面中间显示半透明的 ▶ ----------
/** 光标在能打字的地方（文字、数字输入框、下拉框）：回车、空格照常给它。 */
function typingIn(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit'].includes((el.type || '').toLowerCase());
}

/** 快捷键用掉了这一下：把焦点从刚点过的按钮上拿走，不然按钮上会出现键盘焦点框（作者：按空格后按钮上出现橙色框）。 */
function releaseFocus() {
  const el = document.activeElement;
  if (el && el !== document.body && !typingIn(el)) el.blur();
}

function playPreview() {
  const v = activeVideo();
  if (!v) return;
  S.paused = false;
  if (v.currentTime < S.start || v.currentTime >= S.end - 0.02) v.currentTime = S.start;
  else if (isMulti()) v.currentTime = M.nextPlay(S.segs, S.pick, v.currentTime) ?? v.currentTime; // 停在没选的段里点播放：从下一段放
  v.play().catch(() => {});
  renderPlayState();
}

function pausePreview() {
  S.paused = true;
  activeVideo()?.pause();
  renderPlayState();
}

function renderPlayState() {
  $('playHint').classList.toggle('hidden', !(S.file && activeVideo() && S.paused));
}

/** 调试（GIFKIT_DEBUG_KEYS=1）：按空格、回车，打印播放和裁画面框的状态，最后截图。 */
async function runKeysTest() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !activeVideo(); i++) await sleep(100);
  const v = $('video');
  const key = (code, k) => document.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true }));
  const st = (tag) => api.debugLog(`${tag}：${JSON.stringify({ 播放中: !v.paused, 框: S.cropEditing ? '拉框中' : S.crop ? '已锁定' : '没有', 框上的字: $('cropBox').classList.contains('hidden') ? '' : $('cropSize').textContent })}`);
  await sleep(1200); st('打开');
  $('export').focus(); // 刚点过「导出」、焦点还在它上面
  key('Space', ' '); await sleep(300); st(`按空格（焦点现在在：${document.activeElement?.id || document.activeElement?.tagName}）`);
  key('Space', ' '); await sleep(300); st('再按空格');
  setMode('custom'); startCropEdit(); await sleep(300); st('点「框选」');
  key('Enter', 'Enter'); await sleep(300); st('按回车');
  key('Enter', 'Enter'); await sleep(300); st('再按回车');
  key('Enter', 'Enter'); await sleep(300); st('第三次回车');
  $('c_width').focus();
  key('Enter', 'Enter'); key('Space', ' '); await sleep(300); st('光标在宽度输入框里按回车、空格（应该都不管）');
  $('c_width').blur();
  api.debugShot();
}

/** 调试（GIFKIT_DEBUG_PREVIEW=1）：自己点画面、点时间轴，打印播放状态，最后截图。 */
async function runPreviewTest() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !activeVideo(); i++) await sleep(100);
  const v = $('video');
  const st = (tag) => api.debugLog(`${tag}：${JSON.stringify({ 播放中: !v.paused, 秒: Math.round(v.currentTime * 100) / 100, 暂停标: !$('playHint').classList.contains('hidden') })}`);
  const stripAt = (f) => {
    const r = $('strip').getBoundingClientRect();
    $('strip').dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width * f, clientY: r.top + r.height / 2, bubbles: true }));
  };
  await sleep(1500); st('打开 1.5 秒');
  $('drop').click(); await sleep(300); st('点画面（暂停）');
  await sleep(1000); st('再过 1 秒');
  stripAt(0.5); await sleep(500); st('点时间轴中间');
  await sleep(1000); st('再过 1 秒');
  $('drop').click(); await sleep(1200); st('点画面（播放）过 1.2 秒');
  stripAt(0.25); await sleep(600); st('播放中点时间轴 1/4 处');
  await sleep(800); st('再过 0.8 秒');
  $('drop').click(); await sleep(Math.max(0, (S.end - v.currentTime) * 1000) + 1500); st('点画面后一直放到过了结尾 1.5 秒');
  $('drop').click(); await sleep(400); st('最后点画面（暂停，截图）');
  api.debugShot();
}

// ---------- 裁画面（只在自定义里）：拖框是虚线、不生效；右键或回车锁定后才生效，再右键或回车解锁 ----------
/** 画面在预览区里的位置和缩放（源像素 → 屏幕像素）。 */
function mediaBox() {
  const el = mediaEl();
  if (!el || !S.srcW) return null;
  const r = el.getBoundingClientRect();
  const d = $('drop').getBoundingClientRect();
  if (!r.width) return null;
  return { left: r.left - d.left, top: r.top - d.top, scale: r.width / S.srcW };
}

function renderCrop() {
  const box = $('cropBox');
  const c = S.cropEditing ? S.cropDraft : S.crop;
  const m = mediaBox();
  if (S.mode !== 'custom' || !c || !m) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.classList.toggle('editing', S.cropEditing);
  box.classList.toggle('locked', !S.cropEditing);
  box.style.left = `${m.left + c.x * m.scale}px`;
  box.style.top = `${m.top + c.y * m.scale}px`;
  box.style.width = `${c.w * m.scale}px`;
  box.style.height = `${c.h * m.scale}px`;
  $('cropSize').textContent = S.cropEditing ? `${c.w}×${c.h} · 右键或回车锁定` : `已裁切 ${c.w}×${c.h} · 右键或回车解锁`;
}

function startCropEdit() {
  if (!S.file || S.busy) return;
  if (S.crop) S.cropDraft = { ...S.crop };
  else {
    // 先给一个居中、占八成的框（保持原片比例）
    const w = even(S.srcW * 0.8);
    const h = even(S.srcH * 0.8);
    S.cropDraft = { x: even((S.srcW - w) / 2), y: even((S.srcH - h) / 2), w, h };
  }
  S.cropEditing = true;
  renderCrop();
  renderCustom();
}

function lockCrop() {
  if (!S.cropEditing) return;
  S.crop = { ...S.cropDraft };
  S.cropEditing = false;
  // 输出宽度不能超过裁后的宽度
  if (S.custom.width > S.crop.w) S.custom.width = even(Math.min(S.crop.w, 1080));
  renderCrop();
  renderCustom();
  refreshSize(true);
}

function cancelCropEdit() {
  S.cropEditing = false;
  S.cropDraft = null;
  renderCrop();
  renderCustom();
}

function clearCrop() {
  if (S.busy) return;
  const had = Boolean(S.crop);
  S.crop = null;
  cancelCropEdit();
  if (had) refreshSize(true);
}

function bindCrop() {
  const box = $('cropBox');
  let drag = null;
  box.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (S.cropEditing) lockCrop();
    else if (S.crop) startCropEdit();
  });
  box.addEventListener('pointerdown', (ev) => {
    if (!S.cropEditing || ev.button !== 0) return;
    ev.preventDefault();
    box.setPointerCapture(ev.pointerId);
    drag = { corner: ev.target.dataset?.c || 'move', x0: ev.clientX, y0: ev.clientY, c0: { ...S.cropDraft } };
  });
  box.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const m = mediaBox();
    if (!m) return;
    const dx = (ev.clientX - drag.x0) / m.scale;
    const dy = (ev.clientY - drag.y0) / m.scale;
    const c = { ...drag.c0 };
    const MIN = 64;
    if (drag.corner === 'move') {
      c.x = Math.min(S.srcW - c.w, Math.max(0, c.x + dx));
      c.y = Math.min(S.srcH - c.h, Math.max(0, c.y + dy));
    } else {
      let x1 = c.x, y1 = c.y, x2 = c.x + c.w, y2 = c.y + c.h;
      if (drag.corner.includes('w')) x1 = Math.min(x2 - MIN, Math.max(0, x1 + dx));
      if (drag.corner.includes('e')) x2 = Math.max(x1 + MIN, Math.min(S.srcW, x2 + dx));
      if (drag.corner.includes('n')) y1 = Math.min(y2 - MIN, Math.max(0, y1 + dy));
      if (drag.corner.includes('s')) y2 = Math.max(y1 + MIN, Math.min(S.srcH, y2 + dy));
      if (S.ratioLock) {
        // 锁比例：按宽度定高度，保持原片比例（作者：「默认长和宽锁住」）
        const aspect = S.srcH / S.srcW;
        const w = x2 - x1;
        let h = w * aspect;
        if (drag.corner.includes('n')) y1 = Math.max(0, y2 - h);
        else y2 = Math.min(S.srcH, y1 + h);
        h = y2 - y1;
        const w2 = h / aspect;
        if (drag.corner.includes('w')) x1 = x2 - w2;
        else x2 = x1 + w2;
      }
      Object.assign(c, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
    c.w = Math.min(even(c.w), S.srcW - (S.srcW % 2));
    c.h = Math.min(even(c.h), S.srcH - (S.srcH % 2));
    c.x = Math.min(S.srcW - c.w, Math.max(0, Math.round(c.x / 2) * 2));
    c.y = Math.min(S.srcH - c.h, Math.max(0, Math.round(c.y / 2) * 2));
    S.cropDraft = c;
    renderCrop();
    $('c_cropState').textContent = `${c.w}×${c.h} 未锁定`;
  });
  box.addEventListener('pointerup', () => { drag = null; });
}

// ---------- 一键：预估 ----------
let timer = null;
function scheduleEstimate(now) {
  if (!S.file || S.mode !== 'auto') return;
  clearTimeout(timer);
  $('sizeBox').classList.add('busy');
  timer = setTimeout(runEstimate, now ? 0 : 350);
}

async function runEstimate() {
  const seq = ++S.estSeq;
  if (S.kind === 'gif') return runGifCheck(seq);
  const tier = autoTier();
  const dur = curDur();
  let r;
  try {
    r = await api.estimate({ file: S.file, start: S.start, dur, ranges: curParts() || undefined, ...tier, preset: S.preset, fill: S.mode === 'custom' ? S.custom.fill : S.prefs?.fill !== false });
  } catch (e) {
    if (seq === S.estSeq) showEstimateError(e);
    return;
  }
  if (seq !== S.estSeq || S.mode !== 'auto') return; // 参数又变了，这个结果作废
  showEstimate(r, tier, dur);
  debugAfterEstimate();
}

async function debugAfterEstimate() {
  if (S.cfg.debugOpen && !S.debugDone) {
    S.debugDone = true;
    if (S.cfg.debugPreview) {
      runPreviewTest();
      return;
    }
    if (S.cfg.debugKeys) {
      runKeysTest();
      return;
    }
    if (S.cfg.debugMarks) {
      ({ export: runMarksExportTest, long: runMarksLongTest }[S.cfg.debugMarks] || runMarksTest)();
      return;
    }
    if (S.cfg.debugCustom) {
      // 调试截图：剪一段、切到自定义、框选并锁定，等实时体积出来再截（截图在 runLive 里）
      setTrim(1, 4, { seek: 2 });
      setMode('custom');
      startCropEdit();
      lockCrop();
      return;
    }
    if (S.cfg.debugExport) await doExport();
    if (S.cfg.debugPanel) openPanel(true);
    if (S.cfg.debugClear) $('clearBtn').click();
    setTimeout(() => api.debugShot(), 300);
  }
}

/** GIF 不预估：直接查合规，告诉用户导出时会做什么。 */
async function runGifCheck(seq) {
  let r;
  try {
    r = await api.checkGif({ file: S.file, preset: S.preset });
  } catch (e) {
    if (seq === S.estSeq) showEstimateError(e);
    return;
  }
  if (seq !== S.estSeq || S.mode !== 'auto') return;
  const s = r.summary;
  const capMB = (presetLimit() / 1e6).toFixed(1);
  const trimmed = isMulti() || S.start > 0.005 || S.end < S.duration - 0.05;
  let cls, verdict;
  if (trimmed) { cls = 'mid'; verdict = '剪过时长，导出时按选段重新压缩'; }
  else if (r.ok && !r.needsFill) { cls = 'ok'; verdict = '已经合规，导出时直接用原文件'; }
  else if (r.ok) { cls = 'ok'; verdict = `在 ${capMB}MB 以内；导出时凑到 61 帧`; }
  else { cls = 'mid'; verdict = '超过上限，导出时自动重压缩'; }
  setSize({
    cls, big: fmtMB(s.bytes), label: '现在', verdict,
    details: [`${s.width}×${s.height} · ${s.frames} 帧 · ${s.durationSec.toFixed(1)} 秒`, r.ok ? '' : r.problems.join('；'), 'GIF 按 sRGB 处理'],
  });
  debugAfterEstimate();
}

function showEstimateError(e) {
  setSize({ cls: 'bad', verdict: `预估失败：${e.message}` });
}

function showEstimate(r, tier, dur) {
  if (r.tooLong) {
    // 选段太长：补救就是剪短（作者：裁剪是压缩不理想时的第三条退路）
    setSize({ cls: 'bad', big: `${fmtSec(dur)} 秒`, label: '太长', verdict: `每秒 ${r.fps} 帧最多 300 帧，要剪到 ${r.maxDur} 秒以内（拖预览下面的时间轴）` });
    return;
  }
  const capMB = (presetLimit() / 1e6).toFixed(1);
  let cls, verdict;
  if (r.fits) {
    cls = 'ok';
    verdict = `能装进 ${capMB}MB`;
  } else if (r.ratio <= S.cfg.skipRatio) {
    cls = 'mid';
    verdict = r.ratio <= 1.65 ? '比上限大一点，导出时自动压' : '比上限大不少，导出时会降画质或降一档';
  } else {
    cls = 'bad';
    const sec = Math.floor(dur * (S.cfg.fitRatio / r.ratio) * 10) / 10;
    verdict = `是上限的 ${r.ratio.toFixed(1)} 倍，导出时会降宽度或帧率` + (sec >= 1 ? `；剪到约 ${sec} 秒能保住画质` : '');
  }
  const fillNote = r.frames < 61 ? '，导出时凑到 61 帧' : '';
  setSize({
    cls, big: fmtMB(r.estimate), label: '预计', verdict,
    details: [`最高画质时大概在 ${fmtMB(r.range[0])} 到 ${fmtMB(r.range[1])} 之间（${r.ratioSource}）`, `按 ${r.width}×${r.height}、每秒 ${tier.fps} 帧（${r.frames} 帧${fillNote}）估算`, r.color.note],
  });
}

// ---------- 导出 ----------
async function doExport() {
  if (!S.file || S.busy) return;
  if (S.segs.length && S.sel < 0 && !isMulti()) return exportSegs();
  // 先锁住再同步（10-20 审查 C1：原来同步录屏段的那一会儿没锁，连点两次「导出」会导两遍，还能换文件）
  S.busy = true;
  if (S.markRec) await syncNow().catch(() => {}); // 录屏的段：先同步，导出归到菜单栏对应那一行
  if (S.mode === 'custom' && S.cropEditing) lockCrop(); // 还在框选就按当前框锁定，免得「导出后才发现没裁 / 裁了」（导出时不顺带实时真编）
  $('export').classList.add('hidden');
  $('cancel').classList.remove('hidden');
  $('result').classList.add('hidden');
  openPanel(false);
  $('sizeVerdict').classList.add('hidden');
  $('sizeLabel').classList.add('hidden');
  $('progress').classList.remove('hidden');
  $('progressText').textContent = '开始导出…';
  const t0 = Date.now();
  const tick = () => { $('elapsed').textContent = `已用 ${Math.floor((Date.now() - t0) / 1000)} 秒`; };
  tick();
  const clock = setInterval(tick, 500);
  const args = exportArgs();
  // 自定义：参数没变就直接用刚才实时真编的结果，不再重编
  if (S.mode === 'custom' && S.liveKey && S.liveKey === liveKeyOf(args)) args.liveKey = S.liveKey;
  // 编辑参数随结果记进菜单栏列表，下次从列表点进来还原
  args.edit = { start: S.start, dur: curDur(), mode: S.mode, custom: S.mode === 'custom' ? { ...S.custom } : null, crop: S.mode === 'custom' ? S.crop : null };
  if (args.ranges) args.edit.ranges = args.ranges; // 拼起来的：从菜单栏那一行点回来时还原这几段
  const seg = S.segs.length && S.sel >= 0 ? S.segs[S.sel] : null;
  if (seg) Object.assign(args, segArgs(S.sel));
  else if (isMulti()) Object.assign(args, joinArgs());
  else if (S.editJob) args.groupId = S.editJob.groupId;
  try {
    const r = await api.convert(args);
    if (S.mode === 'auto' && r.chosen) S.lastChosen = r.chosen;
    // 预览拖走（10-22 试用反馈 9.6d）：记下这一档最近导出的是哪个文件、按什么参数导的；之后参数一改就不让拖
    if (exportedOk(r)) (S.exported ||= {})[args.preset] = { key: dragKeyOf(args), file: r.output, bytes: r.bytes || r.chosen?.bytes || 0 };
    if (seg && r.groupId) {
      seg.gid = r.groupId;
      seg.done = true;
      renderMarks();
    }
    if (args.ranges && r.groupId) S.joinLoaded = { gid: r.groupId, key: JSON.stringify(args.ranges) }; // 同样这几段再导出：归到这一行
    showResult(r, (Date.now() - t0) / 1000);
  } catch (e) {
    const msg = String(e.message || e);
    showResult({ ok: false, cancelled: msg.includes('已取消'), reason: msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), tried: [] }, (Date.now() - t0) / 1000);
  } finally {
    clearInterval(clock);
    S.busy = false;
    $('export').classList.remove('hidden');
    $('cancel').classList.add('hidden');
    $('progress').classList.add('hidden');
    $('sizeVerdict').classList.remove('hidden');
    $('sizeLabel').classList.remove('hidden');
  }
}

// ---------- 预览框拖走（10-22 试用反馈 9.6d，作者选「A 跟着选中的用途」） ----------
// 导出后直接拖预览框：拖出去的是右边选中那档最近导出的 GIF。没导出过、或导出后又改了起止 / 画面框 / 速度：拖不动，左上角写原因；
// 裁画面框解锁的时候鼠标归裁框；按住移动几个像素才算拖，单击照旧是播放 / 暂停。
const dragKeyOf = (a) => JSON.stringify({ ...a, edit: undefined, groupId: undefined, liveKey: undefined });
/** 和「导出」发出去的参数一样算（选中录屏的某一段时带上那一段） */
function currentExportArgs() {
  const a = exportArgs();
  if (S.segs.length && S.sel >= 0) Object.assign(a, segArgs(S.sel));
  else if (isMulti()) Object.assign(a, joinArgs());
  return a;
}
const presetMB = (id) => (S.presets.find((p) => p.id === id)?.limit || 0) / 1e6;
/** 现在能拖哪份：{ file, bytes } 或 { why: 拖不了的原因（空的就不提示） } */
function previewDragTarget() {
  if (!S.file || S.busy) return { why: '' };
  if (S.cropEditing) return { why: '' };
  if (S.segs.length && S.sel < 0 && !isMulti()) return { why: '导出的是好几段：到菜单栏列表里拖，或者先选中一段' };
  const ex = S.exported?.[S.preset];
  if (!ex) return { why: '先导出，才能拖走' };
  if (ex.key !== dragKeyOf(currentExportArgs())) return { why: '导出以后改过了：再导出一次才能拖走' };
  return { file: ex.file, bytes: ex.bytes };
}
let dragHintTimer = null;
/** 预览左上角的小提示：贴着画面（不贴留白） */
function showDragHint(html, need, ms = 0) {
  const el = $('dragHint');
  const media = !$('video').classList.contains('hidden') ? $('video') : $('gifPreview');
  const r = media.getBoundingClientRect();
  const d = $('drop').getBoundingClientRect();
  el.innerHTML = html;
  el.classList.toggle('need', Boolean(need));
  el.style.left = `${Math.max(8, Math.round(r.left - d.left + 12))}px`;
  el.style.top = `${Math.max(8, Math.round(r.top - d.top + 12))}px`;
  el.classList.remove('hidden');
  clearTimeout(dragHintTimer);
  if (ms) dragHintTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
const hideDragHint = () => { clearTimeout(dragHintTimer); $('dragHint').classList.add('hidden'); };
/** 跟着鼠标的小图：这一帧画面 + 「9.9 档 · 9.62MB」（2 倍像素，主进程按 2 倍认） */
function dragImage(bytes) {
  const media = !$('video').classList.contains('hidden') ? $('video') : $('gifPreview');
  const sw = media.videoWidth || media.naturalWidth || 16;
  const sh = media.videoHeight || media.naturalHeight || 9;
  const W = 260;
  const H = Math.max(60, Math.min(220, Math.round((W * sh) / sw)));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H + 58;
  const x = c.getContext('2d');
  try {
    x.drawImage(media, 0, 0, W, H);
  } catch {
    x.fillStyle = '#333';
    x.fillRect(0, 0, W, H);
  }
  x.strokeStyle = 'rgba(255,255,255,0.5)';
  x.lineWidth = 2;
  x.strokeRect(1, 1, W - 2, H - 2);
  const label = `${presetMB(S.preset).toFixed(1)} 档 · ${(bytes / 1e6).toFixed(2)}MB`;
  x.font = 'bold 24px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  const tw = Math.ceil(x.measureText(label).width) + 28;
  x.fillStyle = '#2f6bff';
  x.beginPath();
  x.roundRect(0, H + 10, tw, 40, 20);
  x.fill();
  x.fillStyle = '#fff';
  x.textBaseline = 'middle';
  x.fillText(label, 14, H + 31);
  try {
    return c.toDataURL('image/png');
  } catch {
    return '';
  }
}
let swallowClickUntil = 0; // 拖了一下（拖走或者被拦下）：松手那一下不算单击，不切播放 / 暂停（菜单栏同款）
function bindPreviewDrag() {
  $('drop').addEventListener('click', (ev) => {
    if (Date.now() < swallowClickUntil) {
      swallowClickUntil = 0;
      ev.stopPropagation(); // 在外层先收：后面「点画面播放 / 暂停」那个就收不到了
    }
  }, true);
  const hoverHint = () => {
    const t = previewDragTarget();
    if (t.file) showDragHint(`↗ 拖这张图走 = 刚导出的 <b>${(t.bytes / 1e6).toFixed(2)}MB</b>（右边选中的 ${presetMB(S.preset).toFixed(1)} 档）`, false);
    else if (!$('dragHint').classList.contains('need')) hideDragHint();
  };
  for (const el of [$('video'), $('gifPreview')]) {
    el.addEventListener('dragstart', (e) => {
      e.preventDefault();
      swallowClickUntil = Date.now() + 1500;
      const t = previewDragTarget();
      if (!t.file) {
        if (t.why) showDragHint(t.why, true, 2600);
        return;
      }
      S.draggingOut = Date.now();
      hideDragHint();
      api.dragOut(t.file, dragImage(t.bytes));
    });
    el.addEventListener('mouseenter', hoverHint);
    // 导出完的时候鼠标已经在画面上（不会再「进入」）：动一下也刷新提示
    el.addEventListener('mousemove', (e) => { if (e.buttons === 0 && $('dragHint').classList.contains('hidden')) hoverHint(); });
    el.addEventListener('mouseleave', () => { if (!$('dragHint').classList.contains('need')) hideDragHint(); });
  }
  // 拖完：鼠标回到窗口里、没按着键动一下，就不算在往外拖了
  document.addEventListener('mousemove', (e) => { if (S.draggingOut && e.buttons === 0) { S.draggingOut = 0; api.dragDone?.(); } }, true); // 在最外层先收（有的地方会拦下鼠标移动）；告诉主进程拖完了（10-23）
  api.onDragMissing?.(() => {
    S.draggingOut = 0;
    showDragHint('刚导出的文件不在了（挪走或删了）：再导出一次', true, 3200);
  });
}

/** 结果卡片「详情」里的手动参数：改了哪些、有哪些没生效或被限住。 */
function manualRows(m) {
  if (!m) return [];
  return [`参数：${esc(m.summary)}`, ...(m.notes || []).map((n) => `<span class="warn">${esc(n)}</span>`)];
}

/**
 * 导出成功（作者：「导出后自动弹出了这个界面，我理解不用弹出了…下半部分这个导出好了可以去掉了」，选「标题行写一句（推荐）」）：
 * 不弹面板、不出结果卡片，标题行那一行写「已导出 9.80 MB，在菜单栏列表里」，点开能看宽度、帧率和文件在哪；结果在菜单栏列表里（右键「在访达中显示」）。
 * 没做成、取消了、导出了但合规检查没过：照旧弹出结果卡片（原因和「剪到 N 秒」按钮只在这里）。
 */
function exportedOk(r) {
  return !r.cancelled && r.ok && r.output;
}
function showExported(r, sec) {
  $('result').classList.add('hidden');
  openPanel(false);
  const c = r.chosen;
  const bytes = r.bytes || c?.bytes || 0;
  const how = r.gif ? { 凑帧: '（只凑了帧）', 原样保留: '（已经合规，原样复制了一份）', 已合规: '（已经合规，直接用原文件）' }[r.action] || '' : '';
  setSize({
    cls: 'ok', big: bytes ? fmtMB(bytes) : '✓', label: '已导出',
    verdict: `已导出${bytes ? ` ${fmtMB(bytes)}` : ''}${how}，在菜单栏列表里`,
    details: [c ? `${c.width} 宽 · 每秒 ${c.fps} 帧 · 用时 ${sec.toFixed(0)} 秒${r.reused ? '（直接用了刚才实时编的结果）' : ''}` : `用时 ${sec.toFixed(0)} 秒`, r.output, r.hint || ''],
  });
}

/** 结果卡片：一行结论、一行尺寸体积，其余收进「详情」。没做成、取消了才用（成功的见 showExported）。 */
function showResult(r, sec) {
  if (exportedOk(r)) {
    showExported(r, sec);
    return;
  }
  const el = $('result');
  el.classList.remove('hidden');
  openPanel(true); // 导出完自动展开下拉面板看结果（点别处收起）
  el.classList.toggle('fail', !r.ok && !r.cancelled);
  el.innerHTML = '';
  const line = (html) => { const d = document.createElement('div'); d.innerHTML = html; el.appendChild(d); };
  const revealBtn = (p) => {
    const b = document.createElement('button');
    b.textContent = '在访达中显示';
    b.onclick = () => api.reveal(p);
    el.appendChild(b);
  };
  const details = (rows) => {
    const rs = rows.filter(Boolean);
    if (!rs.length) return;
    const d = document.createElement('details');
    d.className = 'more';
    d.innerHTML = `<summary>详情</summary>${rs.map((x) => `<div>${x}</div>`).join('')}`;
    el.appendChild(d);
  };
  if (r.cancelled) {
    line(`<b>已取消</b>（用了 ${sec.toFixed(0)} 秒）`);
    return;
  }
  if (r.gif) {
    const title = !r.ok ? '没做成' : { 压缩: '导出好了', 凑帧: '导出好了（只凑了帧）', 原样保留: '已经合规，原样复制了一份', 已合规: '已经合规，直接用原文件' }[r.action] || r.action;
    line(`<b>${title}</b> · 用时 ${sec.toFixed(0)} 秒`);
    const c = r.chosen;
    if (c) line(`${c.width} 宽 · 每秒 ${c.fps} 帧 · <b>${fmtMB(c.bytes)}</b>`);
    else line(esc(r.detail || ''));
    if (r.output) revealBtn(r.output);
    details([c && esc(r.detail || ''), ...manualRows(r.manual), r.output && esc(r.output), r.hint && esc(r.hint)]);
    return;
  }
  if (r.chosen) {
    const c = r.chosen;
    line(`<b>${r.ok ? '导出好了' : '导出了，但合规检查没过'}</b> · 用时 ${sec.toFixed(0)} 秒${r.reused ? '（直接用了刚才实时编的结果）' : ''}`);
    line(`${c.width} 宽 · 每秒 ${c.fps} 帧 · <b>${fmtMB(c.bytes)}</b>`);
    if (c.belowFloor) line('<span class="muted">画质没到最低线，想更清楚可以剪短一点</span>');
    revealBtn(r.output);
    const enc = c.encoder === 'lessgif' ? `lessgif，画质 ${c.q}` : c.lossy !== undefined ? `${c.encoder}，有损 ${c.lossy}` : r.manual?.path === 'encoder' && c.q !== undefined ? `${c.encoder}，画质 ${c.q}` : c.encoder;
    details([
      `${c.outFrames ?? c.frames} 帧 · ${esc(enc || '')}${c.extraLossy ? `，额外有损 ${c.extraLossy}` : ''}${c.ssim ? ` · SSIM ${c.ssim}` : ''}${c.vmaf ? ` · VMAF ${c.vmaf}` : ''}`,
      ...manualRows(r.manual),
      r.fill && (r.fill.ok ? `凑帧：${r.fill.before} → ${r.fill.after} 帧` : `凑帧没成：${esc(r.fill.reason)}`),
      r.check && !r.check.ok && `合规问题：${esc(r.check.problems.join('；'))}`,
      esc(r.output),
      r.hint && esc(r.hint),
    ]);
  } else {
    line(`<b>没做成</b> · 用时 ${sec.toFixed(0)} 秒`);
    line(esc(r.reason || ''));
    if (r.manual) details(manualRows(r.manual));
    for (const t of r.trims || []) {
      const b = document.createElement('button');
      b.textContent = `${t.width} 宽：剪到 ${t.dur} 秒`;
      b.onclick = () => {
        setTrim(S.start, Math.min(S.duration, S.start + t.dur));
        el.classList.add('hidden');
        openPanel(false);
      };
      el.appendChild(b);
    }
  }
}

// ---------- 打标（切一刀）：段的计算在 marks.cjs，这里管界面（TODO 2.71） ----------
let syncTimer = null;
let hintTimer = null;

/** 文件名那一行右边的提示；msg 有值时短暂显示原因（切不了的时候）。 */
function renderMarkHint(msg) {
  const h = $('markHint');
  clearTimeout(hintTimer);
  if (msg) {
    h.textContent = msg;
    h.classList.add('warn');
    hintTimer = setTimeout(() => renderMarkHint(), 2500);
    return;
  }
  h.classList.remove('warn');
  const n = S.segs.length;
  h.textContent = !S.file ? '' : isMulti() ? `${hk('mark')} 切一刀 · 第 ${M.pickLabel(S.pick)} 段拼成一张 · Esc 取消` : n >= 2 ? `${hk('mark')} 切一刀 · 共 ${n} 段 · ⌘点段号多选` : n ? `${hk('mark')} 切一刀 · 共 ${n} 段` : `${hk('mark')} 切一刀`;
}

/**
 * 一段最长多少秒能导出来：最多 300 帧 ÷ 当前帧率（一键按先试的那档，自定义按设的帧率）；
 * 和选中某段时标题行「要剪到 N 秒以内」是同一个算法（作者问只切一刀、后面那段太长怎么办，选「可以改进」）。
 */
function segLimit() {
  const maxF = S.presets.find((x) => x.id === S.preset)?.maxFrames || 300;
  const fps = Math.max(1, S.mode === 'custom' ? (S.srcFps ? Math.min(S.custom.fps, Math.round(S.srcFps)) : S.custom.fps) : autoTier().fps);
  return { fps, maxF, maxSec: Math.floor((maxF / fps) * 10) / 10 };
}
const segMaxSec = () => segLimit().maxSec;

/** 现在要预览、预估、导出的起止：选中的那段；没选中就是所有段合起来；没切过就是时间轴两头。 */
function rangeNow() {
  if (!S.segs.length) return { start: S.start, end: S.end };
  if (isMulti()) return M.pickSpan(S.segs, S.pick); // 多选：选中的几段合起来从哪到哪（中间没选的预览时跳过）
  return S.sel >= 0 ? S.segs[S.sel] : M.span(S.segs);
}

/** 段变了（切、删、撤销、选段）：起止跟着换，重画，预估刷新；录屏的段同步回菜单栏。 */
function marksChanged({ popAt, sync = true, seek } = {}) {
  const r = rangeNow();
  S.start = Math.round(r.start * 100) / 100;
  S.end = Math.round(r.end * 100) / 100;
  renderTrim();
  renderMarks(popAt);
  renderMarkHint();
  renderCustom();
  const v = activeVideo();
  if (v && seek !== undefined) v.currentTime = Math.min(S.end - 0.02, Math.max(S.start, seek));
  if (sync) scheduleSync();
  if ((S.sel >= 0 || isMulti()) && S.mode === 'auto') setSize({ cls: 'busy', big: '…', label: '预计', verdict: isMulti() ? '正在预估拼起来的这几段…' : '正在预估这一段…' });
  if (S.editJob && !S.editJob.sourceMissing) $('editNote').textContent = editNoteText(); // 整个文件切了刀也跟着变（10-20 审查 M7）
  refreshSize();
}

/** 从菜单栏打开某一段时上面那条说明：跟着现在有几段、选中哪段变（切了、删了以后不留着旧的段号）。 */
function editNoteText() {
  const what = S.markRec ? '这次录屏' : '这个文件';
  const n = S.segs.length;
  if (!S.editJob?.range) {
    // 从菜单栏「编辑」整个文件：切了刀以后，各段导出各占一行，不再归到这个素材下（10-20 审查 M7）
    const name = S.editJob?.name || '';
    if (!n) return `正在编辑菜单栏里的「${name}」（用的是原素材）。导出后新版本归到这个素材下，旧版本保留。`;
    return S.sel >= 0
      ? `正在编辑菜单栏里的「${name}」的第 ${S.sel + 1} 段（共 ${n} 段）：导出后这一段在菜单栏里单独一行。`
      : `正在编辑菜单栏里的「${name}」，切成了 ${n} 段：没选中时导出，把还没导过的段各导一张，每段在菜单栏里单独一行。`;
  }
  if (S.sel >= 0) return `正在编辑${what}的第 ${S.sel + 1} 段（共 ${n} 段）：点段号换一段，展开时间轴后两头把手可以拖到整段任何位置。导出后结果归到这一段下。`;
  if (isMulti()) return `正在编辑${what}的第 ${M.pickLabel(S.pick)} 段：导出时按时间顺序拼成一张，在菜单栏里单独一行。`;
  return n ? `正在编辑${what}的 ${n} 段：点段号只看一段；没选中时导出，把还没导过的段各导一张。` : `正在编辑${what}（已经没有分段了），导出就是一张。`;
}

// ---------- 多选（11.14 多选导出，11-06 作者：「直接升级成多选导出」，示意图选 A） ----------
/** 多选了两段以上：导出时按时间顺序拼成一张。 */
function isMulti() {
  return S.pick.length >= 2;
}
/** 多选时给引擎拼的几段 [{ start, dur }]（按时间排）；不是多选返回 null。 */
function curParts() {
  return isMulti() ? M.joinParts(S.segs, S.pick) : null;
}
/** 现在要导出的总长：多选是几段之和，否则是起止之差。 */
function curDur() {
  return isMulti() ? M.joinDur(S.segs, S.pick) : S.end - S.start;
}
/** ⌘点、⇧点、⌘A、Esc 之后换成新的选中（{ sel, pick }）；预览停到选中的第一段开头。i：这次点的段号（⇧点从它连选），-1 不记。 */
function pickSeg(r, i) {
  if (S.busy) return;
  S.sel = r.sel;
  S.pick = r.pick;
  // ⇧点的起点：这次点的段还选着就是它；⌘点去掉了它，就用还选着的第一段（11-06 测试桩：去掉第 3 段后 ⇧点 3 只选中了它自己）
  if (i >= 0) S.anchor = r.sel === i || r.pick.includes(i) ? i : r.sel >= 0 ? r.sel : r.pick[0] ?? -1;
  marksChanged({ sync: false, seek: rangeNow().start });
}
/** 多选时预览跳过没选的段（t：这一帧的时刻，没给就看 currentTime）。 */
function skipGap(v, t = v.currentTime) {
  if (!isMulti() || v.paused || v.seeking) return;
  const to = M.nextPlay(S.segs, S.pick, t);
  if (to !== null && Math.abs(to - t) > 0.01) v.currentTime = to;
}
/** 多选导出带给主进程的：段号「1+3」和几段的起止（菜单栏里单独建「拼起来」的一行）；同样这几段导过就归到那一行。 */
function joinArgs() {
  const parts = curParts();
  const join = parts.map((p) => ({ start: p.start, end: Math.round((p.start + p.dur) * 100) / 100 }));
  return {
    range: { n: M.pickLabel(S.pick), start: join[0].start, end: Math.max(...join.map((p) => p.end)), join, set: S.markSet, prefix: S.markPrefix || S.file.split(/[\\/]/).pop(), rec: S.markRec },
    groupId: S.joinLoaded?.key === JSON.stringify(parts) ? S.joinLoaded.gid : undefined,
  };
}

const copySegs = (segs) => segs.map((s) => ({ ...s, orig: s.orig && { ...s.orig } }));
function pushUndo() {
  S.undo.push({ segs: copySegs(S.segs), sel: S.sel, pick: [...S.pick], start: S.start, end: S.end });
  if (S.undo.length > 50) S.undo.shift();
}

/** ⌥空格：在播放到的地方切一刀（播放、暂停都能切）。 */
function cutHere() {
  if (!S.file) return;
  const v = activeVideo();
  if (!v) {
    renderMarkHint(S.kind === 'gif' ? '动图的预览还在准备，等一下再切' : '预览还没准备好，等一下再切');
    return;
  }
  const r = M.cut(S.segs, S.sel, v.currentTime, S.segs.length ? null : { start: S.start, end: S.end });
  if (r.error) {
    renderMarkHint(r.error);
    return;
  }
  pushUndo();
  if (!S.markSet) S.markSet = `m${Date.now()}`; // 主界面切的这一组；录屏的段用录屏的编号
  if (!S.markPrefix) S.markPrefix = S.file.split(/[\\/]/).pop();
  S.segs = r.segs;
  S.sel = r.sel;
  S.pick = M.pickAfterCut(S.pick, r.at); // 多选的段号跟着挪，被切的那段选着的话两半都选着
  marksChanged({ popAt: r.at });
}

/** 右键切点：删掉第 k 刀，和前一段合成一段。 */
function mergeAt(k) {
  if (S.busy) return;
  const r = M.merge(S.segs, S.sel, k);
  if (r.error) return;
  pushUndo();
  S.segs = r.segs;
  S.sel = r.sel;
  if (S.pick.length) Object.assign(S, M.pickAfterMerge(S.pick, k, r.segs)); // 合成的那段有一半选着就算选着
  if (r.base) {
    // 只剩一段：当没切过，时间轴两头就是这一段
    S.start = r.base.start;
    S.end = r.base.end;
  }
  marksChanged();
}

/** ⌘Z：撤销最后一次切 / 删。有可撤销的才返回 true。 */
function undoMarks() {
  if (S.busy) return false;
  const u = S.undo.pop();
  if (!u) return false;
  S.segs = u.segs;
  S.sel = u.sel;
  S.pick = u.pick || [];
  if (!S.segs.length) {
    S.start = u.start;
    S.end = u.end;
  }
  marksChanged();
  return true;
}

/** 选中第 i 段（再点同一段取消）：预览只循环这一段、从它开头放；播放 / 暂停状态不变。 */
function selectSeg(i) {
  if (S.busy || i < 0 || i >= S.segs.length) return;
  S.sel = S.sel === i ? -1 : i;
  S.pick = [];
  S.anchor = i;
  marksChanged({ sync: false, seek: rangeNow().start });
}

/** 画切点、段号、选中那段的描边（细条和展开后的时间轴共用这一套，样式由 .collapsed 切换）。 */
function renderMarks(popAt) {
  const box = $('marks');
  box.innerHTML = '';
  const n = S.segs.length;
  if (!n || !S.duration) return;
  const frac = (t) => (Math.max(0, Math.min(S.duration, t)) / S.duration) * 100;
  const maxSec = segMaxSec();
  const long = new Set(M.longOnes(S.segs, maxSec)); // 太长的段：段号标红
  // 切点、段号画在切出来时的位置：精修只改这一段自己的起止，切点不跟着动（选中那段的实际起止看描边和把手）
  S.segs.forEach((s, i) => {
    const at = s.orig ? s.orig.start : s.start;
    if (i > 0) {
      const c = document.createElement('i');
      c.className = `mcut${popAt === i ? ' pop' : ''}`;
      c.style.left = `${frac(at)}%`;
      c.title = `第 ${i} 刀（${fmtClock(at)}）· 右键删掉这一刀`;
      c.dataset.k = String(i);
      box.appendChild(c);
    }
    const b = document.createElement('span');
    b.className = `mnum${i === S.sel || S.pick.includes(i) ? ' on' : ''}${s.done ? ' done' : ''}${long.has(i) ? ' long' : ''}`;
    b.textContent = String(i + 1);
    b.style.left = `${frac(at)}%`;
    b.title = `第 ${i + 1} 段 ${fmtClock(s.start)}–${fmtClock(s.end)}${s.done ? '（导出过）' : ''}${long.has(i) ? `（超过 ${maxSec} 秒，可能导不出来：在这段里再按 ${hk('mark')} 切，或者选中它剪短）` : ''} · 点一下只看这一段${i === S.sel ? '（再点取消）' : ''} · ⌘点加进多选，导出时按时间顺序拼成一张`;
    b.dataset.i = String(i);
    box.appendChild(b);
  });
  for (const i of S.sel >= 0 ? [S.sel] : S.pick) {
    const s = S.segs[i];
    const o = document.createElement('i');
    o.className = 'msel';
    o.style.left = `calc(${frac(s.start)}% - 3px)`;
    o.style.width = `calc(${frac(s.end) - frac(s.start)}% + 6px)`;
    box.appendChild(o);
  }
  // 多选（A 版）：选中的几段中间没选的变暗（展开时，和单选时选段外面一样暗；收起时看选中段的描边）
  if (isMulti()) {
    for (const i of M.skipped(S.segs, S.pick)) {
      const s = S.segs[i];
      const d = document.createElement('i');
      d.className = 'mskip';
      d.style.left = `${frac(s.start)}%`;
      d.style.width = `${frac(s.end) - frac(s.start)}%`;
      box.prepend(d);
    }
  }
  // 段太短、段号挤在一起：后面那个先藏起来（选中的那个总显示）
  let lastRight = -Infinity;
  for (const b of box.querySelectorAll('.mnum')) {
    const r = b.getBoundingClientRect();
    if (r.left < lastRight + 2 && !b.classList.contains('on')) b.classList.add('squeezed');
    else lastRight = r.right;
  }
}

/** 换文件、移除之前：这个文件切过的段记下来（这次运行里重新打开还在）。 */
function rememberMarks() {
  if (!S.file) return;
  if (S.segs.length) MARKS_MEM.set(markKey(), { segs: copySegs(S.segs), markSet: S.markSet, markRec: S.markRec, markPrefix: S.markPrefix });
  else MARKS_MEM.delete(markKey());
}

/** 录屏的段：切、删、改起止都同步回菜单栏那几行（停 0.3 秒再同步）。主界面自己切的段导出时才进菜单栏。 */
function scheduleSync() {
  if (!S.markRec) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 300);
}
async function syncNow() {
  clearTimeout(syncTimer);
  if (!S.markRec || !S.file) return;
  const file = S.file;
  const segs = S.segs.map((s) => ({ gid: s.gid || null, start: s.start, end: s.end }));
  let r;
  try {
    r = await api.marksSync({ file, set: S.markSet, prefix: S.markPrefix, segs });
  } catch {
    return;
  }
  if (S.file !== file || !Array.isArray(r) || r.length !== S.segs.length) return; // 期间又变了：下一次同步会补上
  r.forEach((x, i) => { S.segs[i].gid = x.gid; });
}

/** 展开 / 收起时间轴（作者选「重启后也记住（推荐）」：换段、换素材、重启都保持）。 */
function setTimeline(open, { save = true } = {}) {
  S.tlOpen = open;
  $('trim').classList.toggle('collapsed', !open);
  $('strip').title = open ? '拖两头的把手剪头尾；点一下跳到那一刻；双击一段只看这一段' : `点一下跳到那一刻；${hk('mark')} 切一刀；双击一段只看这一段`;
  if (save) api.setPref({ timelineOpen: open });
}

/** 切过刀、没选中某段：标题行只说几段，不预估（每段各算一遍太慢）。 */
function showSegsSummary() {
  clearTimeout(timer);
  clearTimeout(liveTimer);
  S.estSeq++;
  S.liveSeq++;
  S.liveKey = null;
  const n = S.segs.length;
  const left = S.segs.filter((s) => !s.done).length;
  const { fps, maxF, maxSec } = segLimit();
  const long = M.longOnes(S.segs, maxSec).filter((i) => !S.segs[i].done);
  if (long.length) {
    // 有段太长：先说这个（只切了一刀、后面那段很长时，导出要等失败了才知道 → 提前提醒，作者）
    setSize({
      cls: 'bad', big: `${n} 段`, label: '',
      verdict: `第 ${long.map((i) => i + 1).join('、')} 段超过 ${maxSec} 秒，可能导不出来，再切几刀或剪短`,
      details: [`每秒 ${fps} 帧最多 ${maxF} 帧（约 ${maxSec} 秒）。在太长的那段里播放到要切的地方按 ${hk('mark')} 再切，或者点它的段号、展开时间轴拖把手剪短。段号标红的就是太长的。`, left === n ? `切成 ${n} 段，导出时每段一张。` : `还有 ${left} 段没导，导出时只导它们。`, ''],
    });
    return;
  }
  setSize({
    cls: 'idle', big: `${n} 段`, label: '',
    verdict: left === n ? `切成 ${n} 段，导出时每段一张` : left ? `还有 ${left} 段没导，导出时只导它们` : `${n} 段都导过了`,
    details: ['点段号（或双击一段）只看那一段：体积只算它，「导出」也只导它；再点一次或按 Esc 取消。', '⌘点几个段号（⇧点连选、⌘A 全选）：按时间顺序拼成一张导出。', left < n ? '导过的段号旁边有 ✓；想重导哪段，选中它再导出。' : ''],
  });
}

/** 第 i 段导出时带给主进程的：段号、起止（名字带「_第N段」，结果归到菜单栏这一段那一行）。 */
function segArgs(i) {
  const s = S.segs[i];
  return { range: { n: i + 1, start: s.start, end: s.end, set: S.markSet, prefix: S.markPrefix, rec: S.markRec }, groupId: s.gid || undefined };
}

/** 没选中某段时导出：把还没导过的段各导一张（作者选「选中哪段导哪段（推荐）」），用当前的一键 / 自定义设置，一段一段导。 */
async function exportSegs() {
  const todo = S.segs.map((_, i) => i).filter((i) => !S.segs[i].done);
  if (!todo.length) {
    // 都导过了：把说明面板打开，告诉用户怎么重导某一段（不然点了没反应）
    showSegsSummary();
    $('result').classList.add('hidden');
    openPanel(true);
    return;
  }
  S.busy = true; // 先锁住再同步（10-20 审查 C1）
  if (S.markRec) await syncNow().catch(() => {});
  if (S.mode === 'custom' && S.cropEditing) lockCrop();
  $('export').classList.add('hidden');
  $('cancel').classList.remove('hidden');
  $('result').classList.add('hidden');
  openPanel(false);
  $('sizeVerdict').classList.add('hidden');
  $('sizeLabel').classList.add('hidden');
  $('progress').classList.remove('hidden');
  const t0 = Date.now();
  const tick = () => { $('elapsed').textContent = `已用 ${Math.floor((Date.now() - t0) / 1000)} 秒`; };
  tick();
  const clock = setInterval(tick, 500);
  const done = [];
  // 参数和各段起止在开头就定下来（10-20 审查 C2：原来每段重新取，导到一半改用途、拖把手，后面的段跟着变）
  const base = exportArgs();
  const editBase = { mode: S.mode, custom: S.mode === 'custom' ? { ...S.custom } : null, crop: S.mode === 'custom' ? S.crop : null };
  const plan = todo.map((i) => ({ i, s: S.segs[i], start: S.segs[i].start, end: S.segs[i].end, seg: segArgs(i) }));
  try {
    for (let k = 0; k < plan.length; k++) {
      const { i, s, start, end, seg } = plan[k];
      S.progPrefix = `第 ${k + 1}/${plan.length} 个（第 ${i + 1} 段）`;
      $('progressText').textContent = `${S.progPrefix} · 开始…`;
      const args = { ...base, start, dur: end - start, ...seg };
      args.edit = { start, dur: end - start, ...editBase };
      let r;
      try {
        r = await api.convert(args);
      } catch (e) {
        const msg = String(e.message || e);
        r = { ok: false, cancelled: msg.includes('已取消'), reason: msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
      }
      if (S.mode === 'auto' && r.chosen) S.lastChosen = r.chosen;
      if (r.groupId) {
        s.gid = r.groupId;
        s.done = true;
      }
      done.push({ i, r });
      renderMarks();
      if (r.cancelled) break;
    }
  } finally {
    clearInterval(clock);
    S.busy = false;
    S.progPrefix = '';
    $('export').classList.remove('hidden');
    $('cancel').classList.add('hidden');
    $('progress').classList.add('hidden');
    $('sizeVerdict').classList.remove('hidden');
    $('sizeLabel').classList.remove('hidden');
  }
  const sec = (Date.now() - t0) / 1000;
  if (done.every((x) => x.r.groupId) && !done.some((x) => x.r.cancelled)) {
    // 全导好了：不弹面板（作者），标题行写一句，点开能看每段多大
    $('result').classList.add('hidden');
    openPanel(false);
    const sizes = done.map(({ i, r }) => `第 ${i + 1} 段 ${fmtMB(r.bytes || r.chosen?.bytes || 0)}`);
    setSize({ cls: 'ok', big: `${done.length} 段`, label: '已导出', verdict: `导出好了 ${done.length} 段，在菜单栏列表里`, details: [sizes.join(' · '), `用时 ${sec.toFixed(0)} 秒`, ''] });
    return;
  }
  showSegsSummary();
  showSegsResult(done, sec);
}

/** 导了几段：每段一行结果，「在访达中显示」第一张。 */
function showSegsResult(list, sec) {
  const el = $('result');
  el.classList.remove('hidden');
  openPanel(true);
  el.innerHTML = '';
  const line = (html) => { const d = document.createElement('div'); d.innerHTML = html; el.appendChild(d); };
  const good = list.filter((x) => x.r.groupId);
  const cancelled = list.some((x) => x.r.cancelled);
  el.classList.toggle('fail', !good.length && !cancelled);
  const head = cancelled ? `已取消（导出了 ${good.length} 段）` : !good.length ? `这 ${list.length} 段都没做成` : good.length === list.length ? `导出好了 ${good.length} 段` : `导出了 ${good.length} 段，${list.length - good.length} 段没做成`;
  line(`<b>${head}</b> · 用时 ${sec.toFixed(0)} 秒`);
  for (const { i, r } of list) {
    const c = r.chosen;
    const what = r.cancelled ? '取消了' : r.groupId ? (c ? `${c.width} 宽 · 每秒 ${c.fps} 帧 · <b>${fmtMB(c.bytes)}</b>` : esc(r.detail || '好了')) : `<span class="warn">没做成：${esc(r.reason || r.detail || '')}</span>`;
    line(`第 ${i + 1} 段：${what}`);
  }
  if (good.length) {
    const b = document.createElement('button');
    b.textContent = '在访达中显示';
    b.onclick = () => api.reveal(good[0].r.output);
    el.appendChild(b);
  }
}

/** 调试（GIFKIT_DEBUG_MARKS=1，配 GIFKIT_OPEN、GIFKIT_SHOT）：切两刀、选段、展开、删刀、撤销、收起，每步打印段、截一张图。 */
async function runMarksTest() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !activeVideo(); i++) await sleep(100);
  const v = $('video');
  const st = (tag) => api.debugLog(`${tag}：${JSON.stringify({ 段: S.segs.map((s) => [s.start, s.end]), 选中: S.sel + 1, 起止: [S.start, S.end], 展开: S.tlOpen, 预览高: Math.round($('drop').getBoundingClientRect().height), 提示: $('markHint').textContent, 体积说明: $('sizeVerdict').textContent })}`);
  const snap = async (name) => { await sleep(450); await api.debugSnap(name); };
  setTimeline(false, { save: false });
  await sleep(500);
  st('打开');
  await snap('打标_1_打开');
  pausePreview();
  v.currentTime = S.duration * 0.3; await sleep(200); cutHere(); st('在 30% 切一刀');
  v.currentTime = S.duration * 0.62; await sleep(200); cutHere(); st('在 62% 再切一刀');
  v.currentTime = S.duration * 0.62 + 0.3; await sleep(200); cutHere(); st('离上一刀 0.3 秒（应该切不了）');
  await snap('打标_2_切了两刀');
  selectSeg(1); st('选中第 2 段');
  for (let i = 0; i < 100 && $('sizeBox').classList.contains('busy'); i++) await sleep(100);
  st('第 2 段预估出来');
  await snap('打标_3_选中第2段');
  setTimeline(true, { save: false }); st('展开');
  await snap('打标_4_展开');
  setTrim(S.start + 0.5, S.end + 1); st('把手：第 2 段开头往后 0.5 秒、结尾伸进第 3 段 1 秒');
  await snap('打标_5_精修第2段');
  selectSeg(1); st('取消选中');
  await snap('打标_5b_展开没选中');
  mergeAt(2); st('删掉第 2 刀');
  undoMarks(); st('撤销');
  setTimeline(false, { save: false }); st('收起');
  await snap('打标_6_收起');
  api.debugShot();
}

/** 调试（GIFKIT_DEBUG_MARKS=export）：切两刀 → 没选中时导出（各导一张）→ 选中第 2 段、精修一下再导出；打印结果。 */
async function runMarksExportTest() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !activeVideo(); i++) await sleep(100);
  const v = $('video');
  const st = (tag) => api.debugLog(`${tag}：${JSON.stringify({ 段: S.segs.map((s) => [s.start, s.end, s.gid, s.done]), 选中: S.sel + 1, 体积说明: $('sizeVerdict').textContent, 数字: $('sizeBig').textContent, 面板开着: !$('sizePanel').classList.contains('hidden'), 面板里: $('sizeRange').textContent + ' | ' + $('tierLine').textContent, 结果卡片: $('result').classList.contains('hidden') ? '没有' : $('result').innerText.replace(/\s+/g, ' ').slice(0, 200) })}`);
  pausePreview();
  v.currentTime = S.duration * 0.35; await sleep(200); cutHere();
  v.currentTime = S.duration * 0.7; await sleep(200); cutHere();
  st('切两刀');
  await doExport();
  st('没选中、点导出（每段各导一张）');
  selectSeg(1);
  setTrim(S.start + 0.3, S.end);
  for (let i = 0; i < 100 && $('sizeBox').classList.contains('busy'); i++) await sleep(100);
  st('选中第 2 段、开头往后 0.3 秒');
  await doExport();
  st('导出第 2 段');
  selectSeg(1);
  st('取消选中');
  await doExport();
  st('再点导出（都导过了）');
  api.debugShot();
}

/** 调试（GIFKIT_DEBUG_MARKS=long，配一段几分钟的长视频）：打开要多久、缩略图要多久；在 100、110 秒切两刀，导出中间那 10 秒；两头的段太长时的提醒、导出结果。 */
async function runMarksLongTest() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = performance.now();
  const ms = () => `${Math.round(performance.now() - t0)} 毫秒`;
  for (let i = 0; i < 300 && !activeVideo(); i++) await sleep(50);
  api.debugLog(`长视频：${S.duration} 秒，预览能放（从开始预估算起）：${ms()}`);
  for (let i = 0; i < 600 && !$('thumbs').children.length; i++) await sleep(50);
  api.debugLog(`缩略图出来：${ms()}，${$('thumbs').querySelectorAll('img').length} 张`);
  const v = $('video');
  const st = (tag) => api.debugLog(`${tag}：${JSON.stringify({ 段: S.segs.map((s) => [s.start, s.end]), 选中: S.sel + 1, 体积说明: $('sizeVerdict').textContent, 数字: $('sizeBig').textContent, 红的段号: [...document.querySelectorAll('.mnum.long')].map((b) => b.textContent), 结果卡片: $('result').classList.contains('hidden') ? '没有' : $('result').innerText.replace(/\s+/g, ' ').slice(0, 260) })}`);
  pausePreview();
  v.currentTime = 100; await sleep(400); cutHere();
  v.currentTime = 110; await sleep(400); cutHere();
  await sleep(300);
  st('在 100、110 秒切两刀（没选中）');
  await api.debugSnap('长视频_切了两刀');
  selectSeg(1);
  for (let i = 0; i < 200 && $('sizeBox').classList.contains('busy'); i++) await sleep(100);
  st('选中第 2 段（10 秒）');
  let t1 = performance.now();
  await doExport();
  st(`导出第 2 段，用时 ${Math.round(performance.now() - t1)} 毫秒`);
  selectSeg(1);
  t1 = performance.now();
  await doExport();
  st(`没选中再导出（第 1、3 段太长），用时 ${Math.round(performance.now() - t1)} 毫秒`);
  await api.debugSnap('长视频_导出后');
  api.debugShot();
}

// ---------- 批量：交给菜单栏那条队列 ----------
/** 拖进多个或文件夹（「导入」多选也一样）：交给菜单栏的图片列表批量压，按这里当前的用途（作者）。正在精修的那张不受影响。 */
async function handoff(paths) {
  showHandoff('正在交给菜单栏…', null);
  let r;
  try {
    r = await api.handoffBatch({ paths, preset: S.preset });
  } catch (e) {
    showHandoff(`没交出去：${String(e.message || e)}`, null, 'err');
    return;
  }
  if (!r.added) {
    showHandoff(r.rejected ? `${r.rejected} 个超出处理范围，没有加（原因看菜单栏）` : r.folders ? '文件夹里没找到 GIF 或视频（只看第一层）' : '没有可以压的 GIF 或视频', null, 'err');
    return;
  }
  const p = S.presets.find((x) => x.id === S.preset);
  const which = p ? `${p.name.replace('公众号 · ', '')} ${(p.limit / 1e6).toFixed(1)}MB` : '';
  showHandoff(`已交给菜单栏批量压缩 ${r.added} 个（${which}），进度和结果看菜单栏的图片列表${r.rejected ? `；${r.rejected} 个超出处理范围没加` : ''}。${r.where.text}`, r.where.dir);
}

function showHandoff(text, dir, cls = '') {
  $('handoff').className = `handoff ${cls}`;
  $('handoffText').textContent = text;
  S.handoffDir = dir;
  $('handoffOpen').classList.toggle('hidden', !dir);
}

function bindHandoff() {
  $('handoffOpen').onclick = () => { if (S.handoffDir) api.openFolder(S.handoffDir); };
  $('handoffClose').onclick = () => $('handoff').classList.add('hidden');
  api.onBatchDone((d) => showHandoff(d.text, d.dir, d.bad ? 'err' : 'done'));
}

/** 「导入」和「选择文件…」：选一个文件进精修；选多个或选了文件夹就交给菜单栏批量压。 */
async function pickAndOpen() {
  const r = await api.pickFile();
  if (!r?.paths?.length) return;
  if (r.paths.length > 1 || r.anyDir) await handoff(r.paths);
  else await openFile(r.paths[0]);
}

// ---------- 设置和帮助（10-22 设置卷第一批；作者选「设置｜帮助」两页、设置说明悬停浮出、帮助两列小卡折叠） ----------
const H = window.Hotkeys;
/** 某个快捷键现在显示成什么（⌃⌥R、⌥空格） */
const hk = (w) => S.prefs?.hotkeyText?.[w] || H.toText(H.DEFAULTS[w]);

function openSettings(tab) {
  showNote('hkErr', ''); // 上次没改成的红字别一直挂着
  setTab(tab || S.prefs?.settingsTab || 'set', { save: false });
  renderSettings();
  $('help').classList.remove('hidden');
}
function closeSettings() {
  stopHkRecord();
  $('help').classList.add('hidden');
}
function setTab(tab, { save = true } = {}) {
  // 从更新日志那页回来（第二批）：切页按钮回来，更新日志收起
  $('setTabs').classList.remove('hidden');
  $('clHead').classList.add('hidden');
  $('clView').classList.add('hidden');
  for (const b of $('setTabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  $('setBody').classList.toggle('hidden', tab !== 'set');
  $('helpBody').classList.toggle('hidden', tab !== 'help');
  if (save && S.prefs && S.prefs.settingsTab !== tab) savePrefs({ settingsTab: tab }); // 记住上次停在哪页
}
/** 改设置：交给主进程（它校验、生效、存盘、通知菜单栏），回来的是改完的全部设置 */
async function savePrefs(patch) {
  const r = await api.settingsSet(patch);
  if (r?.prefs) applyPrefs(r.prefs);
  return r || { ok: false, error: '没改成' };
}
function applyPrefs(p) {
  S.prefs = p;
  CUSTOM_DEF.fill = p.fill;
  renderSettings();
}
function renderSettings() {
  const p = S.prefs;
  if (!p) return;
  const set = (id, on) => { $(id).checked = Boolean(on); };
  set('st_login', p.login?.on);
  $('st_login').disabled = !p.login?.canSet;
  set('st_openMain', p.openMainOnStart);
  set('st_notifyDone', p.notifyDone);
  set('st_dropBlock', p.dropBlockOn); // Windows 屏幕边的投放块（后备，默认关；Mac 上这一行藏着）
  set('st_fill', p.fill);
  set('st_rememberPreset', p.rememberPreset);
  set('st_rememberTimeline', p.rememberTimeline);
  set('st_recAuto', p.recAuto);
  set('st_recMark', p.recMark); // 11.12 录屏打标（和录屏小胶囊、菜单栏顶上是同一个）
  document.querySelectorAll('#st_recFps button').forEach((b) => b.classList.toggle('on', Number(b.dataset.f) === (p.recFps || 60))); // 11.13 录制帧率
  set('st_log', p.oplog);
  showNote('st_loginNote', p.login?.note || '');
  for (const w of ['rec', 'mark']) {
    if (S.hkRecording !== w) $(`hk_${w}`).textContent = hk(w);
    $(`hk_${w}Reset`).disabled = H.normalize(p.hotkeys[w]) === H.normalize(p.hotkeyDefaults[w]);
  }
  // 结果放哪（第二批）：选了文件夹那一格显示文件夹名，悬停出完整路径；文件夹不在了标黄
  $('st_outSrc').classList.toggle('on', !p.outDir);
  $('st_outDir').classList.toggle('on', Boolean(p.outDir));
  $('st_outDir').classList.toggle('warn', Boolean(p.outDir) && !p.outDirOk);
  $('st_outDirName').textContent = p.outDir ? p.outDirName : '指定文件夹…';
  // 录像放在（试用反馈 9.6b）
  $('st_recDirName').textContent = p.recDirName || 'GGIF录屏';
  $('st_recDir').classList.toggle('warn', p.recDirOk === false);
  $('st_recDir').dataset.tip = p.recDirOk === false ? `${p.recDirText} 不在了：录像先放回 下载/GGIF录屏（点一下换一个）` : `${p.recDirText || '~/Downloads/GGIF录屏'}（点一下换一个）`;
  $('st_outDir').dataset.tip = !p.outDir ? '选一个文件夹，结果都放进去' : p.outDirOk ? `${p.outDirText}（点一下换一个）` : `${p.outDirText} 不在了：结果先放回原文件旁边（点一下换一个）`;
  $('st_version').textContent = `版本 ${p.version}`;
  renderHotkeyTexts();
}
const showNote = (id, text) => { $(id).textContent = text; $(id).classList.toggle('hidden', !text); };
/** 界面各处写着的快捷键跟着设置变：录屏按钮提示、空状态、帮助、打标提示、段号提示、时间轴提示 */
function renderHotkeyTexts() {
  for (const el of document.querySelectorAll('[data-hk]')) el.textContent = hk(el.dataset.hk);
  $('recBtn').dataset.tip = `录屏：选屏幕或窗口，框出来后拖边角改大小；${hk('rec')} 开始 / 停止，开了「打标」时录的时候 ${hk('mark')} 切一刀；也可以双击菜单栏图标`;
  if (S.file) {
    renderMarkHint();
    renderMarks();
  }
  $('strip').title = S.tlOpen ? $('strip').title : `点一下跳到那一刻；${hk('mark')} 切一刀；双击一段只看这一段`;
}

/** 更新日志（第二批，作者选「A 面板里一页」）：一个版本一张卡，新的在上；左上「← 设置」返回 */
function openChangelog() {
  $('setTabs').classList.add('hidden');
  $('clHead').classList.remove('hidden');
  $('setBody').classList.add('hidden');
  $('helpBody').classList.add('hidden');
  $('clView').innerHTML = (window.CHANGELOG || []).map((v) => `<section class="clCard"><h3>${esc(v.version)}<span>${esc(v.date)}</span></h3><ul>${v.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>`).join('');
  $('clView').classList.remove('hidden');
  $('clView').scrollTop = 0;
}

/** 键帽：点一下等你按新的组合；Esc、点别处取消。录的时候先放掉全局的「开始 / 停止」，不然按到它会直接开始录屏 */
function startHkRecord(w) {
  stopHkRecord();
  S.hkRecording = w;
  const b = $(`hk_${w}`);
  b.classList.add('recording');
  b.textContent = '按下新的组合…';
  showNote('hkErr', '');
  api.hotkeyCapture?.(true);
}
function stopHkRecord() {
  if (!S.hkRecording) return;
  $(`hk_${S.hkRecording}`).classList.remove('recording');
  S.hkRecording = null;
  api.hotkeyCapture?.(false);
  renderSettings();
}
async function onHkKey(e) {
  if (!S.hkRecording) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // 别让主界面的按键（Esc 关面板、切一刀、空格播放）也收到
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return stopHkRecord();
  const r = H.fromEvent(e);
  if (!r) return; // 还只按着修饰键
  const w = S.hkRecording;
  const err = r.error || H.check(r.accel, S.prefs.hotkeys[w === 'rec' ? 'mark' : 'rec']);
  stopHkRecord();
  if (err) return showNote('hkErr', err); // 不行的组合：红字说原因，键不变
  const res = await savePrefs({ hotkeys: { [w]: r.accel } });
  showNote('hkErr', res.error || '');
}

function bindSettings() {
  for (const b of $('setTabs').children) b.onclick = () => setTab(b.dataset.tab);
  const tog = (id, key) => {
    $(id).onchange = async () => {
      const r = await savePrefs({ [key]: $(id).checked });
      if (key === 'login' && r.error) showNote('st_loginNote', r.error); // 设不上：开关回到原样，下面写原因
    };
  };
  tog('st_login', 'login');
  tog('st_openMain', 'openMainOnStart');
  tog('st_notifyDone', 'notifyDone');
  tog('st_dropBlock', 'dropBlockOn');
  tog('st_fill', 'fill');
  tog('st_rememberPreset', 'rememberPreset');
  tog('st_rememberTimeline', 'rememberTimeline');
  tog('st_recAuto', 'recAuto');
  tog('st_recMark', 'recMark');
  document.querySelectorAll('#st_recFps button').forEach((b) => { b.onclick = () => savePrefs({ recFps: Number(b.dataset.f) }); }); // 11.13 和录屏小胶囊上的是同一个
  for (const w of ['rec', 'mark']) {
    $(`hk_${w}`).onclick = () => (S.hkRecording === w ? stopHkRecord() : startHkRecord(w));
    $(`hk_${w}Reset`).onclick = async () => {
      stopHkRecord();
      const r = await savePrefs({ hotkeys: { [w]: S.prefs.hotkeyDefaults[w] } });
      showNote('hkErr', r.error || '');
    };
  }
  tog('st_log', 'oplog');
  $('st_logOpen').onclick = () => api.openLogDir();
  $('st_changelog').onclick = openChangelog;
  $('clBack').onclick = () => setTab('set', { save: false });
  $('st_outSrc').onclick = () => savePrefs({ outDir: null });
  $('st_outDir').onclick = async () => {
    const r = await api.pickOutDir();
    if (r?.prefs) applyPrefs(r.prefs);
  };
  $('st_recDir').onclick = async () => {
    const r = await api.pickRecDir();
    if (r?.prefs) applyPrefs(r.prefs);
  };
  $('st_recDirOpen').onclick = () => api.openRecDir();
  document.addEventListener('keydown', onHkKey, true);
  document.addEventListener('mousedown', (e) => { if (S.hkRecording && !e.target.closest('.hkKey')) stopHkRecord(); }, true);
  // 帮助页：点哪张开哪张（一次一张），点开的那张点标题收起；展开着时点内容不收起
  for (const c of $('helpBody').querySelectorAll(':scope > .hcard')) {
    c.addEventListener('click', (e) => {
      if (c.classList.contains('open') && !e.target.closest('h3')) return;
      const open = !c.classList.contains('open');
      for (const x of $('helpBody').querySelectorAll(':scope > .hcard.open')) x.classList.remove('open');
      c.classList.toggle('open', open);
    });
  }
  api.onSettingsChanged?.((p) => applyPrefs(p)); // 菜单栏、录屏小胶囊那边改了（比如「录完自动压」）
  renderSettings();
}

init();
