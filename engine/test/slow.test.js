// 慢测试：真编码，几分钟。设 GIFKIT_SLOW=1 才跑：GIFKIT_SLOW=1 node --test test/slow.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm, copyFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/convert.js';
import { batch } from '../src/batch.js';
import { gifSummary } from '../src/gif.js';
import { PRESETS } from '../src/presets.js';
import { parseGif } from '../src/gif.js';
import { readLoopCount } from '../src/manual.js';
import { TOOLS, run } from '../src/tools.js';
import { SAMPLES, NO_PRIVATE } from './samples.js';

const skip = process.env.GIFKIT_SLOW !== '1';
const skipP = skip || NO_PRIVATE; // 要私人素材的：慢测试没开，或在云端（没有素材）都跳过
const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');

test('转换：bt709 视频 2 秒 → 合规、凑到 61 帧、不转色', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  try {
    const out = path.join(dir, 'n2.gif');
    const r = await convertFile(SAMPLES.n2, out, { start: 24.2, dur: 2 });
    assert.equal(r.ok, true, JSON.stringify(r.check?.problems || r.reason));
    assert.equal(r.color.convert, false);
    assert.equal(r.chosen.width, 900);
    assert.equal(r.chosen.fps, 10);
    assert.equal(r.chosen.frames, 20);
    assert.equal(r.fill.ok, true);
    const s = gifSummary(await readFile(r.output));
    assert.equal(s.frames, 61);
    assert.ok(s.bytes <= PRESETS.upload.limit);
    assert.ok(Math.abs(s.durationSec - 2) < 0.05);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('转换：Display P3 视频会转色；输出已存在时不覆盖', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  try {
    const out = path.join(dir, 'p3.gif');
    const r1 = await convertFile(SAMPLES.p3, out, { start: 4, dur: 2, width: 600, fps: 8 });
    assert.equal(r1.ok, true, JSON.stringify(r1.check?.problems || r1.reason));
    assert.equal(r1.color.convert, true);
    const first = await sha(out);
    const r2 = await convertFile(SAMPLES.p3, out, { start: 4, dur: 2, width: 600, fps: 8 });
    assert.equal(r2.output, path.join(dir, 'p3 (1).gif'));
    assert.equal(await sha(out), first, '已有的输出不能被覆盖');
    await assert.rejects(convertFile(SAMPLES.p3, SAMPLES.p3, {}), /不能覆盖输入/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('转换：粘贴档每档都不过线时，明显不行的档不编码直接跳过，并给剪短建议', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  try {
    const r = await convertFile(SAMPLES.ui13, path.join(dir, 'ui13.gif'), { preset: 'paste', start: 0.833, dur: 10.75, mode: 'best' });
    assert.equal(r.ok, false);
    assert.ok(r.tried.filter((t) => t.skipped).length >= 3, '至少跳过 3 档');
    assert.ok(r.trims.length >= 1);
    assert.equal(r.trims[0].width, 900);
    assert.ok(r.trims[0].dur < 10.75);
    assert.match(r.reason, /剪到约/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('批量：合规的不动（输出在原目录时直接用原文件）、帧数不够的凑帧、超标的压缩；原文件不变', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  try {
    const files = { ok: 'ok78.gif', few: 'few40.gif', big: 'big10mib.gif' };
    await copyFile(SAMPLES.t2_78f, path.join(dir, files.ok));
    await copyFile(SAMPLES.t1_40f, path.join(dir, files.few));
    await copyFile(SAMPLES.s10mib, path.join(dir, files.big));
    const before = {};
    for (const f of Object.values(files)) before[f] = await sha(path.join(dir, f));

    const r = await batch([dir], dir, { preset: 'upload' });
    const by = Object.fromEntries(r.items.map((it) => [path.basename(it.input), it]));
    assert.equal(r.items.length, 3);

    assert.equal(by[files.ok].action, '已合规');
    assert.equal(by[files.ok].output, path.join(dir, files.ok), '已合规的直接用原文件，不复制');
    assert.equal(by[files.few].action, '凑帧');
    assert.equal(gifSummary(await readFile(by[files.few].output)).frames, 61);
    assert.equal(by[files.big].action, '压缩');
    assert.equal(by[files.big].ok, true, by[files.big].detail);
    assert.ok(gifSummary(await readFile(by[files.big].output)).bytes <= PRESETS.upload.limit);

    for (const f of Object.values(files)) assert.equal(await sha(path.join(dir, f)), before[f], `原文件 ${f} 被改了`);
    for (const it of r.items) if (it.action !== '已合规') assert.match(path.basename(it.output), /_压缩/);
    assert.equal((await readdir(dir)).length, 5); // 3 个原文件 + 凑帧、压缩各 1 个；合规的不复制
    assert.match(r.summary, /共 3 个/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('极速：难 GIF 宽度优先、先解码；快路子画质没过线时换 lessgif，900 宽装进上限', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  try {
    const r = await convertFile(SAMPLES.hard13, path.join(dir, 'hard13.gif'), { preset: 'upload' });
    assert.ok(r.ok, JSON.stringify(r.tried));
    assert.equal(r.chosen.width, 900);
    assert.equal(r.chosen.encoder, 'lessgif');
    assert.ok(r.chosen.bytes <= 9.9e6);
    assert.ok(r.tried.some((t) => t.encoder === 'ffmpeg+gifsicle' && t.pass === false), '先试过快路子');
    assert.ok(!r.tried.some((t) => t.direct), '要缩宽的 GIF 不走 gifsicle 直接压');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('取消：导出到一半取消，几秒内停下、不留输出、临时目录清掉', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  const before = new Set((await readdir(os.tmpdir())).filter((x) => x.startsWith('gifkit-q-')));
  try {
    const out = path.join(dir, 'cancel.gif');
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 3000);
    await assert.rejects(convertFile(SAMPLES.hard13, out, { preset: 'upload', signal: ac.signal }), /已取消/);
    assert.ok(Date.now() - t0 < 6000, `取消后 ${Date.now() - t0} 毫秒才停`);
    assert.ok(!existsSync(out), '不该留输出');
    const left = (await readdir(os.tmpdir())).filter((x) => x.startsWith('gifkit-q-') && !before.has(x));
    assert.deepEqual(left, [], '临时目录没清掉');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- 手动参数（TODO 2.33） ----------

test('手动参数：全部「自动」时和不给 manual 的输出一字节不差', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  try {
    const a = await convertFile(SAMPLES.n2, path.join(dir, 'a.gif'), { start: 24.2, dur: 2 });
    const b = await convertFile(SAMPLES.n2, path.join(dir, 'b.gif'), { start: 24.2, dur: 2,
      manual: { encoder: 'auto', quality: 'auto', colors: null, dither: '', lossy: 0, speed: 1, loop: 0, saturation: 1 } });
    assert.equal(b.manual, undefined, '全自动不该走手动流程');
    assert.equal(await sha(a.output), await sha(b.output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('手动参数：lessgif 指定画质 / 颜色 / 抖动 / 宽 / 帧率 / 速度 / 循环 / 饱和度 / 额外有损，结果都对得上', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  try {
    const manual = { encoder: 'lessgif', quality: 70, colors: 64, dither: 0.3, width: 640, fps: 12, speed: 1.25, loop: 2, saturation: 1.2, lossy: 20 };
    const r = await convertFile(SAMPLES.n2, path.join(dir, 'm.gif'), { start: 24.2, dur: 2, manual });
    assert.equal(r.ok, true, JSON.stringify(r.check?.problems || r.reason));
    assert.equal(r.manual.path, 'encoder');
    assert.deepEqual(r.manual.applied, manual);
    assert.equal(r.chosen.encoder, 'lessgif');
    assert.equal(r.chosen.q, 70);
    assert.equal(r.chosen.width, 640);
    assert.equal(r.chosen.fps, 12);
    assert.equal(r.chosen.frames, 24);
    const buf = await readFile(r.output);
    const s = gifSummary(buf);
    assert.equal(s.width, 640);
    assert.equal(s.frames, 61, '24 帧凑到 61');
    assert.ok(Math.abs(s.durationSec - 2 / 1.25) <= 0.02, `时长 ${s.durationSec}，应约 1.6 秒`);
    assert.ok(parseGif(buf).frames.every((f) => f.delay >= 2));
    assert.equal(readLoopCount(buf), 2);
    assert.ok(s.bytes <= PRESETS.upload.limit);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('手动参数：ffmpeg+gifsicle 画质自动时在上限内找最高；gifski 画质固定装不下时不出文件、说明最小那档多大', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  try {
    const r = await convertFile(SAMPLES.hard13, path.join(dir, 'ff.gif'), { preset: 'paste', manual: { encoder: 'ffmpeg', width: 700, fps: 8, colors: 128 } });
    assert.equal(r.ok, true, JSON.stringify(r.reason || r.check?.problems));
    assert.equal(r.chosen.encoder, 'ffmpeg+gifsicle');
    assert.ok(r.chosen.lossy > 0, '原样装不下，要有损');
    assert.ok(r.chosen.bytes <= PRESETS.paste.limit && r.chosen.bytes >= PRESETS.paste.limit * 0.9, `体积 ${r.chosen.bytes} 没贴近上限`);
    const g = await convertFile(SAMPLES.hard13, path.join(dir, 'gs.gif'), { preset: 'paste', manual: { encoder: 'gifski', quality: 100, width: 900, fps: 10 } });
    assert.equal(g.ok, false);
    assert.equal(g.output, undefined);
    assert.match(g.reason, /画质固定为 100 时，最小的一档（900 宽、每秒 10 帧）也有 [\d.]+MB/);
    assert.ok(!existsSync(path.join(dir, 'gs.gif')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('手动参数：已合规的 GIF 只改速度和播放次数时不重新编码；批量里也按手动参数处理', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  try {
    const src = path.join(dir, 'ok78.gif');
    await copyFile(SAMPLES.t2_78f, src);
    const before = await sha(src);
    const r = await batch([src], dir, { preset: 'upload', manual: { speed: 2, loop: 1 } });
    const it = r.items[0];
    assert.equal(it.action, '压缩', '有手动参数时不按「已合规」原样用');
    assert.equal(it.ok, true, it.detail);
    assert.match(it.detail, /原 GIF（没重新编码）.*手动参数：2× 速度，只放一遍/);
    const buf = await readFile(it.output);
    const orig = await readFile(src);
    assert.equal(buf.length, orig.length - 19, '只去掉了循环扩展，画面数据一字节没动');
    const s = gifSummary(buf);
    assert.equal(s.frames, 78);
    assert.ok(Math.abs(s.durationSec - gifSummary(orig).durationSec / 2) <= 0.01);
    assert.equal(readLoopCount(buf), 1);
    assert.equal(await sha(src), before, '原文件不能被改');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('手动参数：饱和度真的加进了取帧（1.5 比 1.0 的平均饱和度高）', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  const satOf = async (f) => {
    const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-i', f, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.SATAVG', '-f', 'null', '-']);
    const v = [...r.stderr.matchAll(/SATAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    assert.ok(v.length, r.stderr.slice(-300));
    return v.reduce((a, b) => a + b, 0) / v.length;
  };
  try {
    const base = { start: 24.2, dur: 1, fill: false };
    const a = await convertFile(SAMPLES.n2, path.join(dir, 's10.gif'), { ...base, manual: { encoder: 'lessgif', quality: 90, width: 400 } });
    const b = await convertFile(SAMPLES.n2, path.join(dir, 's15.gif'), { ...base, manual: { encoder: 'lessgif', quality: 90, width: 400, saturation: 1.5 } });
    const sa = await satOf(a.output);
    const sb = await satOf(b.output);
    assert.ok(sb > sa * 1.2, `饱和度 1.0 → ${sa.toFixed(2)}，1.5 → ${sb.toFixed(2)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('作者的竖屏录屏第 3 段（20–30 秒）极速压 9.9 档：要的有损超过 20 才检查画质，不报错（fd0b0aa 起这里报「reading durationSec」）', { skip: skipP || (!existsSync(SAMPLES.rec1022) && '10-22 录屏样片不在') }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-slow-'));
  try {
    // 和菜单栏压录屏的段一样传参（main.js 压段那里）
    const r = await convertFile(SAMPLES.rec1022, path.join(dir, '第3段.gif'), { preset: 'upload', mode: 'fast', start: 20, dur: 10, overwrite: true, ignoreByteLimit: true, ignoreDurationLimit: true });
    assert.ok(r.ok, r.reason);
    assert.ok(r.tried.some((t) => typeof t.ssim === 'number'), `没走到检查画质：${JSON.stringify(r.tried)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 作者录的 一段游戏录像（原件在 下载/GGIF录屏，只读，复制了一份）：第 1 段 900×10 快路子画质不过、同一档换 lessgif
const REC1031 = path.join(path.dirname(SAMPLES.rec1022), '..', '负载测试', '录屏D-1031-2345-77秒-地府麻将.mp4');
test('难素材只解码一次（10-31 负载优化，作者选「先放内存」）：快路子直出基底时原始帧留在内存，换 lessgif 时从内存写盘、不再取帧', { skip: skip || (!existsSync(REC1031) && '10-31 录屏样片不在') }, async () => {
  const stages = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-hard-'));
  try {
    const r = await convertFile(REC1031, path.join(dir, 'out.gif'), { preset: 'upload', mode: 'fast', start: 0, dur: 10, ignoreByteLimit: true, ignoreDurationLimit: true, onProgress: (p) => stages.push(`${p.width}x${p.fps}:${p.stage}`) });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.chosen.encoder, 'lessgif', JSON.stringify(r.tried));
    const t = `${r.chosen.width}x${r.chosen.fps}`;
    const mine = stages.filter((x) => x.startsWith(`${t}:`));
    assert.ok(mine.includes(`${t}:编码`) && mine.includes(`${t}:难素材：高画质编码`), `这一档要先直出基底、再换 lessgif：${mine.join('、')}`);
    assert.ok(!mine.includes(`${t}:取帧`), `这一档不该再取一遍帧：${mine.join('、')}`);
  } finally {
    await rm(dir, { recursive: true, force: true }); // 断言没过也删（11-01 改坏一行检查时漏过一个）
  }
});

test('lessgif 推算不够底线就跳过时，不写这一档的原始帧（10-31 负载优化）：13 号 UI 粘贴档 900×10 快路子不过、lessgif 跳过，最后 800×8 用 lessgif', { skip: skipP }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-lgskip-'));
  const oldTmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = dir; // 引擎的工作目录建在这下面，keepWork 留着看写过什么
    const r = await convertFile(SAMPLES.ui13, path.join(dir, 'out.gif'), { preset: 'paste', mode: 'fast', keepWork: true });
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    const t900 = r.tried.filter((t) => t.width === 900 && t.fps === 10);
    assert.ok(t900.some((t) => t.encoder === 'ffmpeg+gifsicle' && t.pass === false) && t900.some((t) => t.skipped), `900×10 要快路子不过、lessgif 跳过：${JSON.stringify(r.tried)}`);
    const raws = (await readdir(dir, { recursive: true })).map(String).filter((f) => f.endsWith('.rgba'));
    assert.ok(!raws.some((f) => /_900x\d+_10\.rgba$/.test(f)), `900×10 不该写原始帧：${raws.join('、')}`);
  } finally {
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    await rm(dir, { recursive: true, force: true });
  }
});

test('留在内存的原始帧和取帧逐字节一样，从录像中段开始也一样（11-01 复测查出：游戏录像第 60 秒起，原来多补一帧、整体错开一格）', { skip: skip || (!existsSync(REC1031) && '10-31 录屏样片不在') }, async () => {
  const { probe, colorPlan } = await import('../src/probe.js');
  const { extractFrames, encodeFromSource, writeRawFrames } = await import('../src/frames.js');
  const { BASE_PALETTE } = await import('../src/fast.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-mid-'));
  try {
    const info = await probe(REC1031);
    const color = colorPlan(info);
    for (const start of [60, 23.4]) {
      const c = { start, dur: 5, width: 900, fps: 10 };
      const fr = await extractFrames({ file: REC1031, info, color, ...c, dir: path.join(dir, `a${start}`) });
      const kb = await encodeFromSource({ file: REC1031, info, color, ...c, palette: BASE_PALETTE, out: path.join(dir, `b${start}.gif`), keepFrames: true });
      const kf = await writeRawFrames(kb.chunks, { file: REC1031, color, ...c, w: kb.w, h: kb.h, n: kb.n, dir: path.join(dir, `k${start}`) });
      assert.equal(kb.n, fr.n, `从 ${start} 秒起：帧数`);
      assert.equal(await sha(kf.raw), await sha(fr.raw), `从 ${start} 秒起：原始帧逐字节一样`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
