// 菜单栏列表（library.js）的单元测试：不开界面、不压文件，runOne 用假的。在 app/ 里跑：node --test 'test/*.test.js'
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, volumeGone } from '../library.js';
import { existsSync as fileThere } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** 假的压缩：每个版本「压」200 毫秒，能被取消。 */
function makeLib() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-libtest-'));
  dirs.push(dir);
  return new Library({
    runOne: async (g, v, { signal }) => {
      for (let i = 0; i < 10 && !signal.aborted; i++) await sleep(20);
      if (signal.aborted) throw new Error('已取消');
      const file = path.join(dir, `${g.name}_${v.preset}_${v.id}.gif`); // 列表只显示文件还在的版本，所以真写一个
      writeFileSync(file, 'GIF89a');
      Object.assign(v, { file, bytes: 6 });
    },
    satisfies: () => false,
    presetIds: ['upload', 'paste'],
    file: null,
  });
}
const names = (lib) => lib.list().map((g) => `${g.name}:${g.chips.length}`);

test('取消排队中的素材、移除正在压的素材：这一行都去掉，不留空行（10-19 晚查出）', async () => {
  const lib = makeLib();
  const a = lib.request('/tmp/A.gif', 'upload');
  const b = lib.request('/tmp/B.gif', 'upload');
  lib.cancel(b.version.id);
  assert.deepEqual(names(lib), ['A.gif:1'], '取消排队的 B 以后 B 那行应该马上没了');
  lib.removeGroup(a.group.id);
  await sleep(400);
  assert.deepEqual(names(lib), [], '移除正在压的 A，停下以后那行应该没了');
});

test('移除正在压、但已有别的版本的素材：停下以后整行去掉', async () => {
  const lib = makeLib();
  lib.request('/tmp/C.gif', 'upload');
  await sleep(400); // 第一档压完
  const c2 = lib.request('/tmp/C.gif', 'paste');
  assert.equal(c2.version.state, 'running');
  lib.removeGroup(c2.group.id);
  await sleep(400);
  assert.deepEqual(names(lib), []);
});

test('刚点了移除、还没停下时又拖进来：保留这一行，新的照常压完', async () => {
  const lib = makeLib();
  const d = lib.request('/tmp/D.gif', 'upload');
  lib.removeGroup(d.group.id);
  lib.request('/tmp/D.gif', 'paste');
  await sleep(700);
  assert.deepEqual(names(lib), ['D.gif:1']);
});

test('从列表移除最后一个版本：这一行去掉；还有别的版本就留着', async () => {
  const lib = makeLib();
  lib.request('/tmp/E.gif', 'upload');
  await sleep(300);
  lib.request('/tmp/E.gif', 'paste');
  await sleep(300);
  const g = lib.groups[0];
  const [v1, v2] = g.versions;
  lib.dropVersion(v1.id);
  assert.deepEqual(names(lib), ['E.gif:1']);
  lib.dropVersion(v2.id);
  assert.deepEqual(names(lib), []);
});

// ---------- 跟着文件走、撤销清空、存盘排队（作者：「本地文件移动/删除/改名等，图片列表怎么办」） ----------
import { renameSync, statSync, mkdirSync, existsSync } from 'node:fs';

/** 一个「做好了」的版本，带上设备号和编号（和 describe() 一样）。 */
function doneVersion(lib, src, file, preset = 'upload') {
  writeFileSync(file, 'GIF89a');
  const st = statSync(file);
  return lib.addDone(src, { preset, mode: 'fast', file, bytes: 6, width: 900, height: 500, frames: 61, durationSec: 6, dev: st.dev, ino: st.ino });
}
/** 假的「按编号找路径」：在给的这些文件夹里按编号找（真的用 Swift 小助手，这里只测列表的处理）。 */
const fakeLocate = (roots) => async (ids) => {
  const { readdirSync } = await import('node:fs');
  const found = new Map();
  for (const root of roots) {
    for (const n of readdirSync(root, { recursive: true })) {
      const p = path.join(root, n);
      const st = statSync(p);
      if (st.isFile() && ids.includes(`${st.dev}:${st.ino}`)) found.set(`${st.dev}:${st.ino}`, p);
    }
  }
  return found;
};

test('跟着文件走：结果改名、挪到别的文件夹 → 找回、路径改过来；删掉、挪进废纸篓、没记编号的 → 那个版本去掉，整行没结果了整行去掉', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-follow-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, '别处'));
  mkdirSync(path.join(dir, '废纸篓'));
  const lib = makeLib();
  const src = (n) => { const p = path.join(dir, n); writeFileSync(p, 'x'); return p; };
  doneVersion(lib, src('甲.mp4'), path.join(dir, '甲_压缩.gif'));
  doneVersion(lib, src('乙.mp4'), path.join(dir, '乙_压缩.gif'));
  doneVersion(lib, src('丙.mp4'), path.join(dir, '丙_压缩.gif'));
  doneVersion(lib, src('丁.mp4'), path.join(dir, '丁_压缩.gif'));
  const old = lib.addDone(src('戊.mp4'), { preset: 'upload', mode: 'fast', file: path.join(dir, '戊_压缩.gif'), bytes: 6 }); // 以前的记录：没有编号
  writeFileSync(path.join(dir, '戊_压缩.gif'), 'GIF89a');
  renameSync(path.join(dir, '甲_压缩.gif'), path.join(dir, '甲_给同事.gif'));
  renameSync(path.join(dir, '乙_压缩.gif'), path.join(dir, '别处', '乙_压缩.gif'));
  rmSync(path.join(dir, '丙_压缩.gif'));
  renameSync(path.join(dir, '丁_压缩.gif'), path.join(dir, '废纸篓', '丁_压缩.gif'));
  rmSync(path.join(dir, '戊_压缩.gif'));
  const isTrash = (p) => p.startsWith(path.join(dir, '废纸篓'));
  assert.equal(await lib.reconcile(fakeLocate([dir]), { isTrash }), true);
  const rows = Object.fromEntries(lib.list().map((g) => [g.name, g.chips.map((c) => path.relative(dir, c.file)).join('、')]));
  assert.deepEqual(rows, { '甲.mp4': '甲_给同事.gif', '乙.mp4': path.join('别处', '乙_压缩.gif') });
  assert.equal(lib.findGroup(old.group.id), undefined);
  assert.equal(await lib.reconcile(fakeLocate([dir]), { isTrash }), false); // 再查一遍没变化
});

test('跟着文件走：原素材挪走 → 找回；找不到不动（编辑时用结果）；录屏待压缩的段录像没了 → 整行去掉', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-follow-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, '别处'));
  const lib = makeLib();
  const s1 = path.join(dir, '原片.mp4');
  writeFileSync(s1, 'x');
  const { group } = doneVersion(lib, s1, path.join(dir, '原片_压缩.gif'));
  const st = statSync(s1);
  Object.assign(group, { sourceDev: st.dev, sourceIno: st.ino });
  renameSync(s1, path.join(dir, '别处', '原片改名.mp4'));
  const s2 = path.join(dir, '没编号的原片.mp4');
  writeFileSync(s2, 'x');
  const g2 = doneVersion(lib, s2, path.join(dir, '没编号的原片_压缩.gif')).group;
  rmSync(s2);
  const rec = path.join(dir, '录屏.mp4');
  writeFileSync(rec, 'x');
  const seg = lib.addRange(rec, { n: 1, start: 0, end: 5 }, { label: '录屏 01-00 · 第 1 段', session: 's1', rec: true });
  rmSync(rec);
  await lib.reconcile(fakeLocate([dir]));
  assert.equal(group.source, path.join(dir, '别处', '原片改名.mp4'));
  assert.ok(lib.findGroup(g2.id)); // 原素材找不到：行和结果都留着
  assert.equal(lib.findGroup(seg.id), undefined);
});

test('清空列表能撤销；一次移除好几行；存盘排队，连着存不会撞（10-20 实测撞过 rename ENOENT）', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-clear-'));
  dirs.push(dir);
  const lib = makeLib();
  lib.file = path.join(dir, 'history.json');
  for (const n of ['甲', '乙', '丙']) doneVersion(lib, path.join(dir, `${n}.mp4`), path.join(dir, `${n}_压缩.gif`));
  const gone = lib.clear();
  assert.equal(lib.list().length, 0);
  assert.equal(lib.restore(gone), 3);
  assert.deepEqual(lib.list().map((g) => g.name).sort(), ['乙.mp4', '丙.mp4', '甲.mp4'].sort());
  const ids = lib.groups.slice(0, 2).map((g) => g.id);
  assert.equal(lib.removeGroups(ids).length, 2);
  assert.equal(lib.list().length, 1);
  await Promise.all([lib.save(), lib.save(), lib.save(), lib.save()]);
  assert.ok(existsSync(lib.file));
  assert.ok(!existsSync(`${lib.file}.tmp`));
});

// ---------- 10-20 最后一轮审查修的（M2、B7、B4、M6、M3） ----------
import { readdirSync } from 'node:fs';

// Mac 专用：外接硬盘挂在 /Volumes 下。Windows 的盘符判断在 Windows版 W7 做，那时补 Windows 的这一条（11-07）
test('外接硬盘没接（/Volumes/某硬盘 整个不在）：重查不去掉、不去找；列表显示「硬盘没接」；存盘读盘后还在（10-20 审查 M2）', { skip: process.platform === 'win32' && 'Mac 专用（/Volumes）；Windows 的盘符判断在 W7 做' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-vol-'));
  dirs.push(dir);
  const lib = makeLib();
  lib.file = path.join(dir, 'history.json');
  const vol = `/Volumes/GIF工具测试-没接的硬盘-${process.pid}`;
  const a = lib.addDone(`${vol}/素材.mp4`, { preset: 'upload', mode: 'fast', file: `${vol}/素材_压缩.gif`, bytes: 9e6, width: 900, height: 500, frames: 61, durationSec: 6, dev: 1, ino: 2 });
  const b = lib.addDone(`${vol}/老记录.mp4`, { preset: 'paste', mode: 'fast', file: `${vol}/老记录_压缩_4.8M.gif`, bytes: 4e6 }); // 以前的记录：没有编号
  let asked = 0;
  assert.equal(await lib.reconcile(async () => { asked++; return new Map(); }), false);
  assert.equal(asked, 0);
  const rows = Object.fromEntries(lib.list().map((g) => [g.name, g.chips.map((c) => `${c.state}:${c.dots.join(',')}:${c.volume}`)]));
  assert.deepEqual(rows, { '素材.mp4': [`offline:upload:${path.basename(vol)}`], '老记录.mp4': [`offline:paste:${path.basename(vol)}`] });
  await lib.save();
  const lib2 = makeLib();
  lib2.file = lib.file;
  await lib2.load();
  assert.deepEqual(lib2.groups.map((g) => g.id).sort(), [a.group.id, b.group.id].sort());
  // 接着的硬盘上（或本机）文件没了：照常当删掉
  const here = readdirSync('/Volumes').map((n) => `/Volumes/${n}`)[0];
  if (here) {
    lib2.addDone(`${here}/不存在-${process.pid}.mp4`, { preset: 'upload', mode: 'fast', file: `${here}/不存在-${process.pid}_压缩.gif`, bytes: 6 });
    await lib2.reconcile(async () => new Map());
    assert.equal(lib2.groups.length, 2);
  }
});

test('录屏的段记了录像的编号：录像改名后按编号找回，「待压缩」的段不掉；关着时改名，读历史也先留着、重查后找回（10-20 审查 B7）', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-recino-'));
  dirs.push(dir);
  const lib = makeLib();
  lib.file = path.join(dir, 'history.json');
  const rec = path.join(dir, '录屏.mp4');
  writeFileSync(rec, 'x');
  const seg = lib.addRange(rec, { n: 1, start: 0, end: 5 }, { label: '录屏 01-00 · 第 1 段', session: 's1', rec: true });
  assert.ok(seg.sourceIno);
  renameSync(rec, path.join(dir, '改名.mp4'));
  await lib.reconcile(fakeLocate([dir]));
  assert.equal(lib.findGroup(seg.id)?.source, path.join(dir, '改名.mp4'));
  assert.ok(lib.findGroup(seg.id).pending);
  await lib.save();
  renameSync(path.join(dir, '改名.mp4'), path.join(dir, '又改名.mp4'));
  const lib2 = makeLib();
  lib2.file = lib.file;
  await lib2.load();
  assert.equal(lib2.groups.length, 1);
  await lib2.reconcile(fakeLocate([dir]));
  assert.equal(lib2.groups[0].source, path.join(dir, '又改名.mp4'));
  assert.ok(lib2.groups[0].pending);
});

test('找路径出错（超时、小助手崩了）：这次先都不动，不当删掉；下次能找了再改路径（10-20 审查 B4）', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-locerr-'));
  dirs.push(dir);
  const lib = makeLib();
  const s = path.join(dir, '甲.mp4');
  writeFileSync(s, 'x');
  const { group } = doneVersion(lib, s, path.join(dir, '甲_压缩.gif'));
  renameSync(path.join(dir, '甲_压缩.gif'), path.join(dir, '甲_给同事.gif'));
  assert.equal(await lib.reconcile(async () => { throw new Error('超过 5 秒'); }), false);
  assert.equal(group.versions.length, 1);
  assert.ok(lib.findGroup(group.id));
  assert.equal(await lib.reconcile(fakeLocate([dir])), true);
  assert.equal(group.versions[0].file, path.join(dir, '甲_给同事.gif'));
});

test('清空后又拖进同一个文件，再点撤销：不出两行，旧结果并进现在这一行（10-20 审查 M6）', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-undo2-'));
  dirs.push(dir);
  const lib = makeLib();
  const s = path.join(dir, '甲.mp4');
  writeFileSync(s, 'x');
  doneVersion(lib, s, path.join(dir, '甲_压缩.gif'));
  const gone = lib.clear();
  lib.request(s, 'paste'); // 又拖进来，开始压 4.8 档
  assert.equal(lib.restore(gone), 0);
  const rows = lib.groups.filter((g) => g.source === s);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].versions.some((v) => v.file === path.join(dir, '甲_压缩.gif')));
  await sleep(400);
  assert.equal(lib.list().length, 1);
});

test('退出时同步存盘：刚改的（0.5 秒内）不丢；之前没写完的异步存盘不会再盖掉它（10-20 审查 M3）', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-flush-'));
  dirs.push(dir);
  const lib = makeLib();
  lib.file = path.join(dir, 'history.json');
  doneVersion(lib, path.join(dir, '甲.mp4'), path.join(dir, '甲_压缩.gif'));
  lib.flushSync(); // 不等 0.5 秒
  const read = async () => { const x = makeLib(); x.file = lib.file; await x.load(); return x.groups.map((g) => g.name).sort(); };
  assert.deepEqual(await read(), ['甲.mp4']);
  doneVersion(lib, path.join(dir, '乙.mp4'), path.join(dir, '乙_压缩.gif'));
  const older = lib.saveNow(); // 这一次存盘已经取好了数据（有甲乙），还没写完
  doneVersion(lib, path.join(dir, '丙.mp4'), path.join(dir, '丙_压缩.gif'));
  lib.flushSync(); // 退出：同步存（有甲乙丙）
  await older;
  assert.deepEqual(await read(), ['丙.mp4', '乙.mp4', '甲.mp4'].sort());
});

// ---------- 没做成的标志（10-22 试用反馈 9.6a，作者选「A 只改版本块」） ----------
import { friendlyError } from '../library.js';

/** 9.9 档（upload）压的时候报程序内部的错（10-22 作者撞上的那个），4.8 档（paste）压得成；4.8 档的结果也满足 9.9 档 */
function makeFailLib({ file = null, failUpload = () => true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-libfail-'));
  dirs.push(dir);
  return new Library({
    runOne: async (g, v) => {
      await sleep(10);
      if (v.preset === 'upload' && failUpload()) throw new TypeError("Cannot read properties of null (reading 'durationSec')");
      const out = path.join(dir, `${g.name}_${v.preset}_${v.id}.gif`);
      writeFileSync(out, 'GIF89a');
      Object.assign(v, { file: out, bytes: 4.4e6 });
    },
    satisfies: () => true,
    presetIds: ['upload', 'paste'],
    file,
  });
}

test('没做成的那档：别的档的结果正好也满足它，也照样显示「没做成」，原因写人话；这一档自己有旧结果就显示旧的', async () => {
  const lib = makeFailLib();
  lib.request('/tmp/F.mp4', 'upload');
  lib.request('/tmp/F.mp4', 'paste');
  await sleep(150);
  const chips = lib.list()[0].chips.map((c) => ({ 状态: c.state, 圆点: c.dots.join('+'), 原因: c.error }));
  // 原来：只剩一块带两个圆点的 4.8 档结果，看不出 9.9 档失败
  assert.deepEqual(chips, [{ 状态: 'failed', 圆点: 'upload', 原因: '程序出错了，已记进日志' }, { 状态: 'done', 圆点: 'paste', 原因: '' }]);
  // 9.9 档自己先压成过、再压一次失败：显示原来那份（重试失败不把能用的盖掉）
  let fail = false;
  const lib2 = makeFailLib({ failUpload: () => fail });
  lib2.request('/tmp/G.mp4', 'upload');
  await sleep(100);
  fail = true;
  lib2.requestGroup(lib2.groups[0], 'upload', { reuse: false });
  await sleep(100);
  assert.deepEqual(lib2.list()[0].chips.map((c) => `${c.state}:${c.dots.join('+')}`), ['done:upload+paste']);
});

test('只有失败结果的行：存盘读回后还在、还是「没做成」；原素材没了就不留（10-22 前重启后整行没了）', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-libfail-'));
  dirs.push(dir);
  const file = path.join(dir, 'history.json');
  const src = path.join(dir, '录屏.mp4');
  writeFileSync(src, 'x');
  const lib = makeFailLib({ file });
  lib.request(src, 'upload');
  lib.request(path.join(dir, '不在了.mp4'), 'upload');
  await sleep(150);
  await lib.save();
  const back = makeFailLib({ file });
  await back.load();
  const rows = back.list().map((g) => ({ 名字: g.name, 块: g.chips.map((c) => `${c.state}:${c.error}`) }));
  assert.deepEqual(rows, [{ 名字: '录屏.mp4', 块: ['failed:程序出错了，已记进日志'] }]);
});

test('重试：先排新的、再去掉失败的那个，只有一个失败版本的行不会被整行去掉，压成了就显示结果', async () => {
  let fail = true;
  const lib = makeFailLib({ failUpload: () => fail });
  lib.request('/tmp/H.mp4', 'upload');
  await sleep(100);
  const g = lib.groups[0];
  const bad = g.versions[0];
  assert.equal(bad.state, 'failed');
  fail = false;
  lib.requestGroup(g, 'upload', { reuse: false }); // main.js retryVersion 的顺序
  lib.dropVersion(bad.id);
  assert.equal(lib.groups.length, 1);
  await sleep(100);
  assert.deepEqual(lib.list()[0].chips.map((c) => `${c.state}:${c.dots.join('+')}`), ['done:upload+paste']);
});

test('原因写人话：引擎的中文报错照用；磁盘满、没权限、文件没了翻成一句；别的英文当程序出错', () => {
  assert.equal(friendlyError('每一档都装不下'), '每一档都装不下');
  assert.equal(friendlyError('ENOSPC: no space left on device, write'), '磁盘满了');
  assert.equal(friendlyError("EACCES: permission denied, open '/x'"), '没有权限读写这个文件夹');
  assert.equal(friendlyError('ENOENT: no such file or directory'), '文件找不到了（可能被挪走或删了）');
  assert.equal(friendlyError("Cannot read properties of null (reading 'durationSec')"), '程序出错了，已记进日志');
});

// ---------- Windows（Windows版 11-08）：外接硬盘看盘符 ----------
test('外接硬盘没接（Windows：盘符整个不在）当「暂时不在」；网络路径（\\\\服务器\\…）不查；不是盘符开头的不算', () => {
  const free = [...'ZYXWVUTSRQPONMLKJIHG'].find((l) => !fileThere(`${l}:\\`));
  assert.ok(free, '找不到一个没用的盘符');
  assert.equal(volumeGone(`${free}:\\素材\\a.gif`, 'win32'), true);
  assert.equal(volumeGone(`${free}:/素材/a.gif`, 'win32'), true);
  assert.equal(volumeGone('\\\\服务器\\共享\\a.gif', 'win32'), false);
  assert.equal(volumeGone('/Volumes/某硬盘/a.gif', 'win32'), false);
  assert.equal(volumeGone('', 'win32'), false);
});

test('外接硬盘（Windows）：系统盘在，不算「不在」', { skip: process.platform !== 'win32' && '只在 Windows 上跑（要真的系统盘）' }, () => {
  assert.equal(volumeGone(`${process.env.SystemDrive || 'C:'}\\Users\\a.gif`, 'win32'), false);
});
