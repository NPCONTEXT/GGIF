// 取帧：把输入（视频或 GIF）按目标宽度、帧率取成 RGBA 原始帧，供各编码器用同一份输入。
import { existsSync } from 'node:fs';
import { stat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ffmpeg } from './tools.js';

/** 偶数高度：给 yuv420p 用（画质评分）。 */
export function targetHeight(srcW, srcH, w) {
  return Math.round((srcH * w) / srcW / 2) * 2;
}

/** 输出 GIF 的高度：按比例四舍五入，不强制偶数（GIF 不需要；强制偶数会把 769 高拉成 770）。 */
export function outputHeight(srcW, srcH, w) {
  return w === srcW ? srcH : Math.max(1, Math.round((srcH * w) / srcW));
}

/** 裁剪参数 {w,h,x,y} → 滤镜片段（以逗号结尾）。 */
export function cropFilter(crop) {
  return crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
}

/** 原片这一端的取帧滤镜：视频按「n/f 时刻正在显示的那帧」取（和 Gifox 一致）；GIF 用默认取法（GIF 延时按 1/100 秒取整，改了反而错位）。 */
export function sourceFpsFilter(info, fps) {
  if (info.kind !== 'gif') return `fps=${fps}:round=up,`;
  // 11.13：匀速动图、目标正好是原帧率的 1/k 时按序号每 k 帧取 1 帧（按时间取在延时 8/9 厘秒混着时忽多忽少，11-01 试验）；
  // 时间戳按目标帧率重排，末尾再接 fps 把这一路的帧率标对（不标的话后面按帧率补帧会多出帧，试验时 340 帧压出 293 帧、56 秒）
  const g = info.gifRate;
  if (g?.steady && g.fps > 0) {
    const k = Math.round(g.fps / fps);
    if (k >= 1 && Math.abs(g.fps / k - fps) <= fps * 0.01) return `${k > 1 ? `select=not(mod(n\\,${k})),` : ''}setpts=N/(${fps}*TB),fps=${fps},`;
  }
  return `fps=${fps},`;
}

export function timeArgs(info, start, dur) {
  const a = [];
  if (start) a.push('-ss', String(start));
  if (dur) a.push('-t', String(dur));
  return a;
}

/**
 * 多选导出（11.14，11-06 作者：切成 1、2、3 段，只要 1 和 3 拼成一张）：ranges = [{ start, dur }, …]，两段以上才算拼接，
 * 照给的顺序接（主界面已按时间排好）。返回整理过的几段；不是拼接（没给、只有一段）返回 null，各处照以前一段的做法走。
 */
export function joinRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length < 2) return null;
  return ranges.map((r) => {
    const start = Number(r.start) || 0;
    const dur = Number(r.dur);
    if (!(start >= 0) || !(dur > 0)) throw new Error(`拼接的段起止不对：起 ${r.start}、长 ${r.dur}`);
    return { start, dur };
  });
}

/** 拼接的几段合起来多长（秒）。 */
export const joinedDur = (parts) => Math.round(parts.reduce((t, p) => t + p.dur, 0) * 1000) / 1000;

/** 原片那一端的输入参数：一段是「-ss 起 -t 长 -i 原片」（和以前逐字一样）；拼接是每段各自定位、各算一个输入，解码时只读这几段。 */
export function sourceInputs(file, info, { start = 0, dur, ranges } = {}) {
  const parts = joinRanges(ranges);
  if (!parts) return [...timeArgs(info, start, dur), '-i', file];
  return parts.flatMap((p) => [...timeArgs(info, p.start, p.dur), '-i', file]);
}

/**
 * 原片那一路：取帧滤镜 chain 接在原片输入后面。一段是 [k:v]chain（k = 原片是第几个输入，和以前逐字一样）；
 * 拼接是每段先各自过一遍 chain（按自己的起点抽帧）、时间归零，再 concat 接起来——拼出来的帧 = 各段单独取的帧首尾接上，
 * 切点不在帧上时也一样（11-06 实测：先接再抽帧，接缝处会多一帧或少一帧）。同一条 ffmpeg 里做完，不先写中间视频（不多写盘、不多一道有损）。
 * 返回的这一段后面没有输出标签，调用方接着写 ,下一个滤镜 或 [标签]。
 */
export function sourceChain(ranges, k, chain) {
  const parts = joinRanges(ranges);
  if (!parts) return `[${k}:v]${chain}`;
  const each = parts.map((_, i) => `[${k + i}:v]${chain},setpts=PTS-STARTPTS[jn${i}]`).join(';');
  return `${each};${parts.map((_, i) => `[jn${i}]`).join('')}concat=n=${parts.length}:v=1:a=0`;
}

/** 取帧的滤镜和尺寸：{ vf, w, h }。extractFrames 和 encodeFromSource 共用，保证两边取到的帧一模一样。 */
export function frameChain({ info, color, width, fps, crop }) {
  const srcW = crop ? crop.w : info.width;
  const srcH = crop ? crop.h : info.height;
  const w = width;
  const h = outputHeight(srcW, srcH, w);
  return { w, h, vf: `${cropFilter(crop)}${sourceFpsFilter(info, fps)}${color?.filter || ''}scale=${w}:${h}:flags=lanczos,format=rgba` };
}

/**
 * 不落原始帧，一条 ffmpeg 从原片直接出 GIF：取帧滤镜（和 extractFrames 一样）后面接 split，palette 是 split 以后那段
 * （「palettegen…[p];[b][p]paletteuse…」）。10-31 负载优化：原来先把 RGBA 原始帧写成文件（每 10 秒一段约 172 MB）再读回来编，
 * 两种出来的 GIF 逐字节一样。out 给路径就写文件；不给就只往管道写、数字节（预估只要体积）。
 * keepFrames（要 out）：顺带把原始帧从管道收进内存（按块，不拼），快路子过了就丢、不写盘；要用 lessgif 时 writeRawFrames 写成文件，
 * 不用再解码一遍（作者选「先放内存」：难素材原来要多解码一遍、CPU 多 6–9%）。帧和 extractFrames 取的逐字节一样。
 * 返回 { file, bytes, n, w, h, ms, chunks }；n 是取到的帧数（留帧时按收到的字节算，不留时从 -stats 最后一行读），读不出来是 null（调用方退回老做法）。
 */
export async function encodeFromSource({ file, info, color, start = 0, dur, ranges, width, fps, crop, palette, out = null, keepFrames = false, signal }) {
  const { vf, w, h } = frameChain({ info, color, width, fps, crop });
  const keep = Boolean(keepFrames && out);
  const src = sourceChain(ranges, 0, vf); // 一段时就是 [0:v]${vf}，和以前逐字一样
  // setsar=0：原始帧文件不带像素宽高比，老做法写出的 GIF 头里这一字节是 0；原片标了 1:1 的（比如 ffmpeg 编的）缩放后会变成 1.0044:1，
  // 不清掉的话 GIF 头第 13 字节不一样（画面一样，10-31 单元测试查出来的）
  const graph = keep ? `${src},setsar=0,split=3[a][b][r];[a]${palette}[g]` : `${src},setsar=0,split[a][b];[a]${palette}`;
  // 原始帧那路要 -fps_mode passthrough：rawvideo 默认按恒定帧率补帧 / 丢帧，从录像中段开始取时（11-01 复测：游戏录像第 60 秒起）会在开头补一帧、
  // 后面整体错开一格，和 extractFrames 取的对不上；取帧滤镜里的 fps 已经是恒定帧率，原样传就和老做法一样
  const outs = keep ? ['-map', '[g]', '-loop', '0', out, '-map', '[r]', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'] : ['-loop', '0', ...(out ? [out] : ['-f', 'gif', '-'])];
  const r = await ffmpeg(['-v', 'error', '-stats', '-y', ...sourceInputs(file, info, { start, dur, ranges }), '-filter_complex', graph, ...outs],
    { signal, countStdout: !out, keepChunks: keep });
  let n;
  if (keep) n = Math.floor(r.stdoutBytes / (w * h * 4));
  else {
    const m = [...r.stderr.matchAll(/frame=\s*(\d+)/g)].at(-1);
    n = m ? Number(m[1]) : null;
  }
  const bytes = out ? (await stat(out)).size : r.stdoutBytes;
  return { file: out, bytes, n: n > 0 ? n : null, w, h, ms: r.ms, chunks: keep ? r.stdoutChunks : null };
}

/** 原始帧文件放哪、叫什么（extractFrames 和 writeRawFrames 共用，名字里带源文件、起止、裁剪、色彩，换了片段不会拿错）。 */
export function rawFramePath({ file, start = 0, dur, ranges, crop, color, w, h, fps, dir }) {
  // 缓存键要带上源文件、起止、裁剪、色彩：只按尺寸和帧率命名的话，同一目录里换了片段会拿到旧帧（10-17 实测踩到）；拼接的带上每段起止
  const parts = joinRanges(ranges);
  const where = parts ? [parts] : [start, dur];
  const key = createHash('md5').update(JSON.stringify([path.resolve(file), ...where, crop || null, color?.filter || ''])).digest('hex').slice(0, 10);
  return path.join(dir, `帧_${key}_${w}x${h}_${fps}.rgba`);
}

/**
 * 把 encodeFromSource 留在内存里的原始帧写成文件（lessgif 要按帧来回读），返回和 extractFrames 一样的 { raw, w, h, n, fps, dir }。
 * 按块写，不拼成一整块。
 */
export async function writeRawFrames(chunks, { file, start = 0, dur, ranges, crop, color, w, h, n, fps, dir }) {
  await mkdir(dir, { recursive: true });
  const raw = rawFramePath({ file, start, dur, ranges, crop, color, w, h, fps, dir });
  await writeFile(raw, chunks);
  return { raw, w, h, n, fps, dir };
}

/**
 * 取帧。返回 { raw, w, h, n, fps, dir }。同一组参数已经取过就直接用。
 * opts: { file, info, color, start, dur, width, fps, crop, dir }
 */
export async function extractFrames({ file, info, color, start = 0, dur, ranges, width, fps, crop, dir, signal }) {
  const { vf, w, h } = frameChain({ info, color, width, fps, crop });
  await mkdir(dir, { recursive: true });
  const raw = rawFramePath({ file, start, dur, ranges, crop, color, w, h, fps, dir });
  if (!existsSync(raw)) {
    // 先写临时名、成功再改名：中途取消或出错时不留半截文件被下次当缓存用
    const part = `${raw}.part`;
    try {
      // 一段：-vf（和以前逐字一样）；拼接：几个输入要用 -filter_complex，原样传帧（和 encodeFromSource 留帧那路一样，不让 rawvideo 按恒定帧率补帧）
      const filt = joinRanges(ranges) ? ['-filter_complex', sourceChain(ranges, 0, vf), '-fps_mode', 'passthrough'] : ['-vf', vf];
      await ffmpeg(['-v', 'error', '-y', ...sourceInputs(file, info, { start, dur, ranges }), ...filt, '-f', 'rawvideo', part], { signal });
      await rename(part, raw);
    } finally {
      await rm(part, { force: true });
    }
  }
  const n = Math.floor((await stat(raw)).size / (w * h * 4));
  if (n === 0) throw new Error('一帧都没取到：起止时间超出了片长？');
  return { raw, w, h, n, fps, dir };
}

/** gifski 要 PNG 帧：从原始帧转一份（转过就复用）。 */
export async function pngFrames(frames) {
  const pd = path.join(frames.dir, `png_${path.basename(frames.raw, '.rgba')}`);
  if (!existsSync(pd)) {
    await mkdir(pd, { recursive: true });
    await ffmpeg(['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${frames.w}x${frames.h}`,
      '-r', String(frames.fps), '-i', frames.raw, path.join(pd, 'f%05d.png')]);
  }
  const list = (await readdir(pd)).filter((x) => x.endsWith('.png')).sort().map((x) => path.join(pd, x));
  if (list.length !== frames.n) throw new Error(`PNG 帧 ${list.length} 张，原始帧 ${frames.n} 帧，对不上`);
  return list;
}
