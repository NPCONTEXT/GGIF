// 快测试：不编码视频，几秒跑完。慢测试在 slow.test.js（设 GIFKIT_SLOW=1 才跑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseGif, gifSummary } from '../src/gif.js';
import { fillFrames, TINY_FRAME_BYTES } from '../src/fill.js';
import { checkGif } from '../src/check.js';
import { PRESETS, defaultLadder } from '../src/presets.js';
import { buildLadder, safeOutputPath, trimSuggestions, convertFile, outputBase } from '../src/convert.js';
import { normalizeManual, needsEncoderPath, describeManual, retimeGif, setLoopCount, readLoopCount, paletteuseOpts, LOOP_EXT_BYTES } from '../src/manual.js';
import { colorPlan } from '../src/probe.js';
import { SAMPLES, NO_PRIVATE } from './samples.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');

test('解析 GIF：T1 是 900×506、40 帧、4 秒', { skip: NO_PRIVATE }, async () => {
  const s = gifSummary(await readFile(SAMPLES.t1_40f));
  assert.equal(s.width, 900);
  assert.equal(s.height, 506);
  assert.equal(s.frames, 40);
  assert.equal(s.durationSec, 4);
  assert.equal(s.truncated, false);
});

test('凑帧：40 → 61 帧，总时长不变，每个小帧 29 字节，原图没被改', { skip: NO_PRIVATE }, async () => {
  const src = await readFile(SAMPLES.t1_40f);
  const before = sha(src);
  const r = fillFrames(src, 61);
  assert.equal(r.ok, true);
  assert.equal(r.after, 61);
  assert.equal(r.buffer.length - src.length, 21 * TINY_FRAME_BYTES);
  const s = gifSummary(r.buffer);
  assert.equal(s.frames, 61);
  assert.equal(s.durationSec, gifSummary(src).durationSec);
  assert.deepEqual(s.disposals, [1]);
  assert.equal(sha(src), before, '输入的 Buffer 不能被改');
});

test('凑帧：帧数已够就原样返回', { skip: NO_PRIVATE }, async () => {
  const src = await readFile(SAMPLES.t2_78f);
  const r = fillFrames(src, 61);
  assert.equal(r.ok, true);
  assert.equal(r.added, 0);
  assert.equal(r.buffer, src);
});

test('凑帧：一帧可以拆多次（40 帧凑到 200 帧）', { skip: NO_PRIVATE }, async () => {
  const src = await readFile(SAMPLES.t1_40f);
  const r = fillFrames(src, 200);
  assert.equal(r.ok, true);
  const s = gifSummary(r.buffer);
  assert.equal(s.frames, 200);
  assert.equal(s.durationSec, 4);
  const g = parseGif(r.buffer);
  assert.ok(g.frames.every((f) => f.delay >= 2), '每段延时至少 2/100 秒');
});

test('凑帧：处置方式是 2 的帧不拆，凑不够时说明原因、不改文件', { skip: NO_PRIVATE }, async () => {
  const src = Buffer.from(await readFile(SAMPLES.t1_40f));
  const g = parseGif(src);
  for (const f of g.frames) {
    const p = g.blocks[f.gceIndex].start + 3;
    src[p] = (src[p] & ~(7 << 2)) | (2 << 2); // 全部改成处置 2
  }
  const r = fillFrames(src, 61);
  assert.equal(r.ok, false);
  assert.match(r.reason, /2\/3/);
  assert.equal(r.buffer, src);
});

test('凑帧：延时太短凑不够时说明原因', { skip: NO_PRIVATE }, async () => {
  const src = Buffer.from(await readFile(SAMPLES.t1_40f));
  const g = parseGif(src);
  for (const f of g.frames) src.writeUInt16LE(3, g.blocks[f.gceIndex].start + 4); // 每帧 3/100 秒，拆不了
  const r = fillFrames(src, 61);
  assert.equal(r.ok, false);
  assert.match(r.reason, /最多只能补 0 帧/);
});

test('合规检查：上限、宽度、帧数、凑帧提示', { skip: NO_PRIVATE }, async () => {
  const up = PRESETS.upload;
  const a = await checkGif(SAMPLES.t1_40f, up, { decode: false });
  assert.equal(a.ok, true);
  assert.equal(a.needsFill, true);
  const b = await checkGif(SAMPLES.t2_78f, PRESETS.paste, { decode: false });
  assert.equal(b.ok, false);
  assert.match(b.problems.join(), /超过上限/);
  const c = await checkGif(SAMPLES.w1440, up, { decode: false });
  assert.match(c.problems.join(), /宽 1440/);
  const d = await checkGif(SAMPLES.f301, up, { decode: false });
  assert.match(d.problems.join(), /总帧数 301/);
  const e = await checkGif(SAMPLES.s10mib, up, { decode: false });
  assert.match(e.problems.join(), /超过上限/);
});

test('合规检查：完整解码一遍', { skip: NO_PRIVATE }, async () => {
  const r = await checkGif(SAMPLES.t2_78f, PRESETS.upload);
  assert.equal(r.ok, true);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-t-'));
  const bad = path.join(dir, '截断.gif');
  const buf = await readFile(SAMPLES.t1_40f);
  await writeFile(bad, buf.subarray(0, Math.floor(buf.length / 2)));
  const r2 = await checkGif(bad, PRESETS.upload);
  assert.equal(r2.ok, false);
  await rm(dir, { recursive: true });
});

test('试档顺序：宽度优先、不放大、不超 1080', () => {
  const up = PRESETS.upload;
  assert.deepEqual(defaultLadder(2400).slice(0, 3), [{ width: 900, fps: 10 }, { width: 900, fps: 8 }, { width: 800, fps: 10 }]);
  assert.deepEqual([...new Set(buildLadder(650, up).map((t) => t.width))], [650, 600]);
  assert.ok(buildLadder(2400, up).every((t) => t.width <= 900));
  assert.deepEqual(buildLadder(2400, up, { prefer: 'smooth' }).slice(0, 2), [{ width: 900, fps: 15 }, { width: 800, fps: 15 }]);
  assert.deepEqual(buildLadder(2400, up, { width: 1200 }), [{ width: 1080, fps: 10 }, { width: 1080, fps: 8 }]);
  assert.deepEqual(buildLadder(2400, up, { fps: 12 }).map((t) => t.width), [900, 800, 700, 600]);
});

test('输出路径：已有文件时加编号，绝不覆盖', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-t-'));
  const p = path.join(dir, 'a.gif');
  assert.equal(safeOutputPath(p), p);
  await writeFile(p, 'x');
  assert.equal(safeOutputPath(p), path.join(dir, 'a (1).gif'));
  await writeFile(path.join(dir, 'a (1).gif'), 'x');
  assert.equal(safeOutputPath(p), path.join(dir, 'a (2).gif'));
  await rm(dir, { recursive: true });
});

test('剪短建议：按体积比例推算，每个宽度一条，最多 3 条，只给更短的', () => {
  const lim = 4_800_000;
  const tried = [
    { width: 900, fps: 10, estimate: 4.68 * lim, limit: lim },
    { width: 900, fps: 8, estimate: 3.91 * lim, limit: lim },
    { width: 800, fps: 10, estimate: 3.83 * lim, limit: lim },
    { width: 700, fps: 10, estimate: 2.97 * lim, limit: lim },
    { width: 600, fps: 10, estimate: 2.0 * lim, limit: lim },
    { width: 600, fps: 8, estimate: 1.0 * lim, limit: lim },
    { width: 500, fps: 8 },
  ];
  const t = trimSuggestions(tried, 10.75);
  assert.deepEqual(t.map((x) => [x.width, x.fps]), [[900, 10], [800, 10], [700, 10]]);
  assert.ok(Math.abs(t[0].dur - 3.6) < 0.11);
  assert.ok(t.every((x) => x.dur < 10.75));
  assert.deepEqual(trimSuggestions([{ width: 600, fps: 8, estimate: lim, limit: lim }], 10), []);
});

test('色彩：Display P3 转、bt709 不转、没标记提示', () => {
  const p3 = colorPlan({ kind: 'video', primaries: 'smpte432', transfer: 'bt709', matrix: 'bt709', range: 'tv' });
  assert.equal(p3.convert, true);
  assert.match(p3.filter, /iprimaries=smpte432/);
  assert.equal(colorPlan({ kind: 'video', primaries: 'bt709' }).convert, false);
  const none = colorPlan({ kind: 'video', primaries: null });
  assert.equal(none.convert, false);
  assert.equal(none.warn, true);
  assert.equal(colorPlan({ kind: 'video', primaries: 'bt2020' }).warn, true);
  assert.equal(colorPlan({ kind: 'gif' }).convert, false);
  assert.equal(colorPlan({ kind: 'video', primaries: 'smpte432' }, 'none').convert, false);
  assert.equal(colorPlan({ kind: 'video', primaries: null }, 'p3').convert, true);
});

// ---- 极速 / 标准的有损搜索（合成曲线，不真编码）----
import { fitLossy, tierWeight } from '../src/fast.js';

/** 合成编码器：体积 = b0 × exp(-s × ln((L+4)/4))，和 10-17 实测的曲线同形。记下每次调用的 L。 */
function fakeEncode(b0, s) {
  const calls = [];
  const enc = async (L) => {
    calls.push(L);
    return { ok: true, bytes: Math.round(b0 * Math.exp(-s * Math.log((L + 4) / 4))), file: `L${L}` };
  };
  return { enc, calls };
}

test('有损搜索：3 轮内压到上限的 92% 以上，s 偏离默认值也行', async () => {
  for (const s of [0.30, 0.37, 0.45]) {
    for (const b0 of [12e6, 20e6, 30e6]) {
      const { enc, calls } = fakeEncode(b0, s);
      const r = await fitLossy(enc, 9.9e6, { rounds: 3, near: 0.92 });
      assert.ok(r.best, `s=${s} b0=${b0} 没装下`);
      assert.ok(r.best.bytes <= 9.9e6);
      assert.ok(r.best.bytes >= 9.9e6 * 0.92, `s=${s} b0=${b0} 只到 ${(r.best.bytes / 9.9e6).toFixed(3)}`);
      assert.ok(calls.length <= 6, `编了 ${calls.length} 次`); // 无损 1 + 猜 3 + 插值 2（每轮并行）
    }
  }
});

test('有损搜索：无损就装得下时不压', async () => {
  const { enc, calls } = fakeEncode(8e6, 0.37);
  const r = await fitLossy(enc, 9.9e6, { rounds: 3, near: 0.92 });
  assert.equal(r.best.lossy, 0);
  assert.deepEqual(calls, [0]);
});

test('有损搜索：推算远超上限时只试无损就放弃，留给上层降档', async () => {
  const { enc, calls } = fakeEncode(40e6, 0.37);
  const r = await fitLossy(enc, 4.8e6, { rounds: 3, near: 0.92, giveUp: 45 });
  assert.equal(r.gaveUp, true);
  assert.deepEqual(calls, [0]);
});

test('有损搜索：曲线很平（有损压不动）时试一轮就放弃，不白跑到 200', async () => {
  // 作者那张 13MB、每秒 30 帧的 GIF 压到粘贴档 4.8MB 的情形（10-17 实测直接压 s 约 0.14）
  const { enc, calls } = fakeEncode(13e6, 0.14);
  const r = await fitLossy(enc, 4.8e6, { rounds: 3, near: 0.92, giveUp: 45 });
  assert.equal(r.gaveUp, true);
  assert.ok(calls.length <= 5 && !calls.includes(200), `试了 ${calls}`); // 无损 1 次 + 第 2 轮 4 个并行
  assert.ok(r.slope < 0.2, `校准后的 s 是 ${r.slope}`);
  assert.ok(calls.every((L) => L <= 45), `试了超过上限的点：${calls}`);
});

test('有损搜索：小有损几乎压不动、到 30 以上才变小的曲线（GIF 直接压），不误放弃', async () => {
  // 仿 10-17 作者 GIF：无损 14.46MB，有损 34 → 9.72MB，有损 6–10 几乎不变
  const calls = [];
  const enc = async (L) => {
    calls.push(L);
    const k = L < 12 ? L * 0.003 : 0.036 + (L - 12) * 0.0147;
    return { ok: true, bytes: Math.round(14.46e6 * Math.exp(-k)), file: `L${L}` };
  };
  const r = await fitLossy(enc, 9.9e6, { rounds: 4, near: 0.92, giveUp: 45 });
  assert.equal(r.gaveUp, false, `试了 ${calls}`);
  assert.ok(r.best && r.best.lossy <= 45 && r.best.bytes >= 9.9e6 * 0.85, `best ${JSON.stringify(r.best)}，试了 ${calls}`);
});

test('有损搜索：最后一档（不设上限）装不下时用最大有损兜底一次', async () => {
  const { enc, calls } = fakeEncode(100e6, 0.37);
  const r = await fitLossy(enc, 4.8e6, { rounds: 3, near: 0.92 });
  assert.equal(r.best, null);
  assert.ok(calls.includes(200));
});

test('各档体积比例：和 10-17 实测（以 900×10 为 1）差不到 0.03', () => {
  const r = (w, f) => tierWeight({ width: w, fps: f }) / tierWeight({ width: 900, fps: 10 });
  for (const [w, f, lo, hi] of [[900, 8, 0.78, 0.81], [800, 10, 0.80, 0.81], [700, 8, 0.50, 0.53], [600, 8, 0.38, 0.40]]) {
    const x = r(w, f);
    assert.ok(x > lo - 0.03 && x < hi + 0.03, `${w}×${f} 算出 ${x.toFixed(3)}`);
  }
});

// ---- 难素材：lessgif 画质值搜索（合成曲线）----
import { fitQuality } from '../src/fast.js';

/** 仿 10-17 实测：体积 = s70 × exp(k × (q − 70))。 */
function fakeLessgif(s70, k) {
  const calls = [];
  const enc = async (q) => {
    calls.push(q);
    return { ok: true, bytes: Math.round(s70 * Math.exp(k * (q - 70))), file: `q${q}` };
  };
  return { enc, calls };
}

test('lessgif 画质搜索：2 轮内装下、到上限 92% 以上，不低于底线', async () => {
  for (const [s70, k] of [[10.7e6, 0.0294], [14.2e6, 0.025], [13.1e6, 0.03]]) {
    const { enc, calls } = fakeLessgif(s70, k);
    const qPred = 70 + Math.log((9.9e6 * 0.985) / s70) / 0.0275;
    const r = await fitQuality(enc, 9.9e6, { floor: 45, qPred, rounds: 2, near: 0.92 });
    assert.ok(r.best && r.best.bytes <= 9.9e6 && r.best.bytes >= 9.9e6 * 0.92, `s70=${s70} best ${JSON.stringify(r.best)} 试了 ${calls}`);
    assert.ok(calls.every((q) => q >= 45));
    assert.ok(calls.length <= 5, `编了 ${calls.length} 次`);
  }
});

test('lessgif 画质搜索：底线都装不下时返回空，不往底线以下试', async () => {
  const { enc, calls } = fakeLessgif(60e6, 0.0275);
  const r = await fitQuality(enc, 9.9e6, { floor: 45, qPred: 50, rounds: 3, near: 0.92 });
  assert.equal(r.best, null);
  assert.ok(calls.every((q) => q >= 45) && calls.includes(45), `试了 ${calls}`);
});

// ---------- 手动参数（manual.js，TODO 2.33） ----------

test('手动参数校验：全自动 / 等于默认值的当作没改，返回 null', () => {
  assert.equal(normalizeManual(undefined), null);
  assert.equal(normalizeManual(null), null);
  assert.equal(normalizeManual({}), null);
  assert.equal(normalizeManual({ encoder: 'auto', quality: 'auto', colors: null, dither: '', lossy: 0, speed: 1, loop: 0, saturation: 1 }), null);
});

test('手动参数校验：字符串数字能认、整数项取整、小数项保留两位', () => {
  assert.deepEqual(normalizeManual({ encoder: 'gifski', quality: '70.4', colors: 64.6, dither: 0.333, lossy: '30', width: 641, fps: '12', speed: 1.25, loop: 3, saturation: 1.2 }),
    { encoder: 'gifski', quality: 70, colors: 65, dither: 0.33, lossy: 30, width: 641, fps: 12, speed: 1.25, loop: 3, saturation: 1.2 });
  assert.deepEqual(normalizeManual({ loop: 1 }), { loop: 1 }); // 只放一遍不是默认值
});

test('手动参数校验：超范围、不认识的参数、错的编码器都报错并说明是哪一项', () => {
  const bad = [
    [{ quality: 101 }, /画质要在 0–100/], [{ quality: -1 }, /画质/], [{ colors: 8 }, /颜色数要在 16–256/], [{ colors: 300 }, /颜色数/],
    [{ dither: 1.5 }, /抖动强度/], [{ lossy: 201 }, /额外有损/], [{ width: 1200 }, /宽度要在 100–1080/], [{ width: 50 }, /宽度/],
    [{ fps: 0 }, /帧率/], [{ fps: 60 }, /帧率/], [{ speed: 3 }, /播放速度要在 0.5–2/], [{ speed: 0.4 }, /播放速度/],
    [{ loop: -1 }, /播放次数/], [{ saturation: 2 }, /饱和度/], [{ quality: 'abc' }, /画质/], [{ encoder: 'x264' }, /编码器只能是/], [{ qualty: 50 }, /不认识的参数「qualty」/],
  ];
  for (const [m, re] of bad) assert.throws(() => normalizeManual(m), re, JSON.stringify(m));
  assert.throws(() => normalizeManual('70'), /对象/);
});

test('手动参数：改了编码器 / 画质 / 颜色数 / 抖动才走指定编码器那条路；说明文字', () => {
  assert.equal(needsEncoderPath({ speed: 1.5, loop: 2, saturation: 1.2, lossy: 20, width: 700 }), false);
  for (const m of [{ encoder: 'ffmpeg' }, { quality: 50 }, { colors: 32 }, { dither: 0 }]) assert.equal(needsEncoderPath(m), true, JSON.stringify(m));
  assert.equal(describeManual({ encoder: 'ffmpeg', quality: 60, loop: 1, speed: 1.5 }), '编码器 ffmpeg+gifsicle，画质 60，1.5× 速度，只放一遍');
});

test('手动参数：参数不对时 convertFile 直接报错（不读文件、不编码）', { skip: NO_PRIVATE }, async () => {
  await assert.rejects(convertFile(SAMPLES.t1_40f, path.join(os.tmpdir(), 'gifkit-不该生成.gif'), { manual: { quality: 300 } }), /画质要在 0–100/);
});

test('ffmpeg 抖动换算：不改时和快路子一样 bayer 3；0 不抖；0.5 对应 3；1 最强', () => {
  assert.equal(paletteuseOpts(undefined), 'dither=bayer:bayer_scale=3');
  assert.equal(paletteuseOpts(0), 'dither=none');
  assert.equal(paletteuseOpts(0.5), 'dither=bayer:bayer_scale=3');
  assert.equal(paletteuseOpts(1), 'dither=bayer:bayer_scale=0');
  assert.equal(paletteuseOpts(0.2), 'dither=bayer:bayer_scale=4');
});

test('播放速度：改延时，帧数不变，总时长按倍数缩放（误差 ≤1/100 秒），不改输入', { skip: NO_PRIVATE }, async () => {
  const src = await readFile(SAMPLES.t1_40f); // 40 帧 × 10/100 秒
  const before = sha(src);
  for (const [speed, cs] of [[2, 200], [1.5, 267], [0.5, 800], [1.25, 320], [0.75, 533]]) {
    const r = retimeGif(src, speed);
    const s = gifSummary(r.buffer);
    assert.equal(s.frames, 40);
    assert.equal(r.afterCs, cs, `${speed}×`);
    assert.equal(Math.round(s.durationSec * 100), cs);
    assert.equal(r.clamped, 0);
    assert.equal(r.buffer.length, src.length, '只改延时，不加不减字节');
    const ds = parseGif(r.buffer).frames.map((f) => f.delay);
    assert.ok(Math.max(...ds) - Math.min(...ds) <= 1, `${speed}× 延时分布不匀：${ds}`);
  }
  assert.equal(sha(src), before, '输入的 Buffer 不能被改');
});

test('播放速度：算出来不到 2/100 秒的帧按 2 算（GIF 最短延时），报出被限住的帧数', { skip: NO_PRIVATE }, async () => {
  const filled = fillFrames(await readFile(SAMPLES.t1_40f), 200).buffer; // 每段 2/100 秒
  const r = retimeGif(filled, 2);
  const ds = parseGif(r.buffer).frames.map((f) => f.delay);
  assert.ok(ds.every((d) => d >= 2), '每帧至少 2/100 秒');
  assert.ok(r.clamped > 0);
  assert.equal(r.beforeCs, 400);
  assert.ok(r.afterCs >= 400, '已经是最短延时，加速不了');
});

test('播放次数：无限 / 只放一遍 / 放 n 遍，循环扩展写对、其余块不动、能完整解码', { skip: NO_PRIVATE }, async () => {
  const src = await readFile(SAMPLES.t1_40f);
  assert.equal(readLoopCount(src), 0, 'lessgif 默认无限循环');
  const once = setLoopCount(src, 1);
  assert.equal(readLoopCount(once), 1);
  assert.equal(once.length, src.length - LOOP_EXT_BYTES, '只放一遍 = 去掉循环扩展');
  const three = setLoopCount(once, 3);
  assert.equal(readLoopCount(three), 3);
  assert.equal(three.length, src.length);
  const g = parseGif(three);
  const ext = g.blocks.find((b) => b.kind === 'ext');
  assert.equal(ext.start, g.headEnd, '循环扩展放在文件头后面');
  assert.equal(three.readUInt16LE(ext.start + 16), 2, '放 3 遍 = 循环扩展写 2');
  assert.equal(readLoopCount(setLoopCount(three, 0)), 0);
  assert.equal(readLoopCount(setLoopCount(src, 65)), 65);
  for (const b of [once, three]) {
    const s = gifSummary(b);
    assert.equal(s.frames, 40);
    assert.equal(s.durationSec, 4);
    assert.equal(s.truncated, false);
  }
  assert.equal(sha(setLoopCount(once, 0)), sha(src), '改回无限就和原文件一字节不差');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-t-'));
  try {
    const f = path.join(dir, 'loop3.gif');
    await writeFile(f, three);
    const c = await checkGif(f, PRESETS.upload);
    assert.deepEqual(c.problems, []);
  } finally {
    await rm(dir, { recursive: true });
  }
  assert.throws(() => setLoopCount(src, 1.5), /播放次数/);
});

// ---- 导入上限 ----
import { checkInputLimits, INPUT_LIMITS, OVER_LIMIT_HINT } from '../src/limits.js';

test('导入上限：GIF 200MB、视频 100MB（作者定），超了在解码前拒绝并写明超了哪项', () => {
  assert.equal(checkInputLimits({ kind: 'gif', duration: 10.5, width: 1466, height: 812 }, 34.7e6).ok, true);
  assert.equal(checkInputLimits({ kind: 'gif', duration: 10, width: 1080, height: 600 }, 199e6).ok, true);
  assert.equal(checkInputLimits({ kind: 'gif', duration: 10, width: 1080, height: 600 }, 201e6).ok, false);
  assert.equal(checkInputLimits({ kind: 'video', duration: 85.6, width: 2314, height: 1276 }, 99e6).ok, true);
  assert.match(checkInputLimits({ kind: 'video', duration: 25, width: 2018, height: 1130 }, 199e6).reason, /199MB，超过 视频 上限 100MB/);
  const big = checkInputLimits({ kind: 'video', duration: 3600, width: 3840, height: 2160 }, 8e9);
  assert.equal(big.ok, false);
  assert.ok(big.reason.startsWith(OVER_LIMIT_HINT));
  assert.match(big.reason, /3600 秒/);
  assert.match(big.reason, /8000MB/);
  const tall = checkInputLimits({ kind: 'gif', duration: 5, width: 1000, height: 5000 }, 10e6);
  assert.equal(tall.ok, false);
  assert.match(tall.reason, /长边/);
  assert.equal(INPUT_LIMITS.gif.maxBytes, 200e6);
  assert.equal(INPUT_LIMITS.video.maxBytes, 100e6);
});

test('末帧停留：最后一帧延时加上去，别的帧不动；0 秒算自动', { skip: NO_PRIVATE }, async () => {
  const { holdLastFrame, normalizeManual } = await import('../src/manual.js');
  const buf = await readFile(SAMPLES.t1_40f);
  const before = parseGif(buf).frames.map((f) => f.delay);
  const after = parseGif(holdLastFrame(buf, 1.5)).frames.map((f) => f.delay);
  assert.equal(after.at(-1), before.at(-1) + 150);
  assert.deepEqual(after.slice(0, -1), before.slice(0, -1));
  assert.equal(normalizeManual({ hold: 0 }), null);
  assert.deepEqual(normalizeManual({ hold: 2 }), { hold: 2 });
  assert.throws(() => normalizeManual({ hold: 20 }), /末帧停留/);
});

test('输出文件名：已经带「_压缩」「_压缩_4.8M」「 (1)」「_公众号」的先去掉再加，不叠成「_压缩_压缩」；别的名字不动', () => {
  assert.equal(outputBase('/a/x_压缩.gif'), 'x');
  assert.equal(outputBase('/a/x_压缩_4.8M.gif'), 'x');
  assert.equal(outputBase('/a/x_压缩 (2).gif'), 'x');
  assert.equal(outputBase('/a/x_压缩_4.8M (1).gif'), 'x');
  assert.equal(outputBase('/a/x_公众号.gif'), 'x');
  assert.equal(outputBase('/a/截图_压缩稿.gif'), '截图_压缩稿');
  assert.equal(outputBase('/a/x.mov'), 'x');
});

test('旋转标记：竖拍存成横的视频按转好的宽高算，取帧是竖的、不被压扁（10-19 晚查出）', async () => {
  const { run, TOOLS } = await import('../src/tools.js');
  const { probe } = await import('../src/probe.js');
  const { extractFrames } = await import('../src/frames.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-rot-'));
  try {
    const land = path.join(dir, 'land.mp4');
    const rot = path.join(dir, 'rot90.mp4');
    let r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', land]);
    assert.equal(r.code, 0, r.stderr);
    r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-display_rotation', '90', '-i', land, '-c', 'copy', rot]);
    assert.equal(r.code, 0, r.stderr);
    const a = await probe(land);
    assert.deepEqual([a.width, a.height, a.rotation], [64, 36, 0]);
    const b = await probe(rot);
    assert.deepEqual([b.width, b.height, b.rotation], [36, 64, 90]);
    const f = await extractFrames({ file: rot, info: b, color: colorPlan(b), dur: 1, width: 18, fps: 5, dir });
    assert.deepEqual([f.w, f.h], [18, 32]);
    assert.ok(f.n >= 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('导入上限：工具自己录的片段（登记过的文件夹里）不受视频 100MB 体积上限，时长照查（10-19 晚录屏）', async () => {
  const { checkInputLimits, allowOwnRecordings } = await import('../src/limits.js');
  const info = { kind: 'video', width: 1920, height: 1080, duration: 60 };
  const own = path.join(os.tmpdir(), 'GIF工具录屏测试');
  assert.equal(checkInputLimits(info, 150e6, path.join(own, '片段01.mp4')).ok, false, '没登记前照常拒绝');
  allowOwnRecordings(own);
  assert.equal(checkInputLimits(info, 150e6, path.join(own, '2026-10-19 20-00-00', '片段01.mp4')).ok, true);
  assert.equal(checkInputLimits(info, 150e6, path.join(os.tmpdir(), '别处.mp4')).ok, false);
  assert.equal(checkInputLimits(info, 150e6, `${own}外面.mp4`).ok, false, '名字开头一样的别的文件夹不算');
  assert.equal(checkInputLimits({ ...info, duration: 400 }, 1e6, path.join(own, 'x.mp4')).ok, false, '时长上限照查');
});

test('导入上限：主界面打开来剪的（ignoreBytes）不查体积，时长照查（作者选「主界面打开不限体积」）', async () => {
  const { checkInputLimits } = await import('../src/limits.js');
  const info = { kind: 'video', width: 1920, height: 1080, duration: 200 };
  assert.equal(checkInputLimits(info, 300e6, '/tmp/下载的PV.mp4').ok, false, '默认照常拒绝');
  assert.equal(checkInputLimits(info, 300e6, '/tmp/下载的PV.mp4', { ignoreBytes: true }).ok, true);
  assert.equal(checkInputLimits({ ...info, duration: 400 }, 300e6, '/tmp/下载的PV.mp4', { ignoreBytes: true }).ok, false, '5 分钟时长上限照查');
});

test('主界面打开的视频不查体积、也不查时长（作者放开 100MB，10-20「可以改进」放开 5 分钟）；长边、GIF 的时长照查', () => {
  const longPv = { kind: 'video', duration: 720, width: 1280, height: 720 };
  assert.equal(checkInputLimits(longPv, 420e6).ok, false); // 拖到菜单栏、双击（整个文件直接压）照查
  assert.equal(checkInputLimits(longPv, 420e6, null, { ignoreBytes: true }).ok, false); // 只放开体积：12 分钟还是超
  assert.equal(checkInputLimits(longPv, 420e6, null, { ignoreBytes: true, ignoreSeconds: true }).ok, true);
  assert.equal(checkInputLimits({ kind: 'video', duration: 720, width: 5000, height: 2800 }, 420e6, null, { ignoreBytes: true, ignoreSeconds: true }).ok, false); // 长边照查
  assert.equal(checkInputLimits({ kind: 'gif', duration: 150, width: 800, height: 450 }, 50e6, null, { ignoreBytes: true, ignoreSeconds: true }).ok, false); // GIF 的 120 秒照查
});

test('失败原因：每一档都是因为帧数超了被跳过（段太长），直接说太长、剪到几秒以内（作者）；别的失败照旧', async () => {
  const { tooLongReason } = await import('../src/presets.js');
  const tried = [{ width: 900, fps: 10, result: '总帧数约 1000，超过 300，跳过' }, { width: 900, fps: 8, result: '总帧数约 800，超过 300，跳过' }];
  assert.match(tooLongReason(tried, 100, 300), /太长了：100\.0 秒按每秒 8 帧也有约 800 帧，公众号最多 300 帧；剪到 37\.5 秒以内/);
  assert.equal(tooLongReason([...tried, { width: 800, fps: 10, result: '装不下' }], 100, 300), null);
  assert.equal(tooLongReason([], 100, 300), null);
});

// ---------- 10-20 最后一轮审查修的（E3、E6） ----------
test('小图：不到 200 宽的 GIF 剪了起止、视频，都按原宽压（10-20 审查 E6：原来 GIF 报 ffmpeg 错、视频说每一档都装不下）', async () => {
  const { run, TOOLS } = await import('../src/tools.js');
  const { widthSteps } = await import('../src/presets.js');
  assert.deepEqual(widthSteps(1080), [900, 800, 700, 600]);
  assert.deepEqual(widthSteps(650), [650, 600]);
  assert.deepEqual(widthSteps(151), [150]);
  assert.ok(defaultLadder(150).length && defaultLadder(150).every((t) => t.width === 150));
  assert.ok(buildLadder(160, PRESETS.upload).length);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-small-'));
  try {
    const gif = path.join(dir, '小图.gif');
    const mp4 = path.join(dir, '小视频.mp4');
    let r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=150x100:rate=10:duration=3', gif]);
    assert.equal(r.code, 0, r.stderr);
    r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
    assert.equal(r.code, 0, r.stderr);
    const a = await convertFile(gif, path.join(dir, 'a.gif'), { preset: 'upload', start: 0.5, dur: 2 });
    assert.ok(a.ok, a.reason);
    assert.equal(gifSummary(await readFile(a.output)).width, 150);
    const b = await convertFile(mp4, path.join(dir, 'b.gif'), { preset: 'upload' });
    assert.ok(b.ok, b.reason);
    assert.equal(gifSummary(await readFile(b.output)).width, 160);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('帧间隔全是 0 的 GIF：直接压、批量重压都压得了（10-20 审查 E3：原来帧率算成无穷大，算画质分时报错）', { skip: NO_PRIVATE || (!existsSync(SAMPLES.n2) && 'N2 样片不在') }, async () => {
  const { run, TOOLS } = await import('../src/tools.js');
  const { batch } = await import('../src/batch.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-zero-'));
  try {
    // 游戏录屏截 7 秒、320 宽、每秒 10 帧（70 帧），再把每帧的间隔都改成 0
    const src = path.join(dir, '原.gif');
    const gif0 = path.join(dir, '零间隔.gif');
    let r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-ss', '24', '-t', '7', '-i', SAMPLES.n2, '-vf', 'fps=10,scale=320:-2:flags=lanczos', src]);
    assert.equal(r.code, 0, r.stderr);
    r = await run(TOOLS.gifsicle, ['--delay', '0', src, '-o', gif0]);
    assert.equal(r.code, 0, r.stderr);
    const sum = gifSummary(await readFile(gif0));
    assert.equal(sum.durationSec, 0);
    assert.ok(sum.frames >= 61);
    const { size } = await (await import('node:fs/promises')).stat(gif0);
    // 上限比原图小一点：一键会先试「gifsicle 直接压原帧」那一档，压完算画质分（原来就在这一步报错）
    const preset = { ...PRESETS.upload, id: 'test', limit: Math.round(size * 0.98) };
    const a = await convertFile(gif0, path.join(dir, 'a.gif'), { preset });
    assert.ok(a.ok, a.reason);
    const b = await batch([gif0], path.join(dir, '批量'), { preset });
    assert.ok(b.items[0].ok, b.items[0].detail);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('视频按「标准」速度压：每次都检查画质，不报错（10-22 作者试用：fd0b0aa 起视频一检查画质就报「reading durationSec」，标准速度压视频必失败）', async () => {
  const { run, TOOLS } = await import('../src/tools.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-std-'));
  try {
    const src = path.join(dir, '小视频.mp4');
    const r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    assert.equal(r.code, 0, r.stderr);
    const a = await convertFile(src, path.join(dir, 'a.gif'), { preset: 'upload', mode: 'standard' });
    assert.ok(a.ok, a.reason);
    assert.ok(a.tried.some((t) => typeof t.ssim === 'number'), `没走到检查画质：${JSON.stringify(a.tried)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('凑帧关掉（10-22 设置卷「凑到 61 帧」总开关）：只差帧数的 GIF 不凑、当已合规，说明里写清；开着照旧凑帧', async () => {
  const { run, TOOLS } = await import('../src/tools.js');
  const { batch } = await import('../src/batch.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-nofill-'));
  try {
    const gif = path.join(dir, '短.gif'); // 160 宽、每秒 10 帧、3 秒 = 30 帧：别的都合规，只差帧数
    const r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=3', gif]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(gifSummary(await readFile(gif)).frames < 61);
    const on = await batch([gif], path.join(dir, '开着'), { preset: 'upload' });
    assert.equal(on.items[0].action, '凑帧', on.items[0].detail);
    const off = await batch([gif], dir, { preset: 'upload', fill: false });
    assert.equal(off.items[0].action, '已合规', off.items[0].detail);
    assert.equal(off.items[0].output, gif);
    assert.match(off.items[0].detail, /没凑帧/);
    const offElsewhere = await batch([gif], path.join(dir, '关着'), { preset: 'upload', fill: false });
    assert.equal(offElsewhere.items[0].action, '原样保留', offElsewhere.items[0].detail);
    assert.equal(gifSummary(await readFile(offElsewhere.items[0].output)).frames, gifSummary(await readFile(gif)).frames);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('放进指定文件夹（10-22 设置卷「结果放哪」）：keepSuffix 时名字照样带档位后缀，9.9 和 4.8 两版不撞名；合规的复制一份过去', async () => {
  const { run, TOOLS } = await import('../src/tools.js');
  const { batch } = await import('../src/batch.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-outdir-'));
  try {
    const gif = path.join(dir, '短.gif'); // 30 帧：别的都合规，只差帧数
    const r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=3', gif]);
    assert.equal(r.code, 0, r.stderr);
    const out = path.join(dir, '指定的');
    const a = await batch([gif], out, { preset: 'upload', keepSuffix: true });
    const b = await batch([gif], out, { preset: 'paste', keepSuffix: true });
    assert.equal(path.basename(a.items[0].output), `短${PRESETS.upload.fileSuffix}.gif`, a.items[0].detail);
    assert.equal(path.basename(b.items[0].output), `短${PRESETS.paste.fileSuffix}.gif`, b.items[0].detail);
    assert.notEqual(a.items[0].output, b.items[0].output);
    const c = await batch([gif], path.join(dir, '合规的'), { preset: 'upload', keepSuffix: true, fill: false });
    assert.equal(c.items[0].action, '原样保留', c.items[0].detail);
    assert.equal(path.basename(c.items[0].output), `短${PRESETS.upload.fileSuffix}.gif`);
    const d = await batch([gif], path.join(dir, '不带'), { preset: 'upload' }); // 不在原文件夹、也没要后缀：照旧不加
    assert.equal(path.basename(d.items[0].output), '短.gif');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('直出（10-31 负载优化）：一条 ffmpeg 从原片出基底 GIF、代理 GIF，和「取帧 + 编」逐字节一样、帧数一样', async () => {
  const { run, TOOLS } = await import('../src/tools.js');
  const { probe } = await import('../src/probe.js');
  const { extractFrames, encodeFromSource, writeRawFrames } = await import('../src/frames.js');
  const { ffmpegBase, BASE_PALETTE } = await import('../src/fast.js');
  const { encodeProxy } = await import('../src/encoders/index.js');
  const { proxyFromSource } = await import('../src/estimate.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-direct-'));
  try {
    const src = path.join(dir, 'src.mp4');
    const r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', src]);
    assert.equal(r.code, 0, r.stderr);
    const info = await probe(src);
    const cases = [
      { name: 'bt709 整段', color: colorPlan(info), start: 0, dur: 3, width: 200, fps: 10 },
      { name: '从 0.7 秒起、裁画面、每秒 12.5 帧', color: colorPlan(info), start: 0.7, dur: 1.9, width: 120, fps: 12.5, crop: { w: 240, h: 136, x: 40, y: 20 } },
      { name: '按 Display P3 转色', color: colorPlan(info, 'p3'), start: 0.2, dur: 2, width: 160, fps: 8 },
    ];
    for (const c of cases) {
      const sub = await mkdtemp(path.join(dir, 'c-'));
      const frames = await extractFrames({ file: src, info, ...c, dir: sub });
      const oldBase = await ffmpegBase(frames, path.join(sub, 'old_base.gif'));
      const nb = await encodeFromSource({ file: src, info, ...c, palette: BASE_PALETTE, out: path.join(sub, 'new_base.gif') });
      assert.equal(nb.n, frames.n, `${c.name}：帧数`);
      assert.equal(sha(await readFile(nb.file)), sha(await readFile(oldBase)), `${c.name}：基底 GIF 逐字节一样`);
      // 顺带留原始帧（作者选「先放内存」）：基底照样一样，留下的帧写成文件和 extractFrames 取的逐字节一样
      const kb = await encodeFromSource({ file: src, info, ...c, palette: BASE_PALETTE, out: path.join(sub, 'keep_base.gif'), keepFrames: true });
      assert.equal(kb.n, frames.n, `${c.name}：留帧时帧数`);
      assert.equal(sha(await readFile(kb.file)), sha(await readFile(oldBase)), `${c.name}：留帧时基底 GIF 逐字节一样`);
      const kf = await writeRawFrames(kb.chunks, { file: src, ...c, w: kb.w, h: kb.h, n: kb.n, dir: path.join(sub, 'kept') });
      assert.equal(sha(await readFile(kf.raw)), sha(await readFile(frames.raw)), `${c.name}：内存里的原始帧逐字节一样`);
      const op = await encodeProxy(frames, path.join(sub, 'old_proxy.gif'));
      const np = await proxyFromSource({ file: src, info, ...c });
      assert.equal(np.bytes, op.bytes, `${c.name}：代理体积一样`);
      assert.deepEqual([np.n, np.w, np.h], [frames.n, frames.w, frames.h], `${c.name}：帧数和尺寸`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('极速快路子不落原始帧（10-31 负载优化）：压一段视频，工作目录里有基底 GIF、没有 .rgba', async () => {
  const { run, TOOLS } = await import('../src/tools.js');
  const { readdir } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-noraw-'));
  // os.tmpdir() 在 Mac 上读 TMPDIR，在 Windows 上读 TEMP、TMP（Windows版卷 11-07 云端查出）：三个一起换、一起换回
  const TMP_KEYS = ['TMPDIR', 'TEMP', 'TMP'];
  const oldTmp = Object.fromEntries(TMP_KEYS.map((k) => [k, process.env[k]]));
  const restoreTmp = () => { for (const k of TMP_KEYS) { if (oldTmp[k] === undefined) delete process.env[k]; else process.env[k] = oldTmp[k]; } };
  try {
    const src = path.join(dir, 'src.mp4');
    const r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', src]);
    assert.equal(r.code, 0, r.stderr);
    const work = await mkdtemp(path.join(dir, 'tmp-'));
    for (const k of TMP_KEYS) process.env[k] = work; // 引擎的工作目录建在 os.tmpdir() 下，keepWork 留着看里面写过什么
    const out = await convertFile(src, path.join(dir, 'out.gif'), { preset: 'upload', mode: 'fast', keepWork: true });
    restoreTmp();
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.chosen.encoder, 'ffmpeg+gifsicle');
    const files = (await readdir(work, { recursive: true })).map(String);
    assert.ok(files.some((f) => /base_\d+_\d+\.gif$/.test(f)), files.join('、'));
    assert.ok(!files.some((f) => f.endsWith('.rgba')), `不该有原始帧：${files.join('、')}`);
  } finally {
    restoreTmp();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- 11.13（11-01）：动图降帧按 C（匀速的只用原帧率的 1/k）、录屏选了帧率的录像锁帧率 ----------
test('11.13 匀速判断和匀速动图的降帧档：≤15 帧先各宽度保住原帧率再减半；>15 帧只用 ≤15 的 1/k', async () => {
  const { isSteadyGif, steadyGifLadder } = await import('../src/presets.js');
  assert.equal(isSteadyGif([8, 9, 8, 9, 8]), true);
  assert.equal(isSteadyGif([7, 8, 9]), true);
  assert.equal(isSteadyGif([5, 10, 5, 10]), false); // 快慢混着（作者那张 13.6 帧的）
  assert.equal(isSteadyGif([4, 7, 11]), false); // 13 号动漫那种
  assert.equal(isSteadyGif([10, 10, 100]), false); // 结尾停一下的
  assert.equal(isSteadyGif([0, 8, 8]), false);
  assert.equal(isSteadyGif([]), false);
  const W = [900, 800];
  assert.deepEqual(steadyGifLadder(25, W), [900, 800].flatMap((w) => [12.5, 8.33, 6.25].map((fps) => ({ width: w, fps }))));
  assert.deepEqual(steadyGifLadder(12, W), [{ width: 900, fps: 12 }, { width: 800, fps: 12 }, { width: 900, fps: 6 }, { width: 800, fps: 6 }]);
  assert.deepEqual(steadyGifLadder(60, [900]).map((t) => t.fps), [15, 12, 10]);
  assert.deepEqual(steadyGifLadder(100 / 6, [900]).map((t) => t.fps), [8.33, 5.56]); // 6 厘秒一帧：超 15，直接减半
  assert.deepEqual(steadyGifLadder(8, [900]).map((t) => t.fps), [8]); // 再减半就不到 4.5 帧
  assert.deepEqual(steadyGifLadder(3, [900]), []);
});

test('11.13 选档：录像锁了帧率只降宽度（手动定的帧率优先）；匀速动图用整除档，忽长忽短的照旧', () => {
  const up = PRESETS.upload;
  assert.deepEqual(buildLadder(1920, up, {}, { lockFps: 30 }), [900, 800, 700, 600].map((width) => ({ width, fps: 30 })));
  assert.deepEqual(buildLadder(1920, up, { fps: 10 }, { lockFps: 30 }).map((t) => t.fps), [10, 10, 10, 10]);
  assert.deepEqual(buildLadder(1920, up, { prefer: 'smooth' }, { lockFps: 5 }).map((t) => t.fps), [5, 5, 5, 5]);
  assert.deepEqual(buildLadder(1920, up, {}, { lockFps: null }), buildLadder(1920, up)); // 高保真：照旧 10 / 8 帧
  assert.deepEqual(buildLadder(1466, up, {}, { gifRate: { fps: 25, steady: true } }).slice(0, 2), [{ width: 900, fps: 12.5 }, { width: 900, fps: 8.33 }]);
  assert.deepEqual(buildLadder(1466, up, { width: 700 }, { gifRate: { fps: 12, steady: true } }), [{ width: 700, fps: 12 }, { width: 700, fps: 6 }]);
  assert.deepEqual(buildLadder(1466, up, {}, { gifRate: { fps: 13.9, steady: false } }), buildLadder(1466, up));
});

test('11.13 取帧：匀速动图、目标是原帧率的 1/k 时按序号取（末尾接 fps 标帧率），别的照旧按时间取', async () => {
  const { sourceFpsFilter } = await import('../src/frames.js');
  const g25 = { kind: 'gif', gifRate: { fps: 25, steady: true } };
  assert.equal(sourceFpsFilter(g25, 12.5), 'select=not(mod(n\\,2)),setpts=N/(12.5*TB),fps=12.5,');
  assert.equal(sourceFpsFilter(g25, 8.33), 'select=not(mod(n\\,3)),setpts=N/(8.33*TB),fps=8.33,');
  assert.equal(sourceFpsFilter({ kind: 'gif', gifRate: { fps: 12, steady: true } }, 12), 'setpts=N/(12*TB),fps=12,');
  assert.equal(sourceFpsFilter(g25, 10), 'fps=10,'); // 不整除（手动定的帧率）：按时间取
  assert.equal(sourceFpsFilter({ kind: 'gif', gifRate: { fps: 25, steady: false } }, 12.5), 'fps=12.5,');
  assert.equal(sourceFpsFilter({ kind: 'gif' }, 10), 'fps=10,');
  assert.equal(sourceFpsFilter({ kind: 'video', lockFps: 30 }, 30), 'fps=30:round=up,');
});

test('11.13 读素材：录像里的帧率标记（ggif-fps=N，60 不算锁）、GIF 的真帧率和是不是匀速；压出来锁帧率、动图整除取帧', async () => {
  const { run, TOOLS } = await import('../src/tools.js');
  const { probe } = await import('../src/probe.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-1113-'));
  try {
    const src = path.join(dir, 'src.mp4');
    let r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    assert.equal(r.code, 0, r.stderr);
    const tagged = async (name, comment) => {
      const p = path.join(dir, name);
      const t = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-i', src, '-c', 'copy', '-metadata', `comment=${comment}`, p]);
      assert.equal(t.code, 0, t.stderr);
      return p;
    };
    const lock30 = await tagged('lock30.mp4', 'ggif-fps=30');
    assert.equal((await probe(lock30)).lockFps, 30);
    assert.equal((await probe(await tagged('hifi.mp4', 'ggif-fps=60'))).lockFps, null);
    assert.equal((await probe(src)).lockFps, null);
    const a = await convertFile(lock30, path.join(dir, 'a.gif'), { preset: 'upload', fill: false });
    assert.ok(a.ok, a.reason);
    assert.equal(a.chosen.fps, 30);
    // 匀速 25 帧、宽过 1080 的 GIF（不能原样压，要缩宽、降帧）：第一档 900 宽 12.5 帧，每 2 帧取 1 帧，每帧 8 厘秒
    const gif = path.join(dir, 'g25.gif');
    r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1200x60:rate=25:duration=3', gif]);
    assert.equal(r.code, 0, r.stderr);
    const gi = await probe(gif);
    assert.equal(gi.gifRate.steady, true);
    assert.ok(Math.abs(gi.gifRate.fps - 25) < 0.01, String(gi.gifRate.fps));
    const b = await convertFile(gif, path.join(dir, 'b.gif'), { preset: 'upload', fill: false });
    assert.ok(b.ok, b.reason);
    assert.deepEqual([b.chosen.width, b.chosen.fps], [900, 12.5]);
    const delays = parseGif(await readFile(b.output)).frames.map((f) => f.delay);
    assert.equal(delays.length, 38);
    assert.ok(delays.every((d) => d === 8), JSON.stringify([...new Set(delays)]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
