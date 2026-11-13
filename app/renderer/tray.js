// 菜单栏小面板：一行一个素材，后面是版本小块（圆点 + 实际大小）。
// 拖版本 = 拖出真实文件（拖进公众号就是上传）；单击版本 = 快速查看；双击行 = 打开完整界面编辑；其他操作只在右键（作者方案）。
// 拖缩略图 = 拖顶上选中那档的结果（10-23 试用反馈 9.10，作者选「跟着顶上选的档」）。
const $ = (id) => document.getElementById(id);
const T = window.tray;
const CMD = (e) => (T?.platform === 'win32' ? e.ctrlKey : e.metaKey); // ⌘ 那些组合键：Windows 上是 Ctrl（Windows版 11-08）
const S = { groups: [], presets: [], preset: null, dual: false, compact: null, lastH: 0, rec: { state: 'idle', session: null, hotkey: '⌃⌥R', markKey: '⌥空格' }, recHidden: null, sel: new Set(), anchor: null }; // compact：小条里要列的素材 id（新的在前）；sel：选中的行（10-20 多选）

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)}M` : `${Math.max(1, Math.round(b / 1e3))}K`);
const presetName = (id) => `${(S.presets.find((p) => p.id === id)?.limit / 1e6).toFixed(1)}MB 档`;

function chipHtml(c, g = {}) {
  const dots = `<span class="dots">${c.dots.map((d) => `<i class="dot ${d}"></i>`).join('')}</span>`;
  const which = c.dots.map(presetName).join('、');
  if (c.state === 'done') {
    const tip = `${which}${c.isSource ? '（原文件已合规）' : ''} · ${c.width}×${c.height} · ${c.durationSec ? `${c.durationSec.toFixed(1)} 秒` : ''}\n单击预览，拖出去就是这个文件，右键看更多`;
    return `<div class="chip done${c.fits === false ? ' over' : ''}" draggable="true" data-vid="${c.versionId}" data-file="${esc(c.file)}" data-dots="${c.dots.join(',')}" title="${esc(tip)}">${dots}${short(c.bytes)}</div>`;
  }
  if (c.state === 'running') {
    const sec = c.startedAt ? `${Math.floor((Date.now() - c.startedAt) / 1000)} 秒` : '';
    return `<div class="chip busy" data-vid="${c.versionId}" title="${esc(`${which}：${c.stage || '处理中'}`)}">${dots}<span class="spin"></span>${sec}</div>`;
  }
  if (c.state === 'pending') {
    // 录屏切出来的片段，还没压（录屏卷 3.1b）：单击预览这段录像，双击行进主界面剪，右键「压一份」，或者用顶上的「全部压缩」
    const sec = c.durationSec ? `${c.durationSec.toFixed(1)} 秒` : '';
    // 录屏的一段：单击就在主界面打开整段录像、这段选好（QuickLook 没法只放一段）
    const open = g.range ? 'data-open="1"' : c.file ? `data-file="${esc(c.file)}" data-nodrag="1"` : '';
    const tip = g.range ? '录屏的一段，还没压\n单击或双击：在主界面打开整段录像、这段已选好，两头把手可以拖到整段任何位置\n右键可以单独压' : '录屏片段，还没压\n单击预览；双击这一行进主界面剪头尾、裁画面；右键可以单独压';
    return `<div class="chip pending" data-vid="${c.versionId}" ${open} title="${esc(tip)}">待压缩${sec ? ` · ${sec}` : ''}</div>`;
  }
  if (c.state === 'waiting') return `<div class="chip busy" data-vid="${c.versionId}" title="${esc(which)}">${dots}排队</div>`;
  // 结果在没接的外接硬盘上（10-20 审查 M2）：不能点、不能拖，接上就恢复
  if (c.state === 'offline') return `<div class="chip off" data-vid="${c.versionId}" title="${esc(`${which} · 文件在外接硬盘「${c.volume || ''}」上，硬盘没接上；接上就恢复`)}">${dots}硬盘没接</div>`;
  // 没做成（作者选「A 只改版本块」）：红块显眼，点一下重试；「太长」的点了打开完整界面剪短；悬停写原因
  if (c.tooLong) return `<div class="chip failed" data-vid="${c.versionId}" data-edit="1" title="${esc(`${which}：太长了，剪短再压\n点一下打开完整界面剪`)}">${dots}太长</div>`;
  return `<div class="chip failed" data-vid="${c.versionId}" data-retry="1" title="${esc(`${which}没做成：${c.error || '原因没记下来'}\n点一下重试；右键可以「不要这一档」`)}">${dots}${RETRY_ICON}没做成</div>`;
}
const RETRY_ICON = '<svg class="rt" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.6 11.2A5.8 5.8 0 1 1 13.9 5.6"/><path d="M14.6 2.8v3.4h-3.4"/></svg>';

/** 拖缩略图拖哪块：这一行里带顶上选中那档圆点的、压好了的那块（4.8M 那份也满足 9.9 档时带两个圆点，也算） */
const thumbChip = (g) => g.chips.find((k) => k.state === 'done' && k.file && k.dots.includes(S.preset));
function thumbTip(g) {
  const k = thumbChip(g);
  return k ? `拖缩略图 = 这一行 ${presetName(S.preset)}那份（${short(k.bytes)}，跟顶上亮着的档，两个都亮拿 9.9）` : `这一行还没有 ${presetName(S.preset)}的结果，拖不动（顶上换个档，或者拖版本块）`;
}
/** 拖缩略图（10-23 试用反馈 9.10）：拖顶上选中那档；选中了几行、拖的是其中一行，就几行一起拖，拖完取消选中 */
function dragThumb(gid) {
  if (!gid) return;
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 1500);
  const multi = S.sel.size > 1 && S.sel.has(gid);
  const files = [];
  let missing = 0;
  for (const id of multi ? visibleIds().filter((x) => S.sel.has(x)) : [gid]) {
    const k = S.groups.find((x) => x.id === id) && thumbChip(S.groups.find((x) => x.id === id));
    if (k) files.push(k.file);
    else missing++;
  }
  if (!files.length) {
    toast(`${multi ? '这几行' : '这一行'}还没有 ${presetName(S.preset)}的结果：顶上换个档，或者拖版本块`, true);
    return;
  }
  if (missing) toast(`有 ${missing} 行没有 ${presetName(S.preset)}的结果，这次没拖它们`);
  if (multi) {
    S.sel.clear(); // 每次多选只负责一次批量操作（作者）
    renderSel();
  }
  dragOut(files);
}

/**
 * 往外拖（版本块、缩略图）：记下「正在往外拖」，面板自己不张嘴、不接（10-23 作者：「我从列表内拖出来，列表会误以为我要拖进去，上面那个嘴会张开」；
 * 在面板里松手原来还会把它当新素材导进来）。拖完（鼠标回到面板、面板收起或打开）清掉，最多认 60 秒。
 */
const OUT_MAX_MS = 60000;
const draggingOut = () => Boolean(S.dragOut) && Date.now() - S.dragOut < OUT_MAX_MS;
function dragOut(files) {
  S.dragOut = Date.now();
  T.drag(files);
}
function dragOutDone() {
  if (!S.dragOut) return;
  S.dragOut = 0;
  T.dragDone?.();
}

/** 悬停一行浮出的三个小按钮（10-22 重做）：快速查看、编辑（主界面）、在访达中显示。原来的单击版本块、双击行、右键菜单都照旧。 */
const ACT_ICON = {
  look: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.3"/></svg>',
  edit: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 16l1-4 8-8 3 3-8 8z"/></svg>',
  reveal: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.5 1.5h6.5A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/></svg>',
};
function rowActions(g) {
  const done = g.chips.find((c) => c.state === 'done' && c.file);
  const file = done?.file || g.source || '';
  // title=""：别让整行的长提示在这几个小按钮上又冒一遍；提示都向左展开（居中的会伸出行外：面板里被列表剪掉半截，小条里撑出滚动条，10-22）
  return `<div class="ract" title="">${file ? `<button class="ibtn xs tip-left" data-act="look" data-file="${esc(file)}" data-tip="快速查看${done ? '' : '（原素材）'}">${ACT_ICON.look}</button>` : ''}<button class="ibtn xs tip-left" data-act="edit" data-tip="编辑（打开完整界面）">${ACT_ICON.edit}</button>${file ? `<button class="ibtn xs tip-left" data-act="reveal" data-file="${esc(file)}" data-tip="在访达中显示">${ACT_ICON.reveal}</button>` : ''}</div>`;
}

function render() {
  const list = $('list');
  const scroll = list.scrollTop;
  const all = S.compact ? S.compact.map((id) => S.groups.find((g) => g.id === id)).filter(Boolean) : S.groups;
  const shown = S.compact ? all.slice(0, 3) : all;
  // 选中的行：已经不在列表里的去掉（被移除、文件没了的）
  for (const id of [...S.sel]) if (!S.groups.some((g) => g.id === id)) S.sel.delete(id);
  list.innerHTML = shown.map((g) => `
    <div class="row${S.sel.has(g.id) ? ' sel' : ''}" data-gid="${g.id}" title="${esc(g.source)}\n双击打开完整界面编辑；点空白处选中，⌘ 加选、⇧ 连选、拖空白处拉框；⌫ 从列表移除、⌘⌫ 移到废纸篓、右键看更多">
      <span class="thw">${g.thumb ? `<img class="thumb" src="${g.thumb}" alt="" draggable="true" title="${esc(thumbTip(g))}">` : `<div class="thumb" draggable="true" title="${esc(thumbTip(g))}"></div>`}</span>
      <div class="info">
        <div class="name">${esc(g.name)}</div>
        <div class="chips">${g.chips.map((c) => chipHtml(c, g)).join('')}</div>
      </div>
      ${rowActions(g)}
    </div>`).join('');
  list.scrollTop = scroll;
  $('empty').classList.toggle('show', !S.groups.length);
  renderRec();
  if (S.compact) {
    $('cmore').textContent = all.length > 3 ? `还有 ${all.length - 3} 个，点「全部」看` : '刚双击的';
    const h = contentHeight();
    if (h !== S.lastH) {
      S.lastH = h;
      T.compactHeight(h); // 行数、换行变了：让主进程跟着改小条的高度
    }
  }
}

/** 录屏：底栏按钮跟着状态变；刚录完的那次还有待压缩的片段，就在顶上留一条「全部压缩」。 */
function renderRec() {
  const st = S.rec.state;
  const b = $('recBtn');
  b.dataset.tip = st === 'recording' ? `停止录屏（${S.rec.hotkey}）` : st === 'idle' ? `录屏：选屏幕或窗口，框出来后拖边角改大小，${S.rec.hotkey} 开始 / 停止，开了「打标」时录的时候 ${S.rec.markKey} 切一刀；最长 90 秒；也可以双击菜单栏图标` : st === 'stopping' ? '正在切片段…' : '录屏中…';
  b.classList.toggle('recording', st === 'recording');
  b.disabled = !['idle', 'recording'].includes(st);
  const s = S.rec.session;
  const pend = s ? S.groups.filter((g) => g.pending === s.id) : [];
  // 11.12：打标关着时整段一份，常常一分多钟——超过 fitSec（37.5 秒，最低每秒 8 帧也超 300 帧）的一定压不进，不算进「全部压缩」，提示双击挑一段
  const fit = s?.fitSec || S.rec.fitSec || 37.5; // 11.13：录制时选了帧率的，这次录屏是 300 ÷ 帧率 秒
  const durOf = (g) => g.chips.find((c) => c.state === 'pending')?.durationSec || 0;
  const long = pend.filter((g) => durOf(g) > fit + 0.01);
  const left = pend.length - long.length;
  // 只在有「待压缩」的段时显示（带「全部压缩」）。0.3.0 加过开着自动压也显示「在压 / 压好了」，作者：「我感觉没必要啊……图片列表多出来了一个图，还在转圈，就足以证明正在压缩」，去掉
  const show = Boolean(s && pend.length && S.recHidden !== s.id && !S.compact);
  $('recSession').classList.toggle('hidden', !show);
  $('recAll').classList.toggle('hidden', !left);
  if (show) {
    const mmss = (d) => `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}`;
    const head = left ? `<b>刚录的 ${left} 段待压缩${long.length ? `，另有 ${long.length} 段太长、双击挑一段` : ''}</b>`
      : pend.length === 1 ? `<b>整段 ${mmss(durOf(long[0]))} 已存好：双击这一行，挑一段压</b>`
      : `<b>这 ${long.length} 段都超过 ${Math.floor(fit)} 秒：双击挑一段压</b>`;
    $('recText').innerHTML = `${head}<span class="recWhere" title="${esc(s.dir)}">片段在 ${esc(s.where || '下载/GGIF录屏')}，点「打开文件夹」到这次的</span>`;
  }
}

// 小条的内容高度（不能用页面的 scrollHeight：它最小也等于窗口高度，窗口就缩不回来）
const contentHeight = () => Math.ceil(document.body.getBoundingClientRect().height);

// 重画会把每一行换成新的元素：鼠标按着、或刚点过一下（双击的第二下还没来）时重画，这次单击预览 / 双击编辑就丢了
// （10-19 晚测试桩实测：压缩中列表频繁刷新时双击 8/20、单击 6/20 生效）。这时先记下要重画，松手过一会儿再画。
const HOLD_MS = 600; // 比系统默认的双击间隔长一点
let holdUntil = 0;
let renderWanted = false;
let flushTimer = null;
function hold(ms) {
  holdUntil = Math.max(holdUntil, Date.now() + ms);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushRender, holdUntil - Date.now() + 10);
}
function flushRender() {
  if (!renderWanted) return;
  if (Date.now() < holdUntil) return hold(0);
  renderWanted = false;
  render();
}
/** 列表数据变了、或者正在压的要刷新用时：能画就画，正在点就等点完。 */
function requestRender() {
  if (Date.now() < holdUntil) {
    renderWanted = true;
    return;
  }
  render();
}
// 按着最多先不画 3 秒（拖到面板外面松手时收不到松开）
document.addEventListener('mousedown', () => hold(3000), true);
document.addEventListener('mouseup', () => { holdUntil = 0; hold(HOLD_MS); }, true);
document.addEventListener('dragstart', () => { holdUntil = 0; hold(HOLD_MS); }, true);

/** 主进程切换小条：ids 是要列的素材（新的在前），null 就回到完整列表。返回内容高度，主进程按它定窗口大小。 */
window.__compact = (ids, groups) => {
  if (groups) S.groups = groups;
  S.compact = ids && ids.length ? ids : null;
  document.documentElement.classList.toggle('compact', Boolean(S.compact));
  document.body.classList.toggle('compact', Boolean(S.compact));
  S.lastH = 0;
  render();
  return contentHeight();
};

const gidOf = (el) => Number(el.closest('.row')?.dataset.gid) || null;
const chipOf = (el) => el.closest('.chip');

/** 只改选中的样子，不整个重画（重画会丢掉正在点的那一下）。 */
function renderSel() {
  for (const row of $('list').querySelectorAll('.row')) row.classList.toggle('sel', S.sel.has(Number(row.dataset.gid)));
}
const visibleIds = () => [...$('list').querySelectorAll('.row')].map((r) => Number(r.dataset.gid));
let swallowClick = false; // 刚拉完框、刚拖过版本小块：松手那一下不算「点」（不然会被当成点空白处、把选中的清掉）

/**
 * 多选（作者要「鼠标划框多选批量移除」；01:34：「不要弹出额外的选项，可以用快捷键del/回格清空列表，或者右键才出来操作选项」）：
 * 点行的空白处选中，⌘ 点加选 / 取消，⇧ 点连选，⌘A 全选，Esc 取消；在空白处按住拖 = 拉框（版本小块上按住照旧是拖文件出去）。
 * ⌫ / Delete 从列表移除（文件不动，10 秒内能撤销），⌘⌫ 移到废纸篓（只删压缩结果），右键出批量菜单。
 */
function bindSelect() {
  const list = $('list');
  let mq = null; // 拉框：{ x0, y0（列表内容里的坐标）, base（按着 ⌘ / ⇧ 时原来选中的）, moved }
  const box = document.createElement('div');
  box.className = 'marquee';
  document.body.appendChild(box);
  const end = () => {
    if (mq?.moved) swallowClick = true;
    mq = null;
    box.style.display = 'none';
  };
  // 新按下一次鼠标就是新的一下点击：拖完版本小块留着的「吞掉下一下」作废（10-20 审查 D13：原来 1.5 秒内的第一下点击都被吞掉）
  document.addEventListener('mousedown', () => { swallowClick = false; }, true);
  list.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || S.compact || chipOf(e.target) || e.target.closest('.ract, .thumb')) return; // 按在缩略图上是要拖它（10-23），不拉框
    const r = list.getBoundingClientRect();
    if (e.clientX >= r.left + list.clientWidth) return; // 按在滚动条上：是在拖滚动条，不是拉框
    mq = { x0: e.clientX - r.left, y0: e.clientY - r.top + list.scrollTop, base: CMD(e) || e.shiftKey ? new Set(S.sel) : new Set(), moved: false };
  });
  document.addEventListener('mousemove', (e) => {
    if (!mq) return;
    if (!(e.buttons & 1)) return end();
    const r = list.getBoundingClientRect();
    if (e.clientY < r.top + 16) list.scrollTop -= 10; // 拉到边上自动滚
    else if (e.clientY > r.bottom - 16) list.scrollTop += 10;
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    const y = Math.max(0, Math.min(list.scrollHeight, e.clientY - r.top + list.scrollTop));
    if (!mq.moved && Math.hypot(x - mq.x0, y - mq.y0) < 5) return;
    mq.moved = true;
    const top = Math.min(mq.y0, y);
    const bottom = Math.max(mq.y0, y);
    Object.assign(box.style, {
      display: 'block', left: `${r.left + Math.min(mq.x0, x)}px`, width: `${Math.abs(x - mq.x0)}px`,
      top: `${Math.max(r.top, r.top + top - list.scrollTop)}px`, height: `${Math.max(0, Math.min(r.bottom, r.top + bottom - list.scrollTop) - Math.max(r.top, r.top + top - list.scrollTop))}px`,
    });
    const hits = new Set(mq.base);
    for (const row of list.querySelectorAll('.row')) if (row.offsetTop + row.offsetHeight > top && row.offsetTop < bottom) hits.add(Number(row.dataset.gid));
    S.sel = hits;
    renderSel();
  });
  document.addEventListener('mouseup', end);
  // 点：选中这一行（⌘ 加选 / 取消，⇧ 连选）；点列表空白处取消。点版本小块不管选中（照旧是预览）
  list.addEventListener('click', (e) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (chipOf(e.target) || S.compact || e.target.closest('.ract')) return;
    const gid = gidOf(e.target);
    if (!gid) {
      if (!CMD(e) && !e.shiftKey) { S.sel.clear(); renderSel(); }
      return;
    }
    if (CMD(e)) {
      if (S.sel.has(gid)) S.sel.delete(gid);
      else S.sel.add(gid);
      S.anchor = gid;
    } else if (e.shiftKey && S.anchor && visibleIds().includes(S.anchor)) {
      const ids = visibleIds();
      const [a, b] = [ids.indexOf(S.anchor), ids.indexOf(gid)].sort((x, y) => x - y);
      S.sel = new Set(ids.slice(a, b + 1));
    } else {
      // 普通点；⇧ 点时起点那行已经不在了（被移除、文件没了），就当普通点、从这一行重新起（10-20 审查 D12：原来点了没反应）
      S.sel = new Set([gid]);
      S.anchor = gid;
    }
    renderSel();
  });
  document.addEventListener('keydown', (e) => {
    if (S.compact) return;
    if (CMD(e) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      S.sel = new Set(visibleIds());
      renderSel();
    } else if (e.key === 'Escape' && S.sel.size) {
      S.sel.clear();
      renderSel();
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && S.sel.size) {
      e.preventDefault();
      const ids = [...S.sel];
      S.sel.clear();
      renderSel();
      if (CMD(e)) T.trash(ids); // ⌘⌫：和访达一样移到废纸篓（只删压缩结果）
      else T.remove(ids); // ⌫ / Delete：只从列表移除，文件不动
    }
  });
}

function bind() {
  bindSelect();
  const list = $('list');
  list.addEventListener('click', (e) => {
    const act = e.target.closest('.ract button');
    if (act) {
      const gid = gidOf(act);
      if (act.dataset.act === 'edit' && gid) T.edit(gid);
      else if (act.dataset.act === 'look' && act.dataset.file) T.preview(act.dataset.file);
      else if (act.dataset.act === 'reveal' && act.dataset.file) T.reveal(act.dataset.file);
      return;
    }
    const c = chipOf(e.target);
    if (c?.dataset.retry) { T.retry(Number(c.dataset.vid)); return; } // 没做成的红块：重试（10-22）
    if (c?.dataset.edit) { const gid = gidOf(c); if (gid) T.edit(gid); return; } // 「太长」：打开完整界面剪短
    if (c?.dataset.open) {
      const gid = gidOf(c);
      if (gid) T.edit(gid);
      return;
    }
    if (c?.dataset.file) T.preview(c.dataset.file);
  });
  list.addEventListener('dblclick', (e) => {
    if (chipOf(e.target) || e.target.closest('.ract')) return;
    const gid = gidOf(e.target);
    if (gid) T.edit(gid);
  });
  list.addEventListener('contextmenu', (e) => {
    const gid = gidOf(e.target);
    if (!gid) return;
    e.preventDefault();
    const c = chipOf(e.target);
    if (!S.sel.has(gid)) {
      S.sel = new Set([gid]);
      S.anchor = gid;
      renderSel();
    }
    T.menu(gid, c ? Number(c.dataset.vid) : undefined, [...S.sel]);
  });
  // 拖出：交给主进程发起真实文件拖拽（和从访达拖一样）
  list.addEventListener('dragstart', (e) => {
    const th = e.target.closest?.('.thumb');
    if (th) {
      e.preventDefault();
      dragThumb(gidOf(th));
      return;
    }
    const c = chipOf(e.target);
    e.preventDefault();
    if (!c?.dataset.file || c.dataset.nodrag) return;
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 1500);
    const gid = gidOf(c);
    if (S.sel.size > 1 && S.sel.has(gid)) {
      const dots = (c.dataset.dots || '').split(',').filter(Boolean);
      const files = [];
      for (const id of visibleIds().filter((x) => S.sel.has(x))) {
        if (id === gid) { files.push(c.dataset.file); continue; }
        const chips = S.groups.find((g) => g.id === id)?.chips.filter((k) => k.state === 'done' && k.file) || [];
        const k = chips.find((x) => x.dots.includes(dots[0])) || chips.find((x) => x.dots.some((d) => dots.includes(d)));
        if (k) files.push(k.file);
      }
      dragOut(files);
      // 拖完就取消选中（作者：「每次多选只负责一次批量操作」，免得之后单独拖其中一行又是整组）；系统不告诉拖到哪、有没有中途取消，所以一拖就清
      S.sel.clear();
      renderSel();
    } else dragOut([c.dataset.file]);
  });
  // 拖进来：拖拽过程中顶部的「嘴」张开成投放区，进到面板里高亮；松手才导入，取消就什么都不做
  let depth = 0;
  // 保险：鼠标在面板上正常移动（没按着键、没在拖）就把嘴合上，免得拖拽异常结束后一直张着
  document.addEventListener('mousemove', (e) => {
    if (e.buttons === 0) dragOutDone(); // 往外拖完了：鼠标回到面板、没按着键
    if (e.buttons === 0 && document.body.classList.contains('dragging')) {
      depth = 0;
      document.body.classList.remove('dragging', 'hot');
    }
  });
  document.addEventListener('visibilitychange', dragOutDone); // 面板收起、再打开：上一次往外拖肯定完了
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!isFiles(e) || draggingOut()) return; // 从列表往外拖的，不是拖进来（10-23）
    depth++;
    document.body.classList.add('dragging', 'hot');
  });
  document.addEventListener('dragover', (e) => {
    if (isFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = draggingOut() ? 'none' : 'copy'; }
  });
  document.addEventListener('dragleave', (e) => {
    if (!isFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('hot');
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging', 'hot');
    if (draggingOut()) { dragOutDone(); return; } // 拖出去又在面板里松手：不当新素材导进来（10-23）
    const paths = [...e.dataTransfer.files].map((f) => T.pathOf(f)).filter(Boolean);
    if (!paths.length) return;
    const r = await T.drop(paths);
    if (r.added) toast(`已加入 ${r.added} 个，开始压缩${r.rejected ? `；${r.rejected} 个超出处理范围没加` : ''}${r.added > 1 ? '，全部压完给汇总' : ''}`);
    else if (!r.rejected) toast(r.folders ? '文件夹里没找到 GIF 或视频（只看第一层）' : '没有可以压的 GIF 或视频', true);
  });
  // ⌘V：从剪贴板导入（访达复制的文件、飞书等复制的完整 GIF 数据）；读不到完整动图就明确提示
  document.addEventListener('keydown', async (e) => {
    if (!(CMD(e) && e.key.toLowerCase() === 'v')) return;
    e.preventDefault();
    toast('正在读剪贴板…');
    try {
      const r = await T.paste();
      toast(r.ok ? r.message : r.reason, !r.ok);
    } catch (err) {
      toast(`读剪贴板出错：${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, true);
    }
  });
  $('recMark').onchange = () => { S.recMark = $('recMark').checked; T.setRecMark(S.recMark); }; // 11.12 录屏打标
  $('panelPin').onchange = () => T.setPin($('panelPin').checked); // Windows版 W11a 固定面板（Mac 上藏着）
  $('openMain').onclick = () => T.openMain();
  $('clear').onclick = () => T.clear();
  $('quit').onclick = () => T.quit();
  $('cAll').onclick = () => T.showAll();
  $('recBtn').onclick = () => T.recToggle();
  $('recAll').onclick = async () => {
    const id = S.rec.session?.id;
    if (!id) return;
    const r = await T.recCompress(id);
    if (r?.added) toast(`已把这次录的 ${r.added} 段排进压缩队列${r.added > 1 ? '，全部压完给汇总' : ''}`);
  };
  $('recOpen').onclick = () => { if (S.rec.session?.dir) T.openFolder(S.rec.session.dir); };
  $('recClose').onclick = () => { S.recHidden = S.rec.session?.id || null; renderRec(); };
  $('cClose').onclick = () => T.closeBubble();
}

/**
 * 档位胶囊（11.12，作者选 A、档位做成「胶囊里的水」）：两个档各自点亮，亮着的都压；两个都亮 = 以前的「两种都要」
 * （9.9 的结果已经在 4.8MB 以内就不再重复压）。主进程那边还是存「主档 + 两种都要」：只亮一个 = 那一档；两个都亮 = 两种都要、主档 9.9
 * （拖缩略图拿主档那份，拖进公众号是上传、上限 10MB）。只剩一个亮时点它不灭，水晃一下。
 */
const litPresets = () => new Set(S.dual ? S.presets.map((p) => p.id) : [S.preset]);
function renderPresets(stir = false) {
  const box = $('presets');
  if (!box.querySelector('.liquid')) {
    box.innerHTML = '<div class="liquid"><div class="body"><i class="edge l"></i><i class="edge r"></i></div></div>';
    for (const p of S.presets) {
      const b = document.createElement('button');
      b.dataset.id = p.id;
      b.innerHTML = `<i class="dot ${p.id}"></i>${(p.limit / 1e6).toFixed(1)}MB`;
      b.onclick = () => clickPreset(p.id);
      box.appendChild(b);
    }
  }
  const on = litPresets();
  box.dataset.state = on.size > 1 ? 'both' : on.has(S.presets[0]?.id) ? 'left' : 'right';
  for (const b of box.querySelectorAll('button')) {
    const p = S.presets.find((x) => x.id === b.dataset.id);
    const lit = on.has(p.id);
    b.classList.toggle('on', lit);
    b.title = lit
      ? `${p.name}：亮着，拖进来的按这一档压${on.size > 1 ? '；再点一下关掉，只留另一档' : ''}`
      : `${p.name}：点一下也压这一档（两个都亮 = 两种都要；9.9 的结果已经在 4.8MB 以内就不再重复压）`;
  }
  if (stir) {
    box.classList.remove('stir');
    void box.offsetWidth;
    box.classList.add('stir');
  }
}
async function clickPreset(id) {
  const on = litPresets();
  if (on.has(id) && on.size === 1) return renderPresets(true); // 只剩这一个亮：不灭，水晃一下
  if (on.has(id)) {
    S.dual = false;
    S.preset = S.presets.find((p) => p.id !== id).id;
  } else {
    S.dual = true;
    S.preset = S.presets[0].id;
  }
  renderPresets(true);
  await T.setPreset(S.preset);
  await T.setDual(S.dual);
}

let toastTimer = null;
function toast(text, isErr = false, long = false, undo = false, ms = 0) {
  const el = $('toast');
  el.textContent = text;
  if (undo) {
    const b = document.createElement('button');
    b.textContent = '撤销';
    b.onclick = () => { el.className = 'toast'; T.undo(); };
    el.appendChild(b);
  }
  el.className = `toast show ${isErr ? 'err' : 'ok'}`;
  clearTimeout(toastTimer);
  // 一批的汇总、能撤销的多停一会；能撤销的按撤销还剩多久停（主进程给 ms，10-20 审查 A2：移到废纸篓时接着给前一次移除的「撤销」）
  toastTimer = setTimeout(() => { el.className = 'toast'; }, ms || (long || undo ? 10000 : isErr ? 6000 : 3000));
}

function flash(versionId) {
  const el = document.querySelector(`.chip[data-vid="${versionId}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

async function init() {
  const st = await T.state();
  S.presets = st.presets;
  S.preset = st.preset;
  S.dual = st.dual;
  S.recMark = Boolean(st.recMark);
  S.groups = st.groups;
  if (st.rec) S.rec = { ...S.rec, ...st.rec };
  $('recMark').checked = S.recMark;
  $('panelPin').checked = Boolean(st.pin);
  // 以前开着「两种都要」又选了 4.8 当主档的：两个都亮时主档定成 9.9（11.12 新规矩：拖缩略图拿 9.9 那份）
  if (S.dual && S.presets[0] && S.preset !== S.presets[0].id) {
    S.preset = S.presets[0].id;
    T.setPreset(S.preset);
  }
  renderPresets();
  bind();
  render();
  T.onGroups((groups) => { S.groups = groups; requestRender(); });
  T.onHighlight((vid) => setTimeout(() => flash(vid), 50));
  T.onToast((t) => toast(t.text, t.err, t.long, t.undo, t.ms));
  T.onClearSel(() => { S.sel.clear(); renderSel(); }); // 右键菜单对选中的几行做完（10-22）
  // 拖着文件经过菜单栏图标、面板被展开时：先把投放区亮出来，告诉用户往这里拖
  T.onDragHover((on) => { if (!(on && draggingOut())) document.body.classList.toggle('dragging', on); }); // 往外拖经过菜单栏图标：不张嘴
  T.onRecState((v) => { S.rec.state = v.state; renderRec(); });
  // 设置里换了快捷键（10-22 设置卷）：录屏按钮的提示跟着变
  T.onSettingsChanged?.((p) => {
    if (p?.hotkeyText) { S.rec.hotkey = p.hotkeyText.rec; S.rec.markKey = p.hotkeyText.mark; renderRec(); }
    if (p && 'recMark' in p) $('recMark').checked = S.recMark = Boolean(p.recMark); // 录屏小胶囊、设置里改了打标，顶上跟着变
  });
  T.onRecSession((s) => { S.rec.session = s; S.recHidden = null; renderRec(); });
  // 正在压的每秒刷新一下用时
  setInterval(() => { if (S.groups.some((g) => g.chips.some((c) => c.state === 'running'))) requestRender(); }, 1000);
}

init();
