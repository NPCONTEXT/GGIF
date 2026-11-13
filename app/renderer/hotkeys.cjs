// 快捷键（10-22 设置卷 8.3b；作者：「做可以换的快捷键很有必要」）：Electron 的写法（Control+Alt+R）和显示的样子（⌃⌥R）互转、
// 按键事件转成组合、校验、判断按的是不是这个组合。主进程、主界面和单元测试共用：浏览器里当普通脚本加载（挂在 window.Hotkeys），node 里 require。
(function (root) {
  // Windows版（11-08）：Windows 上默认键、显示的样子、能不能用的规矩不一样（作者选打标默认 Ctrl+B）。
  // 主进程看 process.platform；页面在沙盒里没有 process，看网址里的 ?plat=win32（main.js 在 Windows 上加载页面时带上）。
  // make(true / false) 给测试用：在哪台机器上都能测两边的规矩。
  function detectWin() {
    if (typeof process === 'object' && process && typeof process.platform === 'string') return process.platform === 'win32';
    try { return /[?&]plat=win32(&|$)/.test(String(root.location && root.location.search)); } catch (e) { return false; }
  }
  function make(WIN) {
  const DEFAULTS = WIN ? { rec: 'Control+Alt+R', mark: 'Control+B' } : { rec: 'Control+Alt+R', mark: 'Alt+Space' };
  const MODS = ['Control', 'Alt', 'Shift', 'Command']; // 显示顺序和 macOS 菜单一样：⌃⌥⇧⌘
  const MOD_TEXT = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
  const MOD_ALIAS = { control: 'Control', ctrl: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift', command: 'Command', cmd: 'Command', meta: 'Command', super: 'Command', commandorcontrol: 'Command', cmdorctrl: 'Command' };
  const KEY_TEXT = { Space: '空格', Up: '↑', Down: '↓', Left: '←', Right: '→', Return: '↩', Tab: '⇥', Backspace: '⌫', Delete: '⌦', Home: '↖', End: '↘', PageUp: '⇞', PageDown: '⇟' };
  // 按物理位置认键（e.code）：按着 ⌥ 时 e.key 会变成 å、∂ 这类字符，不能用
  const CODE_KEY = {
    Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  const MOD_CODES = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)/;

  function keyOfCode(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|20)$/.test(code)) return code;
    return CODE_KEY[code] || null;
  }

  /** 'Control+Alt+R' → { mods: ['Control', 'Alt'], key: 'R' }（修饰键按 ⌃⌥⇧⌘ 排好）；认不出返回 null */
  function parse(accel) {
    if (typeof accel !== 'string' || !accel.trim()) return null;
    const parts = accel.split('+').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    const mods = new Set();
    for (const p of parts.slice(0, -1)) {
      const m = MOD_ALIAS[p.toLowerCase()];
      if (!m) return null;
      mods.add(m);
    }
    let key = parts[parts.length - 1];
    if (MOD_ALIAS[key.toLowerCase()]) return null; // 只有修饰键
    if (/^[a-z]$/.test(key)) key = key.toUpperCase();
    if (key.toLowerCase() === 'space') key = 'Space';
    return { mods: MODS.filter((m) => mods.has(m)), key };
  }

  /** 统一写法（比较用）：'alt+space' → 'Alt+Space' */
  function normalize(accel) {
    const p = parse(accel);
    return p ? [...p.mods, p.key].join('+') : '';
  }

  // Windows 上显示成 Ctrl+Alt+R、Ctrl+B（用加号连，键名写英文）
  const MOD_TEXT_WIN = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Command: 'Win' };
  const KEY_TEXT_WIN = { Space: '空格', Up: '↑', Down: '↓', Left: '←', Right: '→', Return: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
  // Windows 上不让设的：系统和各程序最常用的（复制、粘贴、剪切、撤销、重做、全选、保存、切窗口、关窗口、窗口菜单）
  const RESERVED_WIN = new Set(['Control+C', 'Control+V', 'Control+X', 'Control+Z', 'Control+Y', 'Control+A', 'Control+S', 'Alt+Tab', 'Alt+F4', 'Alt+Space']);

  /** 显示的样子：'Control+Alt+R' → '⌃⌥R'，'Alt+Space' → '⌥空格'（Windows：'Ctrl+Alt+R'、'Ctrl+B'） */
  function toText(accel) {
    const p = parse(accel);
    if (!p) return String(accel || '');
    if (WIN) return [...p.mods.map((m) => MOD_TEXT_WIN[m]), KEY_TEXT_WIN[p.key] || p.key].join('+');
    return p.mods.map((m) => MOD_TEXT[m]).join('') + (KEY_TEXT[p.key] || p.key);
  }

  /** 键盘事件 → { accel, text }；只按着修饰键（还没按主键）返回 null；这个键认不出返回 { error } */
  function fromEvent(e) {
    if (!e || MOD_CODES.test(e.code || '')) return null;
    const key = keyOfCode(e.code || '');
    if (!key) return { error: '这个键不能当快捷键' };
    const mods = MODS.filter((m) => ({ Control: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Command: e.metaKey }[m]));
    const accel = [...mods, key].join('+');
    return { accel, text: toText(accel) };
  }

  /** 能不能用：能用返回 ''，不能用返回原因（给人看的一句话）。other 是另一个快捷键（两个不能一样） */
  function check(accel, other) {
    const p = parse(accel);
    if (!p) return '认不出这个组合';
    const t = toText(accel);
    const has = (m) => p.mods.includes(m);
    if (WIN) {
      if (has('Command')) return `${t} 不行：Win 键的组合大多是系统自己的，换一个带 Ctrl 或 Alt 的`;
      if (!has('Control') && !has('Alt')) return `${t} 不行：要带 Ctrl 或 Alt（只按一个键或只加 Shift，会抢走所有程序里的打字）`;
      if (RESERVED_WIN.has(normalize(accel))) return `${t} 不行：这是系统和各个程序最常用的快捷键（复制、粘贴、撤销这类），设成全局会把它抢走`;
      if (other && normalize(other) === normalize(accel)) return `${t} 已经是另一个快捷键了，两个不能一样`;
      return '';
    }
    if (!has('Control') && !has('Alt') && !has('Command')) return `${t} 不行：要带 ⌃、⌥、⌘ 中的一个（只按一个键或只加 ⇧，会抢走所有程序里的打字）`;
    if (has('Command') && !has('Control') && !has('Alt')) return `${t} 不行：⌘ 加一个键是各个程序自己的快捷键（比如 ⌘C 是复制），设成全局会把它抢走。换一个带 ⌃ 或 ⌥ 的`;
    if (other && normalize(other) === normalize(accel)) return `${t} 已经是另一个快捷键了，两个不能一样`;
    return '';
  }

  /** 这次按键是不是这个组合（主界面打标按设置的「切一刀」） */
  function match(e, accel) {
    const r = fromEvent(e);
    return Boolean(r && r.accel && r.accel === normalize(accel));
  }

  return { DEFAULTS, parse, normalize, toText, fromEvent, check, match, WIN: Boolean(WIN) };
  }

  const Hotkeys = make(detectWin());
  Hotkeys.make = make;
  if (typeof module === 'object' && module.exports) module.exports = Hotkeys;
  else root.Hotkeys = Hotkeys;
})(typeof window !== 'undefined' ? window : globalThis);
