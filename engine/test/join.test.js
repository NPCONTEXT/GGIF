// 多选导出（11.14，11-06）：几段拼成一张。快测试：用 4 秒 320×180 的测试图案，几秒跑完。
// 关键的两条：① 只有一段时参数和以前逐字一样（压出来的就逐字节一样）；② 拼起来的帧 = 每段单独取的帧首尾接上，逐字节一样。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg } from '../src/tools.js';
import { probe, colorPlan } from '../src/probe.js';
import { timeArgs, joinRanges, joinedDur, sourceInputs, sourceChain, rawFramePath, extractFrames, encodeFromSource } from '../src/frames.js';
import { score } from '../src/quality.js';
import { convertFile } from '../src/convert.js';
import { gifSummary, parseGif } from '../src/gif.js';

let dir;
let video;
let info;
let color;
const PARTS = [{ start: 0.5, dur: 1 }, { start: 2.5, dur: 1 }]; // 1 秒 + 1 秒，中间跳过 1.5–2.5
const PALETTE = 'palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3';

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-join-'));
  video = path.join(dir, '图案.mp4');
  await ffmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', video]);
  info = await probe(video);
  color = colorPlan(info);
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

test('拼接：只有一段时输入参数、滤镜开头、原始帧文件名和以前逐字一样', () => {
  const f = '/x/原片.mp4';
  assert.deepEqual(sourceInputs(f, info, { start: 2, dur: 3 }), [...timeArgs(info, 2, 3), '-i', f]);
  assert.deepEqual(sourceInputs(f, info, { start: 2, dur: 3, ranges: [{ start: 9, dur: 1 }] }), [...timeArgs(info, 2, 3), '-i', f], '只给一段 ranges 不算拼接');
  assert.deepEqual(sourceInputs(f, info, { start: 0 }), ['-i', f]);
  assert.equal(sourceChain(undefined, 0, 'fps=10'), '[0:v]fps=10');
  assert.equal(sourceChain(null, 1, 'fps=10'), '[1:v]fps=10');
  assert.equal(joinRanges([{ start: 1, dur: 2 }]), null);
  // 原始帧文件名：一段时和改之前的算法一样（缓存键 [源文件, 起, 长, 裁剪, 色彩]）
  const old = createHash('md5').update(JSON.stringify([path.resolve(f), 2, 3, null, ''])).digest('hex').slice(0, 10);
  assert.equal(path.basename(rawFramePath({ file: f, start: 2, dur: 3, w: 10, h: 10, fps: 10, dir: '/d' })), `帧_${old}_10x10_10.rgba`);
});

test('拼接：两段时每段各自定位、各算一个输入，concat 照给的顺序接；时长是几段之和；段不对就报错', () => {
  const f = '/x/原片.mp4';
  assert.deepEqual(sourceInputs(f, info, { start: 0.5, dur: 9, ranges: PARTS }), ['-ss', '0.5', '-t', '1', '-i', f, '-ss', '2.5', '-t', '1', '-i', f]);
  // 每段先各自抽帧、时间归零，再接
  assert.equal(sourceChain(PARTS, 0, 'fps=10'), '[0:v]fps=10,setpts=PTS-STARTPTS[jn0];[1:v]fps=10,setpts=PTS-STARTPTS[jn1];[jn0][jn1]concat=n=2:v=1:a=0');
  assert.equal(sourceChain(PARTS, 1, 'fps=10'), '[1:v]fps=10,setpts=PTS-STARTPTS[jn0];[2:v]fps=10,setpts=PTS-STARTPTS[jn1];[jn0][jn1]concat=n=2:v=1:a=0', '算画质分时参照从第 1 个输入起');
  assert.equal(joinedDur(joinRanges(PARTS)), 2);
  assert.equal(joinedDur(joinRanges([{ start: 0, dur: 11.06 }, { start: 20.82, dur: 5.53 }])), 16.59);
  assert.throws(() => joinRanges([{ start: 1, dur: 0 }, { start: 3, dur: 1 }]), /起止不对/);
  // 拼接的原始帧文件名带上每段起止：和同起点同总长的一段不会撞名
  const a = rawFramePath({ file: f, start: 0.5, dur: 2, ranges: PARTS, w: 10, h: 10, fps: 10, dir: '/d' });
  const b = rawFramePath({ file: f, start: 0.5, dur: 2, w: 10, h: 10, fps: 10, dir: '/d' });
  assert.notEqual(a, b);
});

test('拼接：拼起来取的帧 = 每段单独取的帧首尾接上（逐字节）；直出留在内存的帧也一样', async () => {
  const one = (r, sub) => extractFrames({ file: video, info, color, start: r.start, dur: r.dur, width: 160, fps: 10, dir: path.join(dir, sub) });
  const a = await one(PARTS[0], 'a');
  const b = await one(PARTS[1], 'b');
  assert.equal(a.n, 10);
  assert.equal(b.n, 10);
  const j = await extractFrames({ file: video, info, color, ranges: PARTS, width: 160, fps: 10, dir: path.join(dir, 'j') });
  assert.equal(j.n, 20, '1 秒 + 1 秒，每秒 10 帧');
  const want = Buffer.concat([await readFile(a.raw), await readFile(b.raw)]);
  assert.ok((await readFile(j.raw)).equals(want), '拼起来的帧和两段各自取的接起来逐字节一样');
  const out = path.join(dir, '拼.gif');
  const r = await encodeFromSource({ file: video, info, color, ranges: PARTS, width: 160, fps: 10, palette: PALETTE, out, keepFrames: true });
  assert.equal(r.n, 20);
  assert.ok(Buffer.concat(r.chunks).equals(want), '直出那路留在内存的帧也一样');
  assert.equal(gifSummary(await readFile(out)).frames, 20);
});

test('拼接：切点不在帧上（和真录像一样）也 = 各段单独取的帧接上；接缝处每帧照样 1/10 秒、不多不少', async () => {
  const P = [{ start: 0.513, dur: 1.2 }, { start: 3.1, dur: 0.75 }, { start: 1.77, dur: 0.33 }]; // 三段、第三段在前面（照给的顺序接）
  const each = [];
  for (const [i, p] of P.entries()) each.push(await extractFrames({ file: video, info, color, start: p.start, dur: p.dur, width: 160, fps: 10, dir: path.join(dir, `x${i}`) }));
  const j = await extractFrames({ file: video, info, color, ranges: P, width: 160, fps: 10, dir: path.join(dir, 'xj') });
  assert.equal(j.n, each.reduce((t, x) => t + x.n, 0), `帧数是各段之和：${each.map((x) => x.n).join(' + ')}`);
  assert.ok((await readFile(j.raw)).equals(Buffer.concat(await Promise.all(each.map((x) => readFile(x.raw))))), '逐字节一样');
  const out = path.join(dir, '三段.gif');
  const r = await encodeFromSource({ file: video, info, color, ranges: P, width: 160, fps: 10, palette: PALETTE, out, keepFrames: true });
  assert.ok(Buffer.concat(r.chunks).equals(await readFile(j.raw)), '直出那路留在内存的帧也一样');
  const delays = parseGif(await readFile(out)).frames.map((f) => f.delay);
  assert.equal(delays.length, j.n);
  assert.ok(delays.every((d) => d === 10), `每帧 10 厘秒：${delays.join(',')}`);
});

test('拼接：画质分的参照也按几段拼（按一整段比会明显低）', async () => {
  const out = path.join(dir, '拼2.gif');
  await encodeFromSource({ file: video, info, color, ranges: PARTS, width: 160, fps: 10, palette: PALETTE, out });
  const right = await score(out, { ref: video, info, color, ranges: PARTS, fps: 10, vmaf: false });
  const wrong = await score(out, { ref: video, info, color, start: 0.5, dur: 2, fps: 10, vmaf: false });
  assert.ok(right.ssim > 0.9, `按几段比 SSIM ${right.ssim}`);
  assert.ok(right.ssim - wrong.ssim > 0.02, `按一整段比应该明显低：${right.ssim} 对 ${wrong.ssim}`);
});

// 成品内容对不对：拿「按几段拼」和「按同起点同总长的一整段」两种参照比，拼对了前者明显高（11-06 实测极速 0.985 对 0.866、自定义 lessgif 0.933 对 0.826）
async function joinedRight(out, fps) {
  const right = await score(out, { ref: video, info, color, ranges: PARTS, fps, vmaf: false });
  const wrong = await score(out, { ref: video, info, color, start: 0.5, dur: 2, fps, vmaf: false });
  assert.ok(right.ssim - wrong.ssim > 0.05, `成品应该是两段拼的：按几段比 ${right.ssim}、按一整段比 ${wrong.ssim}`);
}

test('拼接：convertFile 极速压两段，出一张 2 秒 20 帧的 GIF，内容是两段拼的', async () => {
  const out = path.join(dir, '成品.gif');
  const r = await convertFile(video, out, { preset: 'upload', mode: 'fast', ranges: PARTS, fill: false, overwrite: true, ignoreByteLimit: true });
  assert.equal(r.ok, true, r.reason);
  const g = gifSummary(await readFile(r.output));
  assert.equal(g.frames, 20);
  assert.equal(g.durationSec, 2);
  await joinedRight(r.output, r.chosen.fps);
});

test('拼接：标准档每档都查画质，查的参照也是两段拼的（记下的 SSIM = 按几段算的）', async () => {
  const out = path.join(dir, '标准.gif');
  const r = await convertFile(video, out, { preset: 'upload', mode: 'standard', ranges: PARTS, fill: false, overwrite: true, ignoreByteLimit: true });
  assert.equal(r.ok, true, r.reason);
  const rec = r.tried.find((t) => t.pass && t.ssim);
  assert.ok(rec, `标准档应该查过画质：${JSON.stringify(r.tried)}`);
  const right = await score(r.output, { ref: video, info, color, ranges: PARTS, fps: rec.fps, vmaf: false });
  assert.ok(Math.abs(rec.ssim - right.ssim) < 0.0002, `记下的 ${rec.ssim}，按几段算 ${right.ssim}`);
  await joinedRight(r.output, rec.fps);
});

test('拼接：自定义指定编码器（手动流程）也按几段取帧', async () => {
  const out = path.join(dir, '自定义.gif');
  const r = await convertFile(video, out, { preset: 'upload', ranges: PARTS, fill: false, overwrite: true, ignoreByteLimit: true, manual: { encoder: 'lessgif', width: 160, fps: 10 } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.manual?.path, 'encoder');
  assert.equal(gifSummary(await readFile(r.output)).frames, 20);
  await joinedRight(r.output, 10);
});
