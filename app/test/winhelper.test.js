// Windows 小助手（native/win/ggif-helper.c，Windows版 11-08）：fullscreen-watch 一启动先报一次全屏状态（一行 JSON），父进程退了就跟着退。
// 小助手是 Windows 程序、在云端编（.github/workflows/windows.yml），只在 Windows 上跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(here, '..', 'native', 'bin', 'ggif-helper.exe');
const skip = process.platform !== 'win32' && '只在 Windows 上跑（小助手是 Windows 程序，在云端编）';

test('Windows 小助手：先报一次全屏状态；父进程退了它几秒内跟着退', { skip }, async () => {
  assert.ok(existsSync(HELPER), `没有 ${HELPER}（云端「编 Windows 小助手」那步没跑？）`);
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { windowsHide: true });
  const h = spawn(HELPER, ['fullscreen-watch', String(parent.pid)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  h.stdout.on('data', (b) => { out += b; });
  const exited = new Promise((r) => h.on('exit', (code) => r(code)));
  const t0 = Date.now();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('超时'), 8000))]);
  if (code === '超时') h.kill();
  assert.notEqual(code, '超时', `父进程退了，${Date.now() - t0} 毫秒后小助手还没退`);
  assert.equal(code, 0);
  const first = JSON.parse(out.split('\n')[0]);
  assert.equal(typeof first.fullscreen, 'boolean', out);
});

test('Windows 小助手：参数不对时说用法、返回 2', { skip }, async () => {
  const h = spawn(HELPER, ['nonsense'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const code = await new Promise((r) => h.on('exit', r));
  assert.equal(code, 2);
});

// W11e（作者：「改成拖到托盘弹面板」）：watch 模式盯「在图标外按下左键、拖进图标范围」。用 PowerShell 调 user32 模拟鼠标：
// 先在「图标」里按下松开（就是点它，不该报），再在外面按下 → 拖进 → 拖出 → 再拖进 → 松开，应报 enter、leave、enter、up。
test('Windows 小助手 watch：拖进托盘图标才报 enter / leave / up，点图标不报', { skip }, async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true });
  const h = spawn(HELPER, ['watch', String(parent.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  let buf = '';
  h.stdout.on('data', (b) => {
    buf += b;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
  });
  h.stdin.write('rect 200 200 40 40\n');
  await sleep(400);
  const ps = [
    `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);'`,
    '[W.U]::SetCursorPos(220, 220); Start-Sleep -Milliseconds 250; [W.U]::mouse_event(2, 0, 0, 0, 0); Start-Sleep -Milliseconds 250; [W.U]::mouse_event(4, 0, 0, 0, 0); Start-Sleep -Milliseconds 300',
    '[W.U]::SetCursorPos(600, 500); Start-Sleep -Milliseconds 250; [W.U]::mouse_event(2, 0, 0, 0, 0); Start-Sleep -Milliseconds 250',
    '[W.U]::SetCursorPos(220, 220); Start-Sleep -Milliseconds 300; [W.U]::SetCursorPos(600, 500); Start-Sleep -Milliseconds 300',
    '[W.U]::SetCursorPos(220, 220); Start-Sleep -Milliseconds 300; [W.U]::mouse_event(4, 0, 0, 0, 0); Start-Sleep -Milliseconds 300',
  ].join('\n');
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
  let perr = '';
  p.stderr.on('data', (b) => { perr += b; });
  const pcode = await new Promise((r) => p.on('exit', r));
  await sleep(400);
  h.kill();
  parent.kill();
  assert.equal(pcode, 0, `模拟鼠标的 PowerShell 出错：${perr}`);
  const tray = lines.filter(Boolean).map((l) => JSON.parse(l)).filter((j) => j.tray).map((j) => j.tray);
  assert.deepEqual(tray, ['enter', 'leave', 'enter', 'up'], `小助手的输出：${lines.join(' | ')}`);
});
