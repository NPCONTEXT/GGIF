// 跨平台测试（Windows版卷 11-07）：不用私人素材，用 ffmpeg 现场生成假画面，查 Windows 上容易出事的地方：
// 找程序（.exe）、中文和空格路径、lessgif 子进程（Node 权限参数）、gifski / gifsicle 随包程序、
// VMAF 记录文件（以前写在滤镜参数里，Windows 盘符的冒号会被当分隔符）、批量展开文件夹、取消时杀进程和删临时目录。
// Mac 本机和云端 Windows 都跑（在快测试里，约十几秒）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, run, missingTools, RM_RETRY } from '../src/tools.js';
import { convertFile } from '../src/convert.js';
import { batch } from '../src/batch.js';
import { probe, colorPlan } from '../src/probe.js';
import { score } from '../src/quality.js';
import { gifSummary } from '../src/gif.js';
import { PRESETS } from '../src/presets.js';

let dir;
const src = {};

async function ff(args) {
  const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args]);
  assert.equal(r.code, 0, r.stderr.slice(-400));
}

/** 这一段里把系统临时目录换成 t（引擎的临时目录、VMAF 记录都建在 os.tmpdir() 下）；用完换回来。 */
async function withTmp(t, fn) {
  await mkdir(t, { recursive: true });
  const keep = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: t, TEMP: t, TMP: t });
  try {
    return await fn(t);
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

before(async () => {
  assert.deepEqual(missingTools(['ffmpeg', 'ffprobe', 'gifsicle', 'gifski', 'lessgifWasm']), [], '缺程序');
  dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-平台 测试-'));
  src.video = path.join(dir, '假 视频.mp4'); // 2 秒 640×360、每秒 30 帧
  src.gif = path.join(dir, '素材 文件夹', '假 动图.gif'); // 3 秒 480×270、每秒 10 帧、30 帧
  src.heavy = path.join(dir, '难 视频.mp4'); // 4 秒 1280×720、每秒 60 帧、满屏噪点：压得慢（M5 上不取消要压二十多秒），取消用；crf 36 约 12 MB，不超视频 100MB 导入上限
  await mkdir(path.dirname(src.gif), { recursive: true });
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', src.video]);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=10', '-t', '3', src.gif]);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60,noise=alls=40:allf=t', '-t', '4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '36', src.heavy]);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, ...RM_RETRY });
});

test('跨平台：视频 → GIF（默认档），中文和空格路径，凑到 61 帧、装进上限', async () => {
  const out = path.join(dir, '输出 一', '结果 1.gif');
  await mkdir(path.dirname(out), { recursive: true });
  const r = await convertFile(src.video, out, { preset: 'upload' });
  assert.equal(r.ok, true, JSON.stringify(r.check?.problems || r.reason));
  assert.equal(path.dirname(r.output), path.dirname(out));
  const s = gifSummary(await readFile(r.output));
  assert.ok(s.frames >= 61, `帧数 ${s.frames}`);
  assert.ok(s.bytes <= PRESETS.upload.limit, `${s.bytes} 字节`);
  assert.ok(Math.abs(s.durationSec - 2) < 0.1, `时长 ${s.durationSec}`);
});

for (const [encoder, name] of [['lessgif', 'lessgif'], ['gifski', 'gifski'], ['ffmpeg', 'ffmpeg']]) {
  test(`跨平台：手动参数 ${encoder}（lessgif 是 Node 子进程加权限参数，gifski、gifsicle 是随包程序）`, async () => {
    const out = path.join(dir, `手动 ${encoder}.gif`);
    const r = await convertFile(src.video, out, { manual: { encoder, quality: 60 } });
    assert.equal(r.ok, true, JSON.stringify(r.check?.problems || r.reason));
    assert.ok(existsSync(r.output), '没出文件');
    assert.ok(String(r.chosen.encoder).startsWith(name), `用的编码器 ${r.chosen.encoder}`);
  });
}

test('跨平台：画质分（SSIM + VMAF），临时目录在中文和空格路径下也写得出 VMAF 记录', async () => {
  const out = path.join(dir, '打分 用.gif');
  const r = await convertFile(src.video, out, { preset: 'upload' });
  assert.equal(r.ok, true, JSON.stringify(r.check?.problems || r.reason));
  const info = await probe(src.video);
  const sc = await withTmp(path.join(dir, '临时 目录·打分'), () => score(r.output, { ref: src.video, info, color: colorPlan(info), start: 0, dur: 2, fps: r.chosen.fps, vmaf: true }));
  assert.ok(sc.ssim > 0.5 && sc.ssim <= 1, `SSIM ${sc.ssim}`);
  assert.ok(typeof sc.vmaf === 'number' && sc.vmaf > 10, `VMAF ${sc.vmaf}`);
});

test('跨平台：批量展开中文文件夹，帧数不够的 GIF 凑帧，结果在输出文件夹', async () => {
  const outDir = path.join(dir, '批量 输出');
  const r = await batch([path.dirname(src.gif)], outDir, { preset: 'upload' });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].ok, true, r.items[0].detail);
  assert.equal(path.dirname(r.items[0].output), outDir);
  const s = gifSummary(await readFile(r.items[0].output));
  assert.ok(s.frames >= 61, `帧数 ${s.frames}`);
});

test('跨平台：导出到一半取消，几秒内停下、不留输出、临时目录清掉（Windows 上要杀得掉进程、删得掉目录）', async () => {
  const out = path.join(dir, '取消 的.gif');
  await withTmp(path.join(dir, '临时 目录·取消'), async (t) => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 1500);
    await assert.rejects(convertFile(src.heavy, out, { preset: 'upload', signal: ac.signal }), /已取消/);
    assert.ok(Date.now() - t0 < 6000, `取消后 ${Date.now() - t0} 毫秒才停`);
    assert.ok(!existsSync(out), '不该留输出');
    assert.deepEqual(await readdir(t), [], '临时目录没清掉');
  });
});
