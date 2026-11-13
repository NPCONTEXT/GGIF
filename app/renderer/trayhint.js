// Windows 托盘提示小窗（W11e）：在它上面松手也能压（路径交给主进程，和拖到投放块、拖进面板一样进列表）。不报 hover：主进程那边 hover 是投放块的。
const B = window.dropBlock;
const hint = document.getElementById('hint');
let depth = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (depth++ === 0) hint.classList.add('hot');
});
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--depth <= 0) {
    depth = 0;
    hint.classList.remove('hot');
  }
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  depth = 0;
  hint.classList.remove('hot');
  const paths = [...(e.dataTransfer?.files || [])].map((f) => B.pathOf(f)).filter(Boolean);
  if (paths.length) B.drop(paths);
});
