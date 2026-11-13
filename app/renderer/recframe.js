// 录制框（作者定的样式）：底边是固定 90 秒的进度——2px 浅青色从左往右；切点、最前端是白竖线，往上伸进画面几像素
// （开了内容保护，不会被录进去）；切一刀时最前端往上弹一下（作者：「打标时这个线段会向上稍微弹一下，并留下固定的线段作为打标节点」）；
// 最后 15 秒最前端变红。页面的安全策略不许 HTML 里写 style="…"，位置一律用脚本设 el.style。
const $ = (id) => document.getElementById(id);
const R = window.rec;
let lastCuts = 0;

function render(v) {
  const max = v.maxSec || 90;
  const rec = v.state === 'recording' || v.state === 'stopping';
  const pct = (t) => `${Math.min(100, Math.max(0, (t / max) * 100))}%`;
  const now = Math.min(v.elapsed || 0, max);
  const cuts = rec ? v.cuts || [] : [];
  $('fill').style.width = rec ? pct(now) : '0%';
  const fresh = cuts.length > lastCuts;
  $('cuts').replaceChildren(...cuts.map((t, i) => {
    const e = document.createElement('i');
    e.className = `cut${fresh && i === cuts.length - 1 ? ' new' : ''}`;
    e.style.left = pct(t);
    return e;
  }));
  $('head').classList.toggle('hidden', !rec);
  $('head').style.left = pct(now);
  $('head').classList.toggle('near', rec && now >= max - (v.nearEnd || 15));
  if (rec && fresh) {
    $('head').classList.remove('pop');
    void $('head').offsetWidth;
    $('head').classList.add('pop');
  }
  lastCuts = cuts.length;
}


// ---------- 开录前拖框改大小（作者）：鼠标到框线附近，窗口临时接住鼠标，可以拖边、拖角；离开就恢复不挡鼠标（框中间照样能点播放）。开录后锁住 ----------
let view = null;
let hover = null; // 鼠标在哪条边 / 哪个角
let dragging = null;
const BAND = 8; // 框线往里多少像素算「在框线上」
const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
const canResize = () => view && view.state === 'armed' && view.kind === 'display';
function edgeAt(x, y) {
  // 窗口比录制区域左右上各大 3 像素、下面大 5 像素
  let e = '';
  if (y <= 3 + BAND) e += 'n';
  else if (y >= innerHeight - 5 - BAND) e += 's';
  if (x <= 3 + BAND) e += 'w';
  else if (x >= innerWidth - 3 - BAND) e += 'e';
  return e || null;
}
function setHover(h) {
  if (h === hover) return;
  hover = h;
  document.body.style.cursor = h ? CURSOR[h] : '';
  R.act({ act: 'frame-hover', on: Boolean(h) });
}
document.addEventListener('mousemove', (e) => {
  if (dragging) {
    R.act({ act: 'frame-drag', sx: e.screenX, sy: e.screenY });
    return;
  }
  setHover(canResize() ? edgeAt(e.clientX, e.clientY) : null);
});
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !hover || !canResize()) return;
  e.preventDefault();
  dragging = hover;
  R.act({ act: 'frame-drag-start', edge: hover, sx: e.screenX, sy: e.screenY });
});
document.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = null;
  R.act({ act: 'frame-drag-end' });
  setHover(canResize() ? edgeAt(e.clientX, e.clientY) : null);
});
document.addEventListener('mouseleave', () => {
  if (!dragging) setHover(null);
});

R.onState((v) => {
  view = v;
  document.body.classList.toggle('armed', canResize());
  if (!canResize() && !dragging) setHover(null);
  render(v);
});
window.__frameState = () => ({ hover, dragging }); // 调试
