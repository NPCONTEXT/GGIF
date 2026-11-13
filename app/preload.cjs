// 只把需要的几个功能交给界面，界面拿不到 Node。完整界面和菜单栏小面板共用这一份。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Windows版（11-08）：main.js 在 Windows 上加载页面时网址带 ?plat=win32；Mac 上没有这个参数，下面 Windows 那段一行都不跑。
const PLAT = /[?&]plat=win32(&|$)/.test(location.search) ? 'win32' : 'darwin';
if (PLAT === 'win32') {
  // 一期（压缩版）不做录屏：加 no-rec，CSS 藏掉录屏的按钮和开关；plat-win 给 Windows 的顶栏留出右上角三个键的位置
  // 界面上的 Mac 说法换成 Windows 的（长的先换；「⌥空格」是打标键，Windows 默认 Ctrl+B，作者定）
  const SWAP = [
    ['⌃、⌥、⌘ 中的一个', 'Ctrl 或 Alt'], ['⌘ / ⇧', 'Ctrl / Shift'], ['⌃⌥⇧⌘', 'Ctrl、Alt、Shift、Win'],
    ['⌥空格', 'Ctrl+B'], ['⌘⌫', 'Ctrl+Delete'],
    ['⌘ ', 'Ctrl '], ['⌃ ', 'Ctrl '], ['⌥ ', 'Alt '], ['⇧ ', 'Shift '], ['⌫ ', 'Delete '],
    ['⌘', 'Ctrl+'], ['⌃', 'Ctrl+'], ['⌥', 'Alt+'], ['⇧', 'Shift+'], ['⌫', 'Delete'], ['↩', 'Enter'],
    ['在访达中显示', '在资源管理器中显示'], ['访达', '资源管理器'], ['废纸篓', '回收站'],
    ['菜单栏图标', '托盘图标'], ['菜单栏面板', '托盘面板'], ['菜单栏', '托盘'], ['程序坞', '任务栏'], ['登录 Mac 后', '登录 Windows 后'],
  ];
  const swap = (t) => { let o = t; for (const [a, b] of SWAP) if (o.includes(a)) o = o.split(a).join(b); return o; };
  const ATTRS = ['title', 'data-tip', 'placeholder', 'aria-label'];
  const fixNode = (n) => {
    if (n.nodeType === 3) { const t = swap(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; return; }
    if (n.nodeType !== 1) return;
    for (const a of ATTRS) { const v = n.getAttribute(a); if (v) { const t = swap(v); if (t !== v) n.setAttribute(a, t); } }
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (w.nextNode()) { const c = w.currentNode; if (c !== n) fixNode1(c); }
  };
  const fixNode1 = (c) => {
    if (c.nodeType === 3) { const t = swap(c.nodeValue); if (t !== c.nodeValue) c.nodeValue = t; return; }
    for (const a of ATTRS) { const v = c.getAttribute(a); if (v) { const t = swap(v); if (t !== v) c.setAttribute(a, t); } }
  };
  const winOnce = () => {
    document.documentElement.classList.add('plat-win', 'no-rec');
    // 主界面空着时的「⌃⌥R 录屏」提示：一期没有录屏，连同后面的「录屏」二字藏掉
    const k = document.querySelector('.dropKeys [data-hk="rec"]');
    if (k) { k.style.display = 'none'; const nx = k.nextSibling; if (nx && nx.nodeType === 3) nx.nodeValue = nx.nodeValue.replace('录屏', ''); }
    // 设置页「录屏」卡：只留「切一刀」（主界面打标也用它），标题改成「快捷键」；其余几行 CSS 藏
    for (const h of document.querySelectorAll('#setBody h3')) if (h.textContent.trim() === '录屏') h.textContent = '快捷键';
    fixNode(document.documentElement);
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'characterData') fixNode1(m.target);
        else if (m.type === 'attributes') fixNode1(m.target);
        else for (const n of m.addedNodes) fixNode(n);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', winOnce, { once: true });
  else winOnce();
}

contextBridge.exposeInMainWorld('gifkit', {
  platform: PLAT, // 'win32' / 'darwin'（Windows版 11-08）
  info: () => ipcRenderer.invoke('info'),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  pathOf: (file) => webUtils.getPathForFile(file),
  probe: (file) => ipcRenderer.invoke('probe', file),
  estimate: (args) => ipcRenderer.invoke('estimate', args),
  checkGif: (args) => ipcRenderer.invoke('check-gif', args),
  gifPreview: (file) => ipcRenderer.invoke('gif-preview', file),
  thumbs: (args) => ipcRenderer.invoke('thumbs', args),
  convert: (args) => ipcRenderer.invoke('convert', args),
  liveEncode: (args) => ipcRenderer.invoke('live-encode', args),
  cancel: () => ipcRenderer.invoke('cancel'),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  handoffBatch: (args) => ipcRenderer.invoke('handoff-batch', args),
  recStart: () => ipcRenderer.invoke('rec-start'),
  marksSync: (a) => ipcRenderer.invoke('marks-sync', a), // 录屏的段在主界面改了：同步回菜单栏那几行
  setPref: (p) => ipcRenderer.invoke('set-pref', p), // 记住展开 / 收起时间轴、主界面上次的档位和速度
  // 设置那层（10-22 设置卷）：读、改（返回 { ok, error, prefs }）、别处改了时收到新的
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings-set', patch),
  onSettingsChanged: (fn) => ipcRenderer.on('settings-changed', (_e, p) => fn(p)),
  hotkeyCapture: (on) => ipcRenderer.invoke('hotkey-capture', on),
  pickOutDir: () => ipcRenderer.invoke('pick-out-dir'), // 结果放哪：选一个文件夹（第二批）
  pickRecDir: () => ipcRenderer.invoke('pick-rec-dir'), // 录像放在：换一个文件夹（10-22 试用反馈 9.6b）
  dragOut: (file, icon) => ipcRenderer.send('main-drag', { file, icon }), // 预览框拖走（9.6d）：拖出这个文件，icon 是跟着鼠标的小图（data:image/png，2 倍）
  onDragMissing: (fn) => ipcRenderer.on('main-drag-missing', () => fn()),
  dragDone: () => ipcRenderer.send('drag-out-done'), // 往外拖完了（10-23）
  openRecDir: () => ipcRenderer.invoke('open-rec-dir'), // 录像放在：在访达里打开
  openLogDir: () => ipcRenderer.invoke('open-log-dir'), // 在访达里打开操作日志的文件夹（第二批） // 正在录新快捷键：先放掉全局的「开始 / 停止」，录完再占回来
  debugSnap: (name) => ipcRenderer.invoke('debug-snap', name),
  onBatchDone: (fn) => ipcRenderer.on('batch-done', (_e, p) => fn(p)),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, p) => fn(p)),
  onLoadJob: (fn) => ipcRenderer.on('load-job', (_e, p) => fn(p)),
  debugShot: () => ipcRenderer.invoke('debug-shot'),
  debugLog: (m) => ipcRenderer.send('debug-log', m),
});

// 菜单栏小面板
contextBridge.exposeInMainWorld('tray', {
  platform: PLAT,
  state: () => ipcRenderer.invoke('tray-state'),
  onGroups: (fn) => ipcRenderer.on('tray-groups', (_e, groups) => fn(groups)),
  onHighlight: (fn) => ipcRenderer.on('tray-highlight', (_e, versionId) => fn(versionId)),
  setPreset: (id) => ipcRenderer.invoke('tray-set-preset', id),
  setDual: (on) => ipcRenderer.invoke('tray-set-dual', on),
  setRecMark: (on) => ipcRenderer.invoke('tray-set-rec-mark', on), // 11.12 录屏打标（和录屏小胶囊、设置里是同一个）
  setPin: (on) => ipcRenderer.invoke('tray-set-pin', on), // Windows版 W11a：固定面板，失去焦点不收
  drop: (paths) => ipcRenderer.invoke('tray-drop', paths),
  paste: () => ipcRenderer.invoke('tray-paste'),
  onDragHover: (fn) => ipcRenderer.on('tray-drag-hover', (_e, on) => fn(on)),
  onToast: (fn) => ipcRenderer.on('tray-toast', (_e, t) => fn(t)),
  onClearSel: (fn) => ipcRenderer.on('tray-clear-sel', () => fn()), // 右键菜单对选中的几行做完：取消选中（10-22 试用反馈 9.2）
  pathOf: (file) => webUtils.getPathForFile(file),
  drag: (files) => ipcRenderer.send('tray-drag', files),
  dragDone: () => ipcRenderer.send('drag-out-done'), // 往外拖完了（10-23）：菜单栏图标又可以接拖进来的了
  preview: (p) => ipcRenderer.invoke('tray-preview', p),
  reveal: (p) => ipcRenderer.invoke('reveal', p), // 在访达中显示（10-22 行上悬停的小按钮）
  edit: (groupId) => ipcRenderer.invoke('tray-edit', groupId),
  menu: (groupId, versionId, selected) => ipcRenderer.invoke('tray-menu', { groupId, versionId, selected }),
  retry: (versionId) => ipcRenderer.invoke('tray-retry', versionId), // 没做成的红块：重试（10-22 试用反馈）
  remove: (ids) => ipcRenderer.invoke('tray-remove', ids), // 从列表移除这几行（文件不动，10 秒内能撤销）
  trash: (ids) => ipcRenderer.invoke('tray-trash', ids), // 这几行的压缩结果移到废纸篓
  undo: () => ipcRenderer.invoke('tray-undo'),
  openMain: () => ipcRenderer.invoke('tray-open-main'),
  clear: () => ipcRenderer.invoke('tray-clear'),
  quit: () => ipcRenderer.invoke('tray-quit'),
  compactHeight: (h) => ipcRenderer.send('tray-compact-height', h),
  showAll: () => ipcRenderer.invoke('tray-show-all'),
  closeBubble: () => ipcRenderer.invoke('tray-bubble-close'),
  // 录屏（录屏卷 3.1）
  recToggle: () => ipcRenderer.invoke('tray-rec-toggle'),
  recCompress: (session) => ipcRenderer.invoke('tray-rec-compress', session),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  onRecState: (fn) => ipcRenderer.on('tray-rec-state', (_e, v) => fn(v)),
  onRecSession: (fn) => ipcRenderer.on('tray-rec-session', (_e, s) => fn(s)),
  onSettingsChanged: (fn) => ipcRenderer.on('settings-changed', (_e, p) => fn(p)), // 快捷键换了：录屏按钮的提示跟着变
});

// 录屏的区域层、控制条、区域框
contextBridge.exposeInMainWorld('rec', {
  onState: (fn) => ipcRenderer.on('rec-state', (_e, v) => fn(v)),
  act: (a) => ipcRenderer.send('rec-action', a),
});

// Windows 屏幕边的投放块（作者选 B）：拖进来、拖着换位置、点一下开面板
contextBridge.exposeInMainWorld('dropBlock', {
  pathOf: (file) => webUtils.getPathForFile(file),
  hover: (on) => ipcRenderer.send('drop-block', { act: 'hover', on: Boolean(on) }),
  drop: (paths) => ipcRenderer.send('drop-block', { act: 'drop', paths }),
  move: (screenY, phase) => ipcRenderer.send('drop-block', { act: 'move', screenY, phase }),
  click: () => ipcRenderer.send('drop-block', { act: 'click' }),
  onLabel: (fn) => ipcRenderer.on('drop-block-label', (_e, t) => fn(t)),
});
