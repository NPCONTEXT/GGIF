// 拖出要录的一块：窗口正好盖住选中的那块屏幕，所以这里的坐标（点）就是相对这块屏幕的坐标。
// 框外拖是重画；框里拖是挪位置；拖四边、四角改大小；回车或「确定」交给主进程；不拖直接回车 = 整个屏幕；Esc 取消。
const $ = (id) => document.getElementById(id);
const R = window.rec;
const MIN = 64;
let view = null;
let sel = null; // { x, y, w, h }（点）
let drag = null;

function pixels(r) {
  const scale = view?.display?.scale || 2;
  let w = r.w * scale;
  let h = r.h * scale;
  const max = view?.maxWidth || 1920;
  const capped = w > max;
  if (capped) {
    h = (h * max) / w;
    w = max;
  }
  return `${Math.floor(w / 2) * 2}×${Math.floor(h / 2) * 2}${capped ? `（按 ${max} 宽缩小）` : ''}`;
}

function render() {
  const has = Boolean(sel && sel.w >= 2 && sel.h >= 2);
  $('sel').classList.toggle('hidden', !has);
  $('shade').classList.toggle('hidden', has);
  $('hint').classList.toggle('hidden', has || Boolean(drag));
  $('tools').classList.toggle('hidden', !has || Boolean(drag));
  if (!has) return;
  Object.assign($('sel').style, { left: `${sel.x}px`, top: `${sel.y}px`, width: `${sel.w}px`, height: `${sel.h}px` });
  const small = sel.w < MIN || sel.h < MIN;
  $('size').textContent = small ? `太小了（至少 ${MIN}×${MIN} 点）` : `录出来 ${pixels(sel)}`;
  $('ok').disabled = small;
  // 工具条放在框下面，放不下就放上面，再不行放框里面
  const tb = $('tools').getBoundingClientRect();
  let x = Math.min(Math.max(8, sel.x + sel.w - tb.width), innerWidth - tb.width - 8);
  let y = sel.y + sel.h + 8;
  if (y + tb.height > innerHeight - 8) y = sel.y - tb.height - 34;
  if (y < 8) y = sel.y + sel.h - tb.height - 8;
  Object.assign($('tools').style, { left: `${x}px`, top: `${y}px` });
}

function confirm() {
  if (sel && (sel.w < MIN || sel.h < MIN)) return;
  R.act({ act: 'region', rect: sel ? { ...sel } : null });
}

/** 鼠标在哪：框的哪条边 / 哪个角（离框线 8 像素以内）、框里（挪）、框外（重画）。 */
const GRAB = 8;
function hitTest(x, y) {
  if (!sel || sel.w < 2 || sel.h < 2) return 'new';
  const near = (a, b) => Math.abs(a - b) <= GRAB;
  const inX = x >= sel.x - GRAB && x <= sel.x + sel.w + GRAB;
  const inY = y >= sel.y - GRAB && y <= sel.y + sel.h + GRAB;
  let edge = '';
  if (inX && near(y, sel.y)) edge += 'n';
  else if (inX && near(y, sel.y + sel.h)) edge += 's';
  if (inY && near(x, sel.x)) edge += 'w';
  else if (inY && near(x, sel.x + sel.w)) edge += 'e';
  if (edge) return edge;
  if (x > sel.x && x < sel.x + sel.w && y > sel.y && y < sel.y + sel.h) return 'move';
  return 'new';
}
const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', move: 'move', new: 'crosshair' };

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('#tools')) return;
  const mode = hitTest(e.clientX, e.clientY);
  drag = { mode, x0: e.clientX, y0: e.clientY, s0: sel ? { ...sel } : null };
  if (mode === 'new') sel = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
  render();
});
document.addEventListener('mousemove', (e) => {
  if (!drag) {
    document.body.style.cursor = CURSOR[hitTest(e.clientX, e.clientY)];
    return;
  }
  const x = Math.min(Math.max(0, e.clientX), innerWidth);
  const y = Math.min(Math.max(0, e.clientY), innerHeight);
  if (drag.mode === 'move') {
    const s0 = drag.s0;
    sel = { ...s0, x: Math.min(Math.max(0, s0.x + x - drag.x0), innerWidth - s0.w), y: Math.min(Math.max(0, s0.y + y - drag.y0), innerHeight - s0.h) };
  } else if (drag.mode === 'new') {
    sel = { x: Math.min(x, drag.x0), y: Math.min(y, drag.y0), w: Math.abs(x - drag.x0), h: Math.abs(y - drag.y0) };
  } else {
    // 拖边、拖角：只动被拖的那几条边，不小于 MIN、不出屏幕
    const s0 = drag.s0;
    let x1 = s0.x, y1 = s0.y, x2 = s0.x + s0.w, y2 = s0.y + s0.h;
    if (drag.mode.includes('w')) x1 = Math.min(x2 - MIN, x);
    if (drag.mode.includes('e')) x2 = Math.max(x1 + MIN, x);
    if (drag.mode.includes('n')) y1 = Math.min(y2 - MIN, y);
    if (drag.mode.includes('s')) y2 = Math.max(y1 + MIN, y);
    sel = { x: Math.max(0, x1), y: Math.max(0, y1), w: Math.min(innerWidth, x2) - Math.max(0, x1), h: Math.min(innerHeight, y2) - Math.max(0, y1) };
  }
  render();
});
document.addEventListener('mouseup', () => {
  if (!drag) return;
  drag = null;
  if (sel && (sel.w < 2 || sel.h < 2)) sel = null; // 只是点了一下
  render();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    confirm();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    R.act({ act: 'cancel' });
  }
});
$('ok').onclick = confirm;
$('full').onclick = () => R.act({ act: 'region', rect: null });
$('repick').onclick = () => R.act({ act: 'repick' });
$('cancel').onclick = () => R.act({ act: 'cancel' });

R.onState((v) => {
  const first = !view;
  view = v;
  if (first && v.region) sel = { ...v.region }; // 上次的区域先摆上，直接回车就是它
  render();
});
window.__confirm = confirm; // 主进程：拖区域时按 ⌃⌥R 等于回车
window.__debugSelect = (r) => { sel = r; render(); return $('size').textContent; }; // 调试：自动测试时摆一个框
