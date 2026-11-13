// Windows 屏幕边的投放块（Windows版 11-08，作者选 B）：
// 文件拖过来 → 变大、亮起来（窗口大小由主进程改）；松手 → 把路径交给主进程，和拖到 Mac 菜单栏图标一样进列表压；
// 按住拖 → 贴着屏幕右边上下挪（主进程挪窗口、记位置）；没怎么动就松开 = 点了一下 → 开 / 关面板。
const B = window.dropBlock;
const blk = document.getElementById('blk');
let depth = 0;
const setHover = (on) => {
  blk.className = on ? 'hover' : 'idle';
  B.hover(on);
};
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (depth++ === 0) setHover(true);
});
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--depth <= 0) {
    depth = 0;
    setHover(false);
  }
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  depth = 0;
  const paths = [...(e.dataTransfer?.files || [])].map((f) => B.pathOf(f)).filter(Boolean);
  blk.className = 'idle';
  if (paths.length) B.drop(paths);
  else B.hover(false);
});

let down = null;
blk.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = { y: e.screenY, moved: false };
  blk.setPointerCapture(e.pointerId);
  B.move(e.screenY, 'start');
});
blk.addEventListener('pointermove', (e) => {
  if (!down) return;
  if (Math.abs(e.screenY - down.y) > 3) down.moved = true;
  if (down.moved) B.move(e.screenY, 'move');
});
blk.addEventListener('pointerup', (e) => {
  if (!down) return;
  const d = down;
  down = null;
  if (d.moved) B.move(e.screenY, 'end');
  else B.click();
});
B.onLabel((t) => {
  document.getElementById('label').textContent = t;
});
