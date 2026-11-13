// 录屏片段（rec-clips.js）和列表里「待压缩」的单元测试。拼片段那条用 样本.nosync/录屏分段/（10-19 晚实验录的测试画面），要 ffmpeg。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { segmentsFor, splitRanges, coveredUntil, rangeLabel, clock, assembleClip, MAX_SEC, REC_FPS, normRecFps, fitSecFor } from '../rec-clips.js';
import { Library } from '../library.js';
import { run, TOOLS } from '../../engine/src/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEG_DIR = path.resolve(here, '..', '..', '..', '样本.nosync', '录屏分段');
const NO_PRIVATE = process.env.GIFKIT_NO_PRIVATE_SAMPLES === '1' ? '云端没有私人素材，这条只在本机跑' : false; // 云端没有 样本.nosync（不推），拼录像两条只在本机跑
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'gifkit-rectest-')); dirs.push(d); return d; };

const segs = Array.from({ length: 20 }, (_, i) => ({ file: `seg_${i + 1}.m4s`, start: i * 0.5, dur: 0.5 })); // 10 秒、每块 0.5 秒

test('挑块：和区间有重叠的都要，边界正好挨着的不要', () => {
  assert.deepEqual(segmentsFor(segs, 1.0, 2.0).map((s) => s.start), [1.0, 1.5]);
  assert.deepEqual(segmentsFor(segs, 1.2, 2.1).map((s) => s.start), [1.0, 1.5, 2.0]);
  assert.equal(segmentsFor(segs, 20, 30).length, 0);
});

test('切分（作者：打标 = 切一刀，按两下出现三段）：N 刀 N+1 段，顺序乱了也行；离头尾或上一刀不到 0.5 秒的不算；没切就整段一份（11.12）', () => {
  assert.equal(MAX_SEC, 90);
  assert.deepEqual(splitRanges(18, [10]), [{ from: 0, to: 10 }, { from: 10, to: 18 }]);
  assert.deepEqual(splitRanges(18, [10, 4]), [{ from: 0, to: 4 }, { from: 4, to: 10 }, { from: 10, to: 18 }]);
  assert.deepEqual(splitRanges(18, [0.2, 10, 10.3, 17.8]), [{ from: 0, to: 10 }, { from: 10, to: 18 }]);
  assert.deepEqual(splitRanges(25, []), [{ from: 0, to: 25 }]);
  assert.deepEqual(splitRanges(77.3, [0.2, 77.1]), [{ from: 0, to: 77.3 }], '离头尾太近的刀不算，等于没切');
});

test('块齐到第几秒、段名', () => {
  assert.equal(coveredUntil(segs.slice(0, 3)), 1.5);
  assert.equal(coveredUntil([]), 0);
  assert.equal(clock(65), '1:05');
  assert.equal(rangeLabel('2026-10-19 19-30-05', 2, 12.4, 19.6), '录屏 19-30 · 第 2 段 0:12–0:20');
});

test('拼录像：实验录的分段挑一部分拼起来，换成从 0 秒开始的普通 MP4，不重新编码', { skip: NO_PRIVATE }, async () => {
  const man = JSON.parse(readFileSync(path.join(SEG_DIR, 'segments.json'), 'utf8')).segments;
  const use = segmentsFor(man, 1.6, 5.6);
  const out = path.join(tmp(), '片段01.mp4');
  await assembleClip({ dir: SEG_DIR, segs: use, out, run, ffmpeg: TOOLS.ffmpeg });
  const r = await run(TOOLS.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,start_time', '-show_entries', 'format=duration', '-of', 'json', out]);
  const j = JSON.parse(r.stdout);
  assert.equal(j.streams[0].codec_name, 'h264');
  assert.deepEqual([j.streams[0].width, j.streams[0].height], [1920, 1080]);
  assert.ok(Math.abs(Number(j.streams[0].start_time)) < 0.05, `开始时刻应该是 0，实际 ${j.streams[0].start_time}`);
  const dur = Number(j.format.duration);
  const want = use.at(-1).start + use.at(-1).dur - use[0].start;
  assert.ok(Math.abs(dur - want) < 0.1, `时长 ${dur}，块加起来 ${want}`);
});

test('拼录像（10-31 负载优化）：直接顺着读各块，和原来「先拼临时文件再转封装」逐帧一样；输出文件夹里只有这一份', { skip: NO_PRIVATE }, async () => {
  const man = JSON.parse(readFileSync(path.join(SEG_DIR, 'segments.json'), 'utf8')).segments;
  const use = segmentsFor(man, 0, 99);
  const d = tmp();
  const out = path.join(d, '录屏.mp4');
  await assembleClip({ dir: SEG_DIR, segs: use, out, run, ffmpeg: TOOLS.ffmpeg });
  // 原来的拼法：init + 各块接成一个文件，再 -c copy 转封装
  const cat = path.join(tmp(), 'cat.mp4');
  writeFileSync(cat, Buffer.concat([readFileSync(path.join(SEG_DIR, 'init.mp4')), ...use.map((s) => readFileSync(path.join(SEG_DIR, s.file)))]));
  const old = path.join(path.dirname(cat), 'old.mp4');
  assert.equal((await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-i', cat, '-c', 'copy', old])).code, 0);
  const md5s = async (f) => (await run(TOOLS.ffmpeg, ['-v', 'error', '-i', f, '-map', '0:v', '-f', 'framemd5', '-'])).stdout.split('\n').filter((l) => l && !l.startsWith('#'));
  const a = await md5s(out);
  const b = await md5s(old);
  assert.ok(a.length > 10, `帧数 ${a.length}`);
  assert.deepEqual(a, b, '逐帧（时间戳、大小、校验）一样');
  assert.deepEqual(readdirSync(d), ['录屏.mp4'], '不留「拼接中」之类的临时文件');
});

test('列表：录屏片段先「待压缩」、不排队；要了一档就开始压；存盘读盘后待压缩还在', async () => {
  const d = tmp();
  const clip = path.join(d, '片段01.mp4');
  writeFileSync(clip, 'x');
  const file = path.join(d, 'history.json');
  const runs = [];
  const mk = () => new Library({ runOne: async (g, v) => { runs.push(g.name); const f = path.join(d, `${v.id}.gif`); writeFileSync(f, 'GIF89a'); Object.assign(v, { file: f, bytes: 6 }); }, satisfies: () => false, presetIds: ['upload', 'paste'], file });
  const lib = mk();
  const g = lib.addPending(clip, { session: 's1', durationSec: 4.5, bytes: 1 });
  assert.equal(lib.list()[0].chips[0].state, 'pending');
  assert.equal(lib.list()[0].pending, 's1');
  assert.equal(lib.pendingOf('s1').length, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs.length, 0, '待压缩的不能自己开始压');
  await lib.save();
  const lib2 = mk();
  await lib2.load();
  assert.equal(lib2.pendingOf('s1').length, 1, '读盘后待压缩还在');
  lib.request(g.source, 'upload');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(runs, ['片段01.mp4']);
  assert.equal(lib.pendingOf('s1').length, 0);
  assert.equal(lib.list()[0].chips[0].state, 'done');
});

test('列表：从列表移除待压缩的片段，这一行去掉', () => {
  const lib = new Library({ runOne: async () => {}, satisfies: () => false, presetIds: ['upload'], file: null });
  const g = lib.addPending('/tmp/不存在的片段.mp4', { session: 's2' });
  lib.removeGroup(g.id);
  assert.equal(lib.list().length, 0);
});

test('列表：同一个录像挂好几段，各是一行、各压各的；整个文件那一行另算；存盘读盘后段和起止都在（录屏卷 3.5b）', async () => {
  const d = tmp();
  const rec = path.join(d, '录屏.mp4');
  writeFileSync(rec, 'x');
  const file = path.join(d, 'history.json');
  const runs = [];
  const mk = () => new Library({ runOne: async (g, v) => { runs.push(g.range ? `第${g.range.n}段` : g.name); const f = path.join(d, `${v.id}.gif`); writeFileSync(f, 'GIF89a'); Object.assign(v, { file: f, bytes: 6 }); }, satisfies: () => false, presetIds: ['upload', 'paste'], file });
  const lib = mk();
  const g2 = lib.addRange(rec, { n: 2, start: 10, end: 18 }, { label: '第 2 段', session: 's9' });
  const g1 = lib.addRange(rec, { n: 1, start: 0, end: 10 }, { label: '第 1 段', session: 's9' });
  assert.deepEqual(lib.list().map((g) => [g.name, g.chips[0].state, g.range?.n]), [['第 1 段', 'pending', 1], ['第 2 段', 'pending', 2]]);
  assert.equal(lib.groupFor(rec).range, undefined, '整个文件那一行不能拿到某一段');
  assert.equal(lib.groups.length, 3);
  lib.removeGroup(lib.groups.find((g) => !g.range).id);
  await lib.save();
  const lib2 = mk();
  await lib2.load();
  assert.deepEqual(lib2.pendingOf('s9').map((g) => [g.range.n, g.range.start, g.range.end]), [[1, 0, 10], [2, 10, 18]]);
  lib.requestGroup(g1, 'upload');
  lib.requestGroup(g2, 'upload');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(runs, ['第1段', '第2段']);
  assert.equal(lib.pendingOf('s9').length, 0);
});

test('11.13 录制帧率：只认 高保真 60 和 30 / 15 / 10 / 5，别的当高保真；一段最长 = 300 ÷ 帧率，高保真照旧 37.5 秒', () => {
  assert.deepEqual(REC_FPS, [60, 30, 15, 10, 5]);
  for (const v of [60, 30, 15, 10, 5, '10']) assert.equal(normRecFps(v), Number(v));
  for (const v of [undefined, null, 0, 8, 12, 24, 'abc', 120]) assert.equal(normRecFps(v), 60);
  assert.deepEqual([60, 30, 15, 10, 5, null].map((f) => fitSecFor(f, 300, 37.5)), [37.5, 10, 20, 30, 60, 37.5]);
});

test('11.13 拼录像：选了帧率的录像记一笔 ggif-fps=N（引擎读到就锁帧率），高保真不记', async () => {
  const calls = [];
  const fakeRun = async (_bin, args) => { calls.push(args); return { code: 0, stderr: '' }; };
  const one = [{ file: 'seg_1.m4s', start: 0, dur: 0.5 }];
  await assembleClip({ dir: '/假', segs: one, out: '/假/a.mp4', run: fakeRun, ffmpeg: 'ffmpeg', fps: 10 });
  await assembleClip({ dir: '/假', segs: one, out: '/假/b.mp4', run: fakeRun, ffmpeg: 'ffmpeg', fps: 60 });
  await assembleClip({ dir: '/假', segs: one, out: '/假/c.mp4', run: fakeRun, ffmpeg: 'ffmpeg' });
  const at = (args) => args.indexOf('-metadata');
  assert.equal(calls[0][at(calls[0]) + 1], 'comment=ggif-fps=10');
  assert.equal(calls[0].at(-1), '/假/a.mp4');
  assert.equal(at(calls[1]), -1);
  assert.equal(at(calls[2]), -1);
});
