// 各编码器。都接收同一份原始帧（frames.js 取的），输出一个 GIF 文件，返回 { ok, bytes, ms, err }。
// q 越大画质越高、体积越大；QUALITY_RANGE 写各自的取值范围。
import { existsSync } from 'node:fs';
import { stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, run, NODE_CHILD_ENV } from '../tools.js';
import { pngFrames } from '../frames.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lessgif-worker.mjs');

export const QUALITY_RANGE = { lessgif: [0, 100], gifskiLossy: [0, 200], gifsicleDirect: [0, 200] };

async function result(r, out) {
  const ok = r.code === 0 && existsSync(out) && (await stat(out)).size > 0;
  return { ok, bytes: ok ? (await stat(out)).size : 0, ms: r.ms, err: ok ? '' : r.stderr.trim().slice(-300) };
}

// 快速代理的调色板（split 以后那段）：从原始帧编（encodeProxy）和主界面预估从原片直出（estimate.js proxyFromSource）共用
export const PROXY_PALETTE = 'palettegen=max_colors=192:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=bayer:bayer_scale=3';

/** 快速代理（仿 Gifox）：ffmpeg 全局 192 色 + bayer 3。约 1 秒级，只用来估体积和当对照。 */
export async function encodeProxy(frames, out) {
  const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${frames.w}x${frames.h}`, '-r', String(frames.fps), '-i', frames.raw,
    '-filter_complex', `[0:v]split[a][b];[a]${PROXY_PALETTE}`,
    '-loop', '0', out]);
  return result(r, out);
}

/**
 * lessgif（主编码器）：抖动 0.5。子进程 + Node 权限限制。
 * colors：最多用几种颜色（手动参数用；不给就是 255，和原来一样）。lessgif 上限 255，实际用色可能比设定少几种。
 */
export async function encodeLessgif(frames, q, out, { dither = 0.5, colors, signal } = {}) {
  const r = await run(TOOLS.node, ['--permission',
    `--allow-fs-read=${TOOLS.lessgifWasm}`, `--allow-fs-read=${frames.raw}`, `--allow-fs-read=${WORKER}`,
    `--allow-fs-write=${path.dirname(out)}`,
    WORKER, TOOLS.lessgifWasm, frames.raw, String(frames.w), String(frames.h), String(frames.n), String(frames.fps),
    String(q), out, String(dither), ...(colors ? [String(Math.min(255, colors))] : [])], { env: NODE_CHILD_ENV, signal });
  return result(r, out);
}

/**
 * gifski 直接编（手动参数选 gifski 时用）：quality 1–100，越低越小。
 * 先在外面调一次 pngFrames(frames) 把 PNG 转好：几个画质并行编时，同时转 PNG 会互相覆盖。
 */
export async function encodeGifski(frames, q, out, { signal } = {}) {
  const pngs = await pngFrames(frames);
  const quality = Math.max(1, Math.min(100, Math.round(q)));
  const r = await run(TOOLS.gifski, ['--quiet', '--fps', String(frames.fps), '--width', String(frames.w),
    '--quality', String(quality), '-o', out, ...pngs], { signal });
  return result(r, out);
}

/** gifski 最高画质（G 的基底），转好的放在帧目录里复用。 */
async function gifskiBase(frames) {
  const base = path.join(frames.dir, `gifski100_${path.basename(frames.raw, '.rgba')}.gif`);
  if (existsSync(base)) return { ok: true, file: base };
  const pngs = await pngFrames(frames);
  const part = base.replace(/\.gif$/, '.part.gif');
  const r = await run(TOOLS.gifski, ['--quiet', '--fps', String(frames.fps), '--width', String(frames.w),
    '--quality', '100', '-o', part, ...pngs]);
  const res = await result(r, part);
  if (!res.ok) {
    await rm(part, { force: true });
    return { ok: false, err: res.err };
  }
  await rename(part, base);
  return { ok: true, file: base };
}

/** gifski q100 + gifsicle 有损（gamma 1）：精细模式里和 lessgif 比。q = 200 - lossy。 */
export async function encodeGifskiLossy(frames, q, out) {
  const b = await gifskiBase(frames);
  if (!b.ok) return { ok: false, bytes: 0, ms: 0, err: b.err };
  const r = await run(TOOLS.gifsicle, ['-O3', `--lossy=${200 - q}`, '--gamma=1', b.file, '-o', out]);
  return result(r, out);
}

/** gifsicle 直接压一个现成的 GIF（批量重压缩的候选之一），可选缩宽。q = 200 - lossy。 */
export async function gifsicleDirect(inputGif, q, out, { width, srcWidth } = {}) {
  const args = ['-O3', `--lossy=${200 - q}`, '--gamma=1'];
  if (width && srcWidth && width < srcWidth) {
    args.push('--resize-width', String(width), '--resize-method', 'lanczos3', '--resize-colors', '256');
  }
  const r = await run(TOOLS.gifsicle, [...args, inputGif, '-o', out]);
  return result(r, out);
}
