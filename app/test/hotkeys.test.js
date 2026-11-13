// 设置卷（10-22，作者批准第一批）：renderer/hotkeys.cjs 的互转、按键转组合、校验、匹配；prefs.js 读设置时的整理。
// 设置那层的界面（点键帽、按组合、红字、切页、帮助折叠）在测试桩 脚本/测试桩-设置.mjs 里测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { normalizePrefs, PREF_DEFAULTS } from '../prefs.js';

const require = createRequire(import.meta.url);
const HK = require('../renderer/hotkeys.cjs');
const H = HK.make(false); // 下面这些测的是 Mac 的规矩：在哪台机器上跑都按 Mac 测（Windows 的在最后几条，Windows版 11-08）
const W = HK.make(true);
const ev = (code, m = {}) => ({ code, ctrlKey: Boolean(m.ctrl), altKey: Boolean(m.alt), shiftKey: Boolean(m.shift), metaKey: Boolean(m.cmd) });

test('显示的样子：默认两个；修饰键按 ⌃⌥⇧⌘ 排；写法统一', () => {
  assert.equal(H.toText('Control+Alt+R'), '⌃⌥R');
  assert.equal(H.toText('Alt+Space'), '⌥空格');
  assert.equal(H.toText('Command+Shift+Alt+Control+K'), '⌃⌥⇧⌘K');
  assert.equal(H.normalize('alt+space'), 'Alt+Space');
  assert.equal(H.normalize('Option+Ctrl+r'), 'Control+Alt+R');
  assert.equal(H.normalize('Alt'), ''); // 只有修饰键
});

test('按键转组合：按物理键认（按着 ⌥ 时 e.key 是 å 这类）；只按着修饰键不算；认不出的键说原因', () => {
  assert.deepEqual(H.fromEvent(ev('KeyR', { ctrl: true, alt: true })), { accel: 'Control+Alt+R', text: '⌃⌥R' });
  assert.deepEqual(H.fromEvent(ev('Space', { alt: true })), { accel: 'Alt+Space', text: '⌥空格' });
  assert.equal(H.fromEvent(ev('AltLeft', { alt: true })), null);
  assert.equal(H.fromEvent(ev('MetaRight', { cmd: true })), null);
  assert.ok(H.fromEvent(ev('IntlYen', { alt: true })).error);
  assert.equal(H.fromEvent(ev('Digit5', { ctrl: true, alt: true })).accel, 'Control+Alt+5');
  assert.equal(H.fromEvent(ev('ArrowUp', { ctrl: true, alt: true })).text, '⌃⌥↑');
});

test('校验：要带 ⌃⌥⌘ 中的一个；⌘ 加一个键（⌘C 这类）不行；两个不能一样；默认两个都过', () => {
  assert.equal(H.check('Control+Alt+R'), '');
  assert.equal(H.check('Alt+Space', 'Control+Alt+R'), '');
  assert.equal(H.check('Control+Alt+K', 'Control+Alt+R'), '');
  assert.equal(H.check('Command+Alt+K'), '');
  assert.match(H.check('Command+C'), /^⌘C 不行/);
  assert.match(H.check('Command+Shift+S'), /不行/);
  assert.match(H.check('Shift+A'), /要带/);
  assert.match(H.check('Space'), /要带/);
  assert.match(H.check('F5'), /要带/); // 单按 F 键也会抢走别的程序的 F 键
  assert.match(H.check('Control+Alt+R', 'control+alt+r'), /两个不能一样/);
  assert.equal(H.check(''), '认不出这个组合');
});

test('匹配：主界面打标按设置的「切一刀」，多按一个修饰键不算', () => {
  assert.ok(H.match(ev('Space', { alt: true }), 'Alt+Space'));
  assert.ok(!H.match(ev('Space', { alt: true, shift: true }), 'Alt+Space'));
  assert.ok(!H.match(ev('Space'), 'Alt+Space'));
  assert.ok(H.match(ev('KeyK', { ctrl: true, alt: true }), 'Control+Alt+K'));
  assert.ok(!H.match(ev('Space', { alt: true }), 'Control+Alt+K'));
});

test('读设置：缺字段用默认；旧版文件（只有档位、两种都要这几项）照读；认不出的值换回默认', () => {
  const ids = { presetIds: ['upload', 'paste'] };
  assert.deepEqual(normalizePrefs({}, ids), { ...PREF_DEFAULTS, hotkeys: { ...PREF_DEFAULTS.hotkeys } });
  assert.equal(normalizePrefs(null, ids).fill, true);
  const old = normalizePrefs({ preset: 'paste', dual: true, recAuto: true, timelineOpen: true }, ids);
  assert.equal(old.openMainOnStart, false); // 作者选「默认关（更轻量）」
  assert.equal(old.fill, true);
  assert.equal(old.rememberTimeline, true);
  assert.deepEqual(old.hotkeys, { ...PREF_DEFAULTS.hotkeys }); // 默认键跟着系统走（Mac ⌃⌥R / ⌥空格，Windows Ctrl+Alt+R / Ctrl+B）
  const mine = normalizePrefs({ hotkeys: { rec: 'control+alt+t', mark: 'Control+Alt+K' }, notifyDone: false, mainPreset: 'paste', mainSpeed: 'best', settingsTab: 'help' }, ids);
  assert.deepEqual(mine.hotkeys, { rec: 'Control+Alt+T', mark: 'Control+Alt+K' });
  assert.equal(mine.notifyDone, false);
  assert.equal(mine.mainPreset, 'paste');
  assert.equal(mine.mainSpeed, 'best');
  assert.equal(mine.settingsTab, 'help');
  const bad = normalizePrefs({ hotkeys: { rec: 'Command+C', mark: 'Control+Alt+R' }, fill: 'yes', mainPreset: 'xx', mainSpeed: 'warp', settingsTab: 'x' }, ids);
  assert.deepEqual(bad.hotkeys, { ...PREF_DEFAULTS.hotkeys }); // ⌘C 换回默认；切一刀和换回来的撞了，也换回默认
  assert.equal(bad.fill, true);
  assert.equal(bad.mainPreset, null);
  assert.equal(bad.mainSpeed, null);
  assert.equal(bad.settingsTab, 'set');
});

// ---------- Windows（Windows版 11-08；作者选打标默认 Ctrl+B） ----------
test('Windows：默认 Ctrl+Alt+R / Ctrl+B；显示成 Ctrl+Alt+R 这样（加号连、键名英文）；按键转组合也这样显示', () => {
  assert.deepEqual(W.DEFAULTS, { rec: 'Control+Alt+R', mark: 'Control+B' });
  assert.equal(W.toText('Control+Alt+R'), 'Ctrl+Alt+R');
  assert.equal(W.toText('Control+B'), 'Ctrl+B');
  assert.equal(W.toText('Alt+Space'), 'Alt+空格');
  assert.equal(W.toText('Command+Shift+Alt+Control+K'), 'Ctrl+Alt+Shift+Win+K');
  assert.equal(W.toText('Control+Return'), 'Ctrl+Enter');
  assert.deepEqual(W.fromEvent(ev('KeyB', { ctrl: true })), { accel: 'Control+B', text: 'Ctrl+B' });
  assert.ok(W.match(ev('KeyB', { ctrl: true }), 'Control+B'));
  assert.ok(!W.match(ev('KeyB', { ctrl: true, shift: true }), 'Control+B'));
});

test('Windows 校验：要带 Ctrl 或 Alt；Win 键组合、复制粘贴撤销这类、Alt+空格（窗口菜单）不行；默认两个都过', () => {
  assert.equal(W.check('Control+B', 'Control+Alt+R'), '');
  assert.equal(W.check('Control+Alt+R', 'Control+B'), '');
  assert.equal(W.check('Alt+X'), '');
  for (const bad of ['Control+C', 'Control+V', 'Control+Z', 'Control+A', 'Alt+Space', 'Alt+F4', 'Alt+Tab']) assert.match(W.check(bad), /最常用/, bad);
  assert.match(W.check('B'), /要带 Ctrl 或 Alt/);
  assert.match(W.check('Shift+B'), /要带 Ctrl 或 Alt/);
  assert.match(W.check('Command+B'), /Win 键/);
  assert.match(W.check('Control+B', 'control+b'), /两个不能一样/);
  assert.ok(!/[⌃⌥⇧⌘]/.test(W.check('Command+B') + W.check('B') + W.check('Control+C')), 'Windows 的提示里不该有 Mac 的符号');
});

test('读设置（Windows版 11-08）：结果放哪、录像放在认绝对路径（Windows 的 C:\\ 也认）；投放块默认关、位置只认 0–1', () => {
  const abs = path.resolve(os.tmpdir(), '公众号素材');
  assert.equal(normalizePrefs({ outDir: abs }).outDir, abs);
  assert.equal(normalizePrefs({ recDir: abs }).recDir, abs);
  assert.equal(normalizePrefs({ outDir: '公众号素材' }).outDir, null);
  assert.equal(normalizePrefs({}).dropBlockOn, false); // 11-08 改成拖到托盘弹面板后，投放块默认关
  assert.equal(normalizePrefs({ dropBlockOn: true }).dropBlockOn, true);
  assert.equal(normalizePrefs({ dropBlock: true }).dropBlockOn, false, '老名字存的 true 不再算');
  assert.equal(normalizePrefs({ dropBlockY: 0.3 }).dropBlockY, 0.3);
  assert.equal(normalizePrefs({ dropBlockY: 1.5 }).dropBlockY, null);
  assert.equal(normalizePrefs({ dropBlockY: 'x' }).dropBlockY, null);
});
