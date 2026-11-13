// 手动参数（高级）：界面「更多设置 → 手动参数」里改了任一项，convertFile 才走这里；全部「自动」时不进来，原流程一字不变。
// TODO 2.33，作者原话：「手动调参数的参数数量也没想象中那么多，可以在拓展一下？比如码率、色彩等」。
//
// 两条路：
//  ① 包一层：编码器、画质、颜色数、抖动都是自动时，照常走现有流程（极速 / 标准 / 极限三档），
//     只是宽度帧率换成手动值、取帧加饱和度、先不凑帧；编完再做「额外有损 → 改速度 → 循环次数 → 凑帧 → 合规检查」。
//  ② 指定编码器：选了编码器，或改了画质 / 颜色数 / 抖动（编码器自动时用 lessgif，它三项都原生支持）。
//     按档取帧（加饱和度）→ 用指定编码器编码（画质固定编一次；画质自动在上限内找最高）→ 同样的后处理。
//
// 各参数怎么落到编码器上：
//   画质 0–100：lessgif 就是它的画质值；gifski 是 --quality（最低 1）；ffmpeg+gifsicle 换成 gifsicle 有损 = (100 - 画质) × 2。
//   颜色数 16–256：lessgif 原生（上限 255，设 256 按 255）；ffmpeg 是 palettegen 的 max_colors；gifski 没有这个选项，编完用 gifsicle --colors 减色。
//   抖动 0–1：lessgif 原生；ffmpeg 用 paletteuse 的 bayer 抖动近似（0 = 不抖，bayer_scale = round(5 × (1 - 抖动))，0.5 对应现在默认的 3）；gifski 不支持，忽略。
//   额外有损 0–200：编完再过一道 gifsicle -O1 --lossy（gamma 1），画质自动时算进体积搜索。
//   播放速度 0.5–2：改帧延时（GIF 延时单位 1/100 秒，按累计时刻取整，不让误差越积越多；最短 2/100 秒，再快就按 2 算）。
//   播放次数：0 = 无限（默认）；1 = 只放一遍（去掉循环扩展）；n ≥ 2 = 循环扩展写 n - 1（浏览器的读法是「放完一遍再重复 n - 1 次」）。
//   饱和度 0.5–1.5：取帧滤镜链加 eq=saturation（和色彩转换放在一起，画质分的参照也加同样的滤镜）。
//   宽度 100–1080、帧率 1–50：不放大、不超过原片帧率，仍受 300 帧限制。
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractFrames, pngFrames } from './frames.js';
import { TOOLS, run, RM_RETRY } from './tools.js';
import { parseGif, gifSummary } from './gif.js';
import { encodeLessgif, encodeGifski } from './encoders/index.js';
import { fitLossy, fitQuality, gifsicleLossy } from './fast.js';
import { fillFrames, TINY_FRAME_BYTES } from './fill.js';
import { checkGif } from './check.js';

/** 各参数的取值范围（界面的滑块 / 输入框也按这个）。 */
export const MANUAL_LIMITS = {
  quality: [0, 100],
  colors: [16, 256],
  dither: [0, 1],
  lossy: [0, 200],
  width: [100, 1080],
  fps: [1, 50],
  speed: [0.5, 2],
  loop: [0, 1000],
  saturation: [0.5, 1.5],
  hold: [0, 10], // 末帧多停几秒（作者：「偶尔我需要画面停留在末尾更久一点」）
};
export const MANUAL_ENCODERS = ['lessgif', 'gifski', 'ffmpeg'];
const ENCODER_NAME = { lessgif: 'lessgif', gifski: 'gifski', ffmpeg: 'ffmpeg+gifsicle' };
const FIELD_NAME = {
  encoder: '编码器', quality: '画质', colors: '颜色数', dither: '抖动强度', lossy: '额外有损', width: '宽度', fps: '帧率',
  speed: '播放速度', loop: '播放次数', saturation: '饱和度', hold: '末帧停留',
};
// 等于这个值就和「自动」一样，当作没改
const NOOP = { lossy: 0, speed: 1, loop: 0, saturation: 1, hold: 0 };
const INT = new Set(['quality', 'colors', 'lossy', 'width', 'loop']);

const MIN_DELAY = 2; // GIF 最短延时 2/100 秒；更短很多浏览器会当成 10
export const LOOP_EXT_BYTES = 19; // NETSCAPE2.0 循环扩展的字节数
const LG_K = 0.0275; // lessgif 画质值每降 1，ln(体积) 约降 0.0275（fast.js 里 10-17 两张难 GIF 量的）

const isAuto = (v) => v === undefined || v === null || v === '' || v === 'auto';

/**
 * 校验并整理手动参数。值是 undefined / null / '' / 'auto' 的算自动；等于默认的（额外有损 0、速度 1、播放次数 0、饱和度 1）也算自动。
 * 返回只含「改过」的项的对象；一项都没改返回 null。取值不对抛错（中文说明哪一项）。
 */
export function normalizeManual(m) {
  if (m === undefined || m === null) return null;
  if (typeof m !== 'object' || Array.isArray(m)) throw new Error('手动参数要是一个对象');
  const out = {};
  const bad = [];
  for (const k of Object.keys(m)) {
    if (!(k in FIELD_NAME)) bad.push(`不认识的参数「${k}」`);
  }
  if (!isAuto(m.encoder)) {
    if (MANUAL_ENCODERS.includes(m.encoder)) out.encoder = m.encoder;
    else bad.push(`编码器只能是 ${MANUAL_ENCODERS.join(' / ')}（现在是 ${m.encoder}）`);
  }
  for (const k of Object.keys(MANUAL_LIMITS)) {
    const v = m[k];
    if (isAuto(v)) continue;
    const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    const [lo, hi] = MANUAL_LIMITS[k];
    if (!Number.isFinite(x) || x < lo || x > hi) {
      bad.push(`${FIELD_NAME[k]}要在 ${lo}–${hi} 之间（现在是 ${v}）`);
      continue;
    }
    const r = INT.has(k) ? Math.round(x) : Math.round(x * 100) / 100;
    if (NOOP[k] !== undefined && r === NOOP[k]) continue;
    out[k] = r;
  }
  if (bad.length) throw new Error(`手动参数不对：${bad.join('；')}`);
  return Object.keys(out).length ? out : null;
}

/** 要不要走「指定编码器」那条路（②）。 */
export function needsEncoderPath(m) {
  return Boolean(m && (m.encoder || m.quality !== undefined || m.colors !== undefined || m.dither !== undefined));
}

/** 一句话写清改了哪些（结果卡片和批量详情用）。 */
export function describeManual(m) {
  if (!m) return '';
  const parts = [];
  if (m.encoder) parts.push(`编码器 ${ENCODER_NAME[m.encoder]}`);
  if (m.quality !== undefined) parts.push(`画质 ${m.quality}`);
  if (m.colors !== undefined) parts.push(`${m.colors} 色`);
  if (m.dither !== undefined) parts.push(`抖动 ${m.dither}`);
  if (m.lossy !== undefined) parts.push(`额外有损 ${m.lossy}`);
  if (m.width !== undefined) parts.push(`宽 ${m.width}`);
  if (m.fps !== undefined) parts.push(`每秒 ${m.fps} 帧`);
  if (m.speed !== undefined) parts.push(`${m.speed}× 速度`);
  if (m.loop !== undefined) parts.push(m.loop === 1 ? '只放一遍' : `播放 ${m.loop} 遍`);
  if (m.saturation !== undefined) parts.push(`饱和度 ${m.saturation}`);
  if (m.hold !== undefined) parts.push(`末帧多停 ${m.hold} 秒`);
  return parts.join('，');
}

/** 饱和度滤镜片段（以逗号结尾，接在色彩转换后面）。 */
export function saturationFilter(s) {
  return s === undefined || s === 1 ? '' : `eq=saturation=${s},`;
}

/**
 * 改播放速度：重写每帧延时。按累计时刻取整（第 i 帧结束时刻 = round(原累计 / 速度)），总时长误差不超过 1/100 秒；
 * 某帧算出来不到 2/100 秒就按 2 算（后面的帧会自动少一点补回来）。延时是 0 的帧、没有图形控制扩展的帧不动。
 * 返回 { buffer, clamped（被抬到 2 的帧数）, beforeCs, afterCs }。不改输入的 Buffer。
 */
/** 末帧多停 sec 秒：最后一帧的延时加上去（GIF 延时单位 1/100 秒，上限 655.35 秒）。 */
export function holdLastFrame(d, sec) {
  const g = parseGif(d);
  if (g.error || g.truncated) throw new Error(`末帧停留失败：${g.error || '文件不完整'}`);
  const last = [...g.frames].reverse().find((f) => f.gceIndex >= 0);
  if (!last) return d;
  const out = Buffer.from(d);
  out.writeUInt16LE(Math.min(0xffff, last.delay + Math.round(sec * 100)), g.blocks[last.gceIndex].start + 4);
  return out;
}

export function retimeGif(d, speed) {
  const g = parseGif(d);
  if (g.error || g.truncated) throw new Error(`改速度失败：${g.error || '文件不完整'}`);
  const out = Buffer.from(d);
  let orig = 0;
  let now = 0;
  let clamped = 0;
  for (const f of g.frames) {
    if (f.gceIndex < 0 || f.delay === 0) continue;
    orig += f.delay;
    let nd = Math.round(orig / speed) - now;
    if (nd < MIN_DELAY) {
      nd = MIN_DELAY;
      clamped += 1;
    }
    nd = Math.min(nd, 0xffff);
    out.writeUInt16LE(nd, g.blocks[f.gceIndex].start + 4);
    now += nd;
  }
  return { buffer: out, clamped, beforeCs: orig, afterCs: now };
}

const isLoopExt = (d, b) => b.kind === 'ext' && d[b.start + 1] === 0xff && d[b.start + 2] === 0x0b
  && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(d.toString('latin1', b.start + 3, b.start + 14));

/** 读循环设置，返回播放次数：0 = 无限，1 = 只放一遍（没有循环扩展），n = 放 n 遍。 */
export function readLoopCount(d) {
  const g = parseGif(d);
  const b = g.blocks.find((x) => isLoopExt(d, x));
  if (!b) return 1;
  // 子块：03 01 lo hi
  if (d[b.start + 14] !== 3 || d[b.start + 15] !== 1) return 1;
  const n = d.readUInt16LE(b.start + 16);
  return n === 0 ? 0 : n + 1;
}

/**
 * 设播放次数：plays 0 = 无限；1 = 只放一遍（去掉循环扩展）；n ≥ 2 = 循环扩展写 n - 1。
 * 原有的循环扩展都去掉，新的放在文件头（全局色表）后面。其余块原样不动。
 */
export function setLoopCount(d, plays) {
  const g = parseGif(d);
  if (g.error || g.truncated) throw new Error(`改循环次数失败：${g.error || '文件不完整'}`);
  if (!Number.isInteger(plays) || plays < 0 || plays > 0x10000) throw new Error(`播放次数不对：${plays}`);
  const parts = [d.subarray(0, g.headEnd)];
  if (plays !== 1) {
    const n = plays === 0 ? 0 : plays - 1;
    parts.push(Buffer.concat([Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([0x03, 0x01, n & 0xff, n >> 8, 0x00])]));
  }
  for (const b of g.blocks) if (!isLoopExt(d, b)) parts.push(d.subarray(b.start, b.end));
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/** ffmpeg 全局调色板编码，颜色数和抖动可调（不调时和快路子的基底一样：256 色 + bayer 3）。 */
export function paletteuseOpts(dither) {
  if (dither === undefined) return 'dither=bayer:bayer_scale=3';
  if (dither <= 0) return 'dither=none';
  return `dither=bayer:bayer_scale=${Math.max(0, Math.min(5, Math.round(5 * (1 - dither))))}`;
}

async function ffmpegPalette(frames, out, { colors = 256, dither, signal } = {}) {
  const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${frames.w}x${frames.h}`, '-r', String(frames.fps), '-i', frames.raw,
    '-filter_complex', `[0:v]split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=${paletteuseOpts(dither)}:diff_mode=rectangle`,
    '-loop', '0', out], { signal });
  if (r.aborted) throw new Error('已取消');
  if (r.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg 编码失败：${r.stderr.slice(-300)}`);
  return out;
}

/** 编完再过一道 gifsicle：额外有损，和（gifski 时）减色。不用过就原样返回。 */
async function postGifsicle(r, { lossy, colors }, signal) {
  if (!r.ok || (!lossy && !colors)) return r;
  const out = r.file.replace(/\.gif$/, '_后.gif');
  const args = ['-O1'];
  if (lossy) args.push(`--lossy=${lossy}`, '--gamma=1');
  if (colors) args.push('--colors', String(colors));
  const g = await run(TOOLS.gifsicle, [...args, r.file, '-o', out], { signal });
  if (g.aborted) return { ok: false, bytes: 0, file: out, err: '已取消' };
  const ok = g.code === 0 && existsSync(out);
  return { ok, bytes: ok ? (await readFile(out)).length : 0, file: out, err: ok ? '' : g.stderr.slice(-300) };
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fmtMB = (b) => `${(b / 1e6).toFixed(2)}MB`;

/**
 * 手动参数转换。convertFile 发现 opts.manual 有改过的项时调用。
 * ctx: { manual（normalizeManual 的结果）, preset, info, color, start, dur, ranges（拼接的几段，不是拼接为 null）, srcW, srcFps, ladder, outPath, convertFile }
 *   ladder 按手动宽度帧率排好（不放大、不超原片帧率）；convertFile 由调用方传进来（避免循环依赖）。
 * 返回结构和 convertFile 一样，另加 manual: { applied, path, summary, notes }。
 */
export async function manualConvert(input, output, opts, ctx) {
  const { manual: m, preset, info, color, srcW, srcFps } = ctx;
  const t0 = performance.now();
  const notes = [];
  const top = Math.min(srcW, preset.maxWidth);
  if (m.width !== undefined && m.width > top) notes.push(`宽度 ${m.width} 超过${srcW < preset.maxWidth ? `原片宽 ${srcW}（不放大）` : `上限 ${preset.maxWidth}`}，按 ${top - (top % 2)} 处理`);
  if (m.fps !== undefined && srcFps && m.fps > srcFps) notes.push(`帧率 ${m.fps} 超过原片的每秒 ${srcFps} 帧，按 ${srcFps} 处理`);
  if (m.encoder === 'gifski' && m.dither !== undefined) notes.push('gifski 没有抖动选项，抖动强度没生效');
  if (m.colors > 255 && (m.encoder || 'lessgif') === 'lessgif') notes.push('lessgif 最多 255 色，按 255 处理');
  if (m.colors !== undefined && m.encoder === 'gifski') notes.push(`gifski 没有颜色数选项，编完用 gifsicle 减到 ${m.colors} 色`);
  const work = await mkdtemp(path.join(os.tmpdir(), 'gifkit-m-'));
  try {
    const usePath = needsEncoderPath(m) ? 'encoder' : 'wrap';
    const r = usePath === 'encoder'
      ? await encoderPath(input, opts, { ...ctx, work, notes })
      : await wrapPath(input, opts, { ...ctx, work, notes });
    const summary = describeManual(m);
    const manualInfo = { applied: m, path: usePath, summary, notes };
    if (!r.buffer) {
      return { ok: false, color, tried: r.tried, preset: preset.id, mode: 'manual', manual: manualInfo, trims: r.trims, reason: r.reason, ms: Math.round(performance.now() - t0) };
    }
    const fin = await finish(r.buffer, { m, preset, outPath: ctx.outPath, opts, notes });
    const chosen = { ...r.chosen, bytes: fin.bytes, outFrames: fin.outFrames, speed: m.speed, plays: m.loop ?? 0 };
    return {
      ok: fin.check.ok, output: fin.output, chosen, fill: fin.fill, check: fin.check, color, tried: r.tried, preset: preset.id,
      mode: usePath === 'wrap' ? (r.mode || opts.mode || 'fast') : 'manual', manual: manualInfo, hint: preset.hint, ms: Math.round(performance.now() - t0),
    };
  } finally {
    if (!opts.keepWork) await rm(work, { recursive: true, force: true, ...RM_RETRY });
  }
}

/** 后处理：改速度 → 末帧停留 → 循环次数 → 凑帧 → 写文件 → 合规检查。 */
async function finish(buf, { m, preset, outPath, opts, notes }) {
  if (opts.signal?.aborted) throw new Error('已取消'); // 取消了就不写输出
  if (m.speed !== undefined) {
    const r = retimeGif(buf, m.speed);
    buf = r.buffer;
    if (r.clamped) {
      const real = r.afterCs ? Math.round((r.beforeCs / r.afterCs) * 100) / 100 : m.speed;
      notes.push(`${r.clamped} 帧按 ${m.speed}× 算不到 2/100 秒（GIF 最短延时），按 2/100 秒算，实际约 ${real}×`);
    }
  }
  if (m.hold !== undefined) buf = holdLastFrame(buf, m.hold);
  if (m.loop !== undefined) buf = setLoopCount(buf, m.loop);
  const bytes = buf.length;
  const outFrames = gifSummary(buf).frames;
  let fill = null;
  if (opts.fill !== false && outFrames < preset.minFrames) {
    const f = fillFrames(buf, preset.minFrames);
    if (f.ok) buf = f.buffer;
    fill = { ok: f.ok, before: f.before, after: f.after, added: f.added, reason: f.reason };
    if (!f.ok && m.speed > 1) notes.push(`加速后每帧时间太短，凑不够 ${preset.minFrames} 帧（公众号会缩成 640 宽重压）；可以调低速度或提高帧率`);
  }
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await writeFile(outPath, buf);
  const check = await checkGif(outPath, preset);
  return { output: outPath, bytes, outFrames, fill, check };
}

/**
 * ① 包一层：照常走现有流程（宽度帧率换成手动值、取帧加饱和度、不凑帧、上限预留凑帧和循环扩展的字节），
 * 再过额外有损。返回 { buffer, chosen, tried, mode } 或 { reason, tried }。
 */
async function wrapPath(input, opts, ctx) {
  const { manual: m, preset, info, work } = ctx;
  const reserve = (opts.fill !== false ? TINY_FRAME_BYTES * preset.minFrames : 0) + LOOP_EXT_BYTES;
  // GIF 只改了速度 / 播放次数 / 额外有损、本身又装得下：不重新编码，直接在原文件上改（重编一遍反而会变大、要加有损，10-18 实测 T2 要有损 12）
  if (info.kind === 'gif' && m.width === undefined && m.fps === undefined && m.saturation === undefined
    && !opts.width && !opts.fps && !opts.start && !opts.dur && !opts.ranges && !opts.crop) {
    const buf = await readFile(input);
    const g = gifSummary(buf);
    if (g.ok && !g.truncated && g.bytes <= preset.limit - reserve && g.width <= preset.maxWidth && g.frames <= preset.maxFrames) {
      let r = { ok: true, file: input, bytes: g.bytes };
      if (m.lossy) {
        opts.onProgress?.({ stage: '额外有损压缩' });
        const copy = path.join(work, '原GIF.gif');
        await writeFile(copy, buf);
        r = await postGifsicle({ ok: true, file: copy, bytes: g.bytes }, { lossy: m.lossy }, opts.signal);
        if (!r.ok) throw new Error(r.err || '额外有损压缩失败');
      }
      const fps = g.durationSec ? Math.round((g.frames / g.durationSec) * 10) / 10 : null;
      const chosen = { width: g.width, fps, frames: g.frames, encoder: '原 GIF（没重新编码）', bytes: r.bytes, pass: true, result: '已经装得下，直接改' };
      if (m.lossy) chosen.extraLossy = m.lossy;
      return { buffer: r.file === input ? buf : await readFile(r.file), chosen, tried: [chosen], mode: opts.mode || 'fast' };
    }
  }
  const tmp = path.join(work, '流程结果.gif');
  const inner = await ctx.convertFile(input, tmp, {
    ...opts,
    manual: null,
    width: m.width ?? opts.width,
    fps: m.fps ?? opts.fps,
    fill: false,
    overwrite: true,
    preset: { ...preset, limit: preset.limit - reserve },
    extraFilter: saturationFilter(m.saturation) || undefined,
  });
  if (!inner.output || !existsSync(inner.output)) return { reason: inner.reason || '没做成', tried: inner.tried || [], trims: inner.trims };
  let r = { ok: true, file: inner.output, bytes: (await readFile(inner.output)).length };
  if (m.lossy) {
    opts.onProgress?.({ stage: '额外有损压缩' });
    r = await postGifsicle(r, { lossy: m.lossy }, opts.signal);
    if (!r.ok) throw new Error(r.err || '额外有损压缩失败');
  }
  const chosen = { ...inner.chosen };
  if (m.lossy) chosen.extraLossy = m.lossy;
  return { buffer: await readFile(r.file), chosen, tried: inner.tried, mode: inner.mode };
}

/**
 * ② 指定编码器：按档取帧 → 编码（画质固定编一次；画质自动在上限内找最高）→ 额外有损 / 减色。
 * 画质固定时某档超上限就试下一档（宽度帧率是自动时）；都超就不出文件，说明最小那档多大。
 */
async function encoderPath(input, opts, ctx) {
  const { manual: m, preset, info, color, start, dur, ranges, ladder, work } = ctx;
  const enc = m.encoder || 'lessgif';
  const signal = opts.signal;
  const progress = opts.onProgress || (() => {});
  const fillOn = opts.fill !== false;
  const colorS = m.saturation !== undefined ? { ...color, filter: `${color.filter}${saturationFilter(m.saturation)}` } : color;
  const post = { lossy: m.lossy, colors: enc === 'gifski' ? m.colors : undefined };
  const tried = [];
  let smallest = null;
  let frameSkips = 0;
  for (const tier of ladder) {
    if (signal?.aborted) throw new Error('已取消');
    const expect = Math.round(dur * tier.fps);
    if (expect > preset.maxFrames) {
      frameSkips += 1;
      tried.push({ ...tier, result: `总帧数约 ${expect}，超过 ${preset.maxFrames}，跳过` });
      continue;
    }
    progress({ stage: '取帧', ...tier });
    const frames = await extractFrames({ file: input, info, color: colorS, start, dur, ranges, width: tier.width, fps: tier.fps, crop: opts.crop, dir: work, signal });
    if (frames.n > preset.maxFrames) {
      frameSkips += 1;
      tried.push({ ...tier, frames: frames.n, result: `总帧数 ${frames.n}，超过 ${preset.maxFrames}，跳过` });
      continue;
    }
    const limit = preset.limit - (fillOn ? TINY_FRAME_BYTES * Math.max(0, preset.minFrames - frames.n) : 0) - LOOP_EXT_BYTES;
    const tag = `${tier.width}_${tier.fps}`;
    if (enc === 'gifski') await pngFrames(frames);
    let base = null;
    // 编一次：knob 是 lessgif / gifski 的画质值，或 ffmpeg 路子的 gifsicle 有损值
    const encodeKnob = async (knob) => {
      const out = path.join(work, `${enc}_${tag}_${knob}.gif`);
      let r;
      if (enc === 'lessgif') r = await encodeLessgif(frames, knob, out, { dither: m.dither ?? 0.5, colors: m.colors, signal });
      else if (enc === 'gifski') r = await encodeGifski(frames, knob, out, { signal });
      else {
        if (!base) base = await ffmpegPalette(frames, path.join(work, `基底_${tag}.gif`), { colors: m.colors ?? 256, dither: m.dither, signal });
        r = await gifsicleLossy(base, knob, out, { signal });
      }
      if (signal?.aborted) return { ok: false, bytes: 0, file: out, err: '已取消' };
      return postGifsicle({ ...r, file: r.file || out }, post, signal);
    };
    const lossyOf = (q) => Math.round((100 - q) * 2);
    progress({ stage: `编码 ${ENCODER_NAME[enc]}`, ...tier });
    let pick = null; // { q, lossy?, bytes, file }
    let tries = 0;
    if (m.quality !== undefined) {
      const knob = enc === 'ffmpeg' ? lossyOf(m.quality) : m.quality;
      const r = await encodeKnob(knob);
      if (!r.ok) throw new Error(r.err || '编码失败');
      pick = { q: m.quality, bytes: r.bytes, file: r.file, ...(enc === 'ffmpeg' ? { lossy: knob } : {}) };
      tries = 1;
    } else if (enc === 'ffmpeg') {
      const fit = await fitLossy(encodeKnob, limit, { rounds: 5, near: 0.95, signal });
      tries = fit.tries.length;
      if (fit.best) pick = { q: Math.round(100 - fit.best.lossy / 2), lossy: fit.best.lossy, bytes: fit.best.bytes, file: fit.best.file };
    } else {
      const [lo, hi] = enc === 'gifski' ? [1, 100] : [0, 100];
      const r = await encodeKnob(hi);
      if (!r.ok) throw new Error(r.err || '编码失败');
      tries = 1;
      if (r.bytes <= limit) pick = { q: hi, bytes: r.bytes, file: r.file };
      else {
        const qPred = clamp(hi + Math.log((limit * 0.985) / r.bytes) / LG_K, lo, hi - 1);
        const lf = await fitQuality(encodeKnob, limit, { floor: lo, qPred, rounds: 3, near: 0.95, signal });
        tries += lf.tries.length;
        if (lf.best) pick = lf.best;
      }
    }
    if (signal?.aborted) throw new Error('已取消');
    const rec = { ...tier, frames: frames.n, encoder: ENCODER_NAME[enc], tries, limit };
    if (pick && pick.bytes <= limit) {
      Object.assign(rec, { q: pick.q, ...(pick.lossy !== undefined ? { lossy: pick.lossy } : {}), bytes: pick.bytes, pass: true, result: '采用' });
      if (m.lossy) rec.extraLossy = m.lossy;
      tried.push(rec);
      return { buffer: await readFile(pick.file), chosen: rec, tried };
    }
    if (pick) {
      Object.assign(rec, { q: pick.q, bytes: pick.bytes, pass: false, result: `画质 ${pick.q} 时 ${fmtMB(pick.bytes)}，超过上限` });
      if (!smallest || pick.bytes < smallest.bytes) smallest = rec;
    } else Object.assign(rec, { pass: false, result: '画质降到最低也装不下' });
    tried.push(rec);
  }
  let reason;
  if (frameSkips && frameSkips === tried.length) reason = `总帧数超过 ${preset.maxFrames}：剪短片段或调低帧率`;
  else if (smallest) reason = `画质固定为 ${m.quality} 时，最小的一档（${smallest.width} 宽、每秒 ${smallest.fps} 帧）也有 ${fmtMB(smallest.bytes)}，超过上限 ${fmtMB(preset.limit)}；调低画质、把画质改回自动，或剪短片段`;
  else reason = '每一档画质降到最低也装不下；可以剪短片段、调低宽度帧率，或把编码器改回自动';
  return { reason, tried };
}
