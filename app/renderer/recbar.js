// 录制框右上角外面的小胶囊：开录前是提示和按钮；录的时候是时间、第几段、怎么切、停止（进度在录制框底边上，见 recframe.js）。
const $ = (id) => document.getElementById(id);
const R = window.rec;
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render(v) {
  const k = v.hotkeys || {};
  // 键按设置走（10-22 设置卷）；注册不上极少见（macOS 上别的程序占了照样注册得上，见开发说明 §五）
  const kRec = `<kbd>${k.rec}</kbd>${k.recOk === false ? '（注册不上：用按钮，或去设置换个键）' : ''}`;
  const kMark = `<kbd>${k.mark}</kbd>${k.markOk === false ? '（注册不上，去设置换个键）' : ''}`;
  $('bStop').title = `停止（${k.rec}）`;
  const max = v.maxSec || 90;
  const rec = v.state === 'recording';
  const near = rec && v.elapsed >= max - (v.nearEnd || 15);
  $('dot').className = `dot ${rec ? 'rec' : v.state === 'armed' ? 'armed' : ''}`;
  show('time', rec || v.state === 'stopping');
  $('time').textContent = `${clock(Math.min(v.elapsed || 0, max))} / ${clock(max)}`;
  $('time').classList.toggle('near', near);
  const movable = v.state === 'armed' && v.kind === 'display';
  show('grip', movable);
  document.querySelector('.capbox').classList.toggle('movable', movable);
  show('markBox', v.state === 'armed');
  $('mark').checked = Boolean(v.mark);
  show('autoBox', v.state === 'armed');
  show('fpsBox', v.state === 'armed'); // 11.13 录制帧率
  document.querySelectorAll('#fseg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.f) === (v.fps || 60)));
  $('auto').checked = Boolean(v.auto);
  show('bStart', v.state === 'armed');
  show('bRegion', v.state === 'armed' && v.kind === 'display');
  show('bCancel', v.state === 'armed');
  show('bStop', rec);
  let info = '';
  // 选的是屏幕：框直接出来（不用先拖一块），提示能拖边角、拖这条（10-22 试用反馈，照作者批的示意图）
  if (v.state === 'armed') info = v.kind === 'display' ? `<b class="ready">准备好了</b> · 拖边角改大小、拖这条挪 · 按 ${kRec} 开录${v.mark ? ` · ${kMark} 切一刀` : ''}` : `<b class="ready">准备好了</b>：录${esc(v.target)} · 先点播放，再按 ${kRec} 开录${v.mark ? ` · 录的时候 ${kMark} 切一刀` : ''} · 最长 ${clock(max)}`;
  else if (v.state === 'starting') info = '正在开始…';
  else if (rec) {
    const parts = [];
    if (near) parts.push(`<span class="warn">还剩 ${Math.max(0, Math.ceil(max - v.elapsed))} 秒</span>`);
    if (v.mark) {
      parts.push(v.segLen >= (v.longSeg || 30) ? `<span class="warn">第 ${v.segment} 段已 ${Math.floor(v.segLen)} 秒，超 300 帧了</span>` : `<b>第 ${v.segment} 段</b>`); // 段号浅青、粗一点（10-22 重做）
      parts.push(`<span class="dim">${kMark} 切 · ${kRec} 停</span>`);
    } else parts.push(`<span class="dim">${kRec} 停</span>`); // 11.12：打标关着整段一份，不显示第几段、怎么切
    info = parts.join(' ');
  } else if (v.state === 'stopping') info = '正在整理录像、分段…';
  if (v.message) info += ` <span class="warn">${esc(v.message)}</span>`;
  $('info').innerHTML = info;
  // 按内容要多宽告诉主进程（右边和录制框对齐，往左长）
  const box = document.querySelector('.capbox');
  const kids = [...box.children].filter((x) => !x.classList.contains('hidden'));
  const textW = (x) => {
    const r = document.createRange();
    r.selectNodeContents(x);
    return r.getBoundingClientRect().width;
  };
  const need = kids.reduce((a, x) => a + (x.id === 'info' ? textW(x) : x.offsetWidth), 0) + 8 * (kids.length - 1) + 16 + 8;
  R.act({ act: 'bar-size', w: need, state: v.state });
}

$('bStart').onclick = () => R.act({ act: 'start' });
$('bStop').onclick = () => R.act({ act: 'stop' });
$('bRegion').onclick = () => R.act({ act: 'reregion' });
$('bCancel').onclick = () => R.act({ act: 'cancel' });
$('auto').onchange = () => R.act({ act: 'auto', on: $('auto').checked });
$('mark').onchange = () => R.act({ act: 'mark-toggle', on: $('mark').checked }); // 11.12 打标开关（和菜单栏顶上、设置里是同一个）
document.querySelectorAll('#fseg button').forEach((b) => { b.onclick = () => R.act({ act: 'fps-set', fps: Number(b.dataset.f) }); }); // 11.13 录制帧率（和设置里是同一个）
let view = null;
R.onState((v) => { view = v; render(v); });

// 准备好时按住胶囊空白处拖：框跟着走（10-22 试用反馈，作者选「B 拖控制条带着框走」）；按钮、勾选框照旧是点。
// 胶囊跟着框挪，鼠标一直在胶囊上；捕获指针，鼠标快了出窗口也接着收
const capbox = document.querySelector('.capbox');
let barDrag = false;
capbox.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !view || view.state !== 'armed' || view.kind !== 'display' || e.target.closest('button, label, input')) return;
  e.preventDefault();
  capbox.setPointerCapture(e.pointerId);
  barDrag = true;
  R.act({ act: 'bar-drag-start', sx: e.screenX, sy: e.screenY });
});
capbox.addEventListener('pointermove', (e) => {
  if (barDrag) R.act({ act: 'bar-drag', sx: e.screenX, sy: e.screenY });
});
const endBarDrag = () => {
  if (!barDrag) return;
  barDrag = false;
  R.act({ act: 'bar-drag-end' });
};
capbox.addEventListener('pointerup', endBarDrag);
capbox.addEventListener('pointercancel', endBarDrag);
