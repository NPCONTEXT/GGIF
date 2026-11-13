// 极速 / 标准两档：日常素材走快路子（10 秒内），难素材自动换 lessgif（15–30 秒）。
// 起因：10-17 作者试用，13MB 的 GIF 走 lessgif 多方案搜索要 7–8 分钟。作者说「速度也是非常重要到…至少得做到10秒内」
// 「之前你测最低限度的画质我也能忍受，所以可以看看怎么降低品质追求，减少步骤，提高速度」。
// 22:10 后作者又测两张历史疑难 GIF（动漫剧情 13.gif、鹰角演出），快路子只能缩到 700 宽、颗粒和色块明显；
// GPT 整理、作者转来的方向：「日常素材要快，困难素材要聪明，不必为极少数疑难案例牺牲正常工作流的效率」。
//
// 快路子：取帧 → ffmpeg 全局 256 色 + bayer 3 编一次当基底 → gifsicle -O1 有损（gamma 1）调到上限以内。
//   GIF 不用缩宽时 gifsicle -O1 直接有损压（不解码）；要缩宽的由 convert.js 排成解码档（gifsicle 自己缩放慢、还会出颗粒）。
//   有损值按下面的模型推算，每轮几个有损值并行编（gifsicle 单线程，本机 10 核）。
// 每一档：快路子装得下、有损不超过 cap、画质过线（有损 >20 或标准档才算 SSIM）就采用；
//   否则同一档改用 lessgif（画质值并行搜索，不低于底线）；还不行就按「各档体积比例」推算，跳到下一个可能装得下的档。
// 极速：快路子最多 4 轮、到上限 92% 交卷；lessgif 最多 2 轮。标准：快路子 5 轮、每次都算 SSIM、到 97%；lessgif 3 轮。
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractFrames, encodeFromSource, frameChain, writeRawFrames } from './frames.js';
import { TOOLS, run, RM_RETRY } from './tools.js';
import { score } from './quality.js';
import { gifSummary } from './gif.js';
import { encodeLessgif } from './encoders/index.js';
import { fillFrames, TINY_FRAME_BYTES } from './fill.js';
import { checkGif } from './check.js';
import { QUALITY_FLOOR, tooLongReason } from './presets.js';

// cap：10-17 量了 6 段代表素材 900×10 档的有损 → SSIM：有损 40 时 0.902–0.923（全过 0.90 线），60 时 0.877–0.907（一半过），100 时 0.840–0.882。
// 极速不算画质分，用「有损不超过 45」代替画质线；标准先用 70 筛掉明显过不了的，再算 SSIM。
export const MODES = {
  fast: { id: 'fast', name: '极速', rounds: 4, near: 0.92, cap: 45, checkFloor: false, lessgif: true, lgRounds: 2 },
  standard: { id: 'standard', name: '标准', rounds: 5, near: 0.97, cap: 70, checkFloor: true, lessgif: true, lgRounds: 3 },
};
// 快路子结果的有损超过它才算 SSIM（极速）：6 段日常素材有损 20 时 SSIM 0.933–0.945；
// 13 号动漫 GIF 900×10 有损 40 就装下、在 cap 以内，但 SSIM 只有 0.797、肉眼可见网格纹（10-17 22:42）
const CHECK_ABOVE = 20;

// lessgif（难素材用）。10-17 两张难 GIF 在 800–900 宽：画质 70 的体积约是快路子无损体积的 0.47–0.57 倍；
// 画质值每降 10，体积约 ×0.74–0.78（ln 体积对画质值的斜率 0.025–0.030）。
const LG_RATIO70 = 0.53;
const LG_K = 0.0275;
// 画质底线（暂定，只有两段素材）：帧率高于 10 的档（多保流畅）要 60，10 帧及以下 45。作者定「宽度优先」。
// 13 号 900×13.9 只能到画质 59（VMAF 89.2），900×10 能到 64（VMAF 93.1）；鹰角 900×12 是 51（92.4），900×10 是 55（95.5）。
const lgFloor = (t) => (t.fps > 10.5 ? 60 : 45);
const lgPredQ = (b0, limit) => 70 + Math.log((limit * 0.985) / (LG_RATIO70 * b0)) / LG_K;

// 有损推算模型：ln(无损体积 / 体积) ≈ s × ln((L + 4) / 4)。
// 10-17 量 6 段素材 900×10 档 lossy 0–200（每段 15 个点）：全局 s = 0.37 时按体积猜 L，中位误差 1.30 倍、最大 1.74 倍；
// 各段 s 在 0.32–0.40，所以试过一轮就用这段素材自己的 s。作者那张 GIF 直接压 s 只有约 0.14（有损几乎压不动）。
const C_L = 4;
export const S_DEFAULT = 0.37;
const uOf = (L) => Math.log((L + C_L) / C_L);
const lossyFor = (y, s) => (y <= 0 ? 0 : C_L * (Math.exp(y / s) - 1));

// 各档无损体积 ∝ 宽^1.9 × 帧率。10-17 实测 6 段素材（以 900×10 为 1）：900×8 0.78–0.81、800×10 0.80–0.81、
// 700×8 0.50–0.53、600×8 0.38–0.40，这个式子算出来 0.80、0.80、0.50、0.37。
export const tierWeight = (t) => Math.pow(t.width, 1.9) * t.fps;

/**
 * 调 gifsicle 有损，让体积进上限。encode(lossy) → { ok, bytes, file, err }，lossy 越大体积越小、画质越差。
 * 第 1 轮 lossy 0；第 2 轮按模型猜一个值、前后各加一个点，并行编（都封顶在 giveUp）；之后按实测点插值，每轮一个。
 * giveUp：推算要用的有损超过它就不再试（gaveUp 为真），留给上层降档。
 * slope：上一档校准过的 s（不给就用 S_DEFAULT）。
 * 返回 { best: {lossy, bytes, file} | null, tries: [[lossy, bytes]], slope, need, gaveUp }；best 是装得下里有损最小（画质最好）的，
 * slope 是按这段素材实测点校准过的 s，need 是推算要用的有损。
 */
export async function fitLossy(encode, limit, { rounds = 3, near = 0.92, signal, slope, giveUp = Infinity } = {}) {
  const pts = [];
  let best = null;
  const target = limit * 0.985;
  // 不是最后一档时，有损超过 giveUp 的结果反正不会采用，所以试的点都封顶在 giveUp
  const maxL = Number.isFinite(giveUp) ? clamp(Math.round(giveUp), 0, 200) : 200;
  const tryRound = async (Ls) => {
    const todo = [...new Set(Ls.map((L) => clamp(Math.round(L), 0, maxL)))].filter((L) => !pts.some((p) => p[0] === L));
    if (!todo.length) return false;
    if (signal?.aborted) throw new Error('已取消');
    const rs = await Promise.all(todo.map((L) => encode(L)));
    rs.forEach((r, i) => {
      if (!r.ok) throw new Error(signal?.aborted ? '已取消' : r.err || '编码失败');
      const L = todo[i];
      pts.push([L, r.bytes]);
      if (r.bytes <= limit && (!best || L < best.lossy)) best = { lossy: L, bytes: r.bytes, file: r.file };
    });
    return true;
  };
  const result = (extra = {}) => ({ best, tries: pts, slope: s, need: Math.round(need), gaveUp: false, ...extra });
  let s = slope ?? S_DEFAULT;
  await tryRound([0]);
  const b0 = pts[0][1];
  const yT = Math.log(b0 / target);
  let need = lossyFor(yT, s);
  if (best) return result();
  // 没校准过就推算远超上限，直接放弃这档（省掉编上限点的 1–2 秒）。
  // 1.4 倍的依据：6 段素材 s 最大 0.40，真要有损 45 时按 0.37 推算是 56（1.24 倍）；s 再大才会误放弃，代价只是降一档
  if (slope == null && need > giveUp * 1.4) return result({ gaveUp: true });
  // 猜的点超过上限就落在上限上：放不放弃这档看上限点的实测，不靠推算。
  // 10-17 实测：作者那张 GIF 直接压，有损 6–10 几乎压不动、34 就装下，只用小有损的点校准会推算成「要 399」而误放弃
  await tryRound([need / 1.35, need, need * 1.35]);
  for (let round = 2; ; round++) {
    // 用离目标最近的实测点校准 s
    const cal = pts.filter((p) => p[0] > 0 && p[1] < b0).sort((a, b) => Math.abs(Math.log(a[1] / target)) - Math.abs(Math.log(b[1] / target)))[0];
    if (cal) s = clamp(Math.log(b0 / cal[1]) / uOf(cal[0]), 0.05, 1);
    need = lossyFor(yT, s);
    if (best && best.bytes >= limit * near) break;
    // 有损开到上限（实测）还装不下才放弃这档；上限点还没编过的话，下面「只有装不下的点」那支会去编它
    const atMax = pts.find((p) => p[0] === maxL);
    if (!best && atMax && Number.isFinite(giveUp)) return result({ gaveUp: true });
    if (!best && atMax) break;
    if (round >= rounds) break;
    const fit = pts.filter((p) => p[1] <= limit).sort((x, y) => x[0] - y[0])[0]; // 装得下里有损最小的
    const over = pts.filter((p) => p[1] > limit && (!fit || p[0] < fit[0])).sort((x, y) => y[0] - x[0])[0]; // 比它小的里有损最大的
    let next;
    if (fit && over) {
      if (fit[0] - over[0] <= 1) break;
      // 在 ln((L+4)/4) 上对 ln(体积) 线性插值（曲线在这个坐标下接近直线）
      const uo = uOf(over[0]);
      const uf = uOf(fit[0]);
      const u = uo + ((uf - uo) * (Math.log(over[1]) - Math.log(target))) / (Math.log(over[1]) - Math.log(fit[1]));
      next = clamp(C_L * (Math.exp(u) - 1), over[0] + 1, fit[0] - 1);
      // 再往装得下那边偏一点并行编：插值点刚好差一点装不下时也有退路。
      // 10-17 实测：作者 GIF 粘贴档 750×10，插值落在 15，只超 5 万字节，轮数用完只能交有损 45（上限的 74%）
      const safe = next + Math.max(2, (fit[0] - next) * 0.25);
      if (safe < fit[0]) {
        if (!(await tryRound([next, safe]))) break;
        continue;
      }
    } else if (over) {
      next = Math.max(need, over[0] * 1.2 + 1);
    } else {
      next = Math.min(need, fit[0] - 1);
      if (fit[0] <= 0) break;
    }
    if (!(await tryRound([next]))) break;
  }
  if (!best && !pts.some((p) => p[0] === maxL)) {
    await tryRound([maxL]); // 轮数用完还没装下：编一次上限点（最后一档是 200）兜底，也让「放弃」有实测依据
    if (!best && Number.isFinite(giveUp)) return result({ gaveUp: true });
  }
  return result();
}

function clamp(x, a, b) {
  return Math.min(b, Math.max(a, x));
}

export async function gifsicleLossy(src, lossy, out, { width, srcWidth, signal } = {}) {
  const args = ['-O1', `--lossy=${lossy}`, '--gamma=1'];
  if (width && srcWidth && width < srcWidth) args.push('--resize-width', String(width), '--resize-method', 'lanczos3', '--resize-colors', '256');
  const r = await run(TOOLS.gifsicle, [...args, src, '-o', out], { signal });
  const ok = r.code === 0 && existsSync(out);
  return { ok, bytes: ok ? (await stat(out)).size : 0, file: out, err: ok ? '' : r.aborted ? '已取消' : r.stderr.slice(-300) };
}

// 快路子直出基底时，原始帧最多在内存里留这么多（10 秒一段 900 宽约 170–230 MB；再长的照老做法先写原始帧文件。作者选「先放内存」）
export const RAW_IN_MEMORY_MAX = 256 * 1024 * 1024;

// 快路子基底的调色板（split 以后那段）：从原始帧编（ffmpegBase）和从原片直出（encodeFromSource）共用，两边逐字节一样
export const BASE_PALETTE = 'palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle';

export async function ffmpegBase(frames, out, { signal } = {}) {
  const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${frames.w}x${frames.h}`, '-r', String(frames.fps), '-i', frames.raw,
    '-filter_complex', `[0:v]split[a][b];[a]${BASE_PALETTE}`,
    '-loop', '0', out], { signal });
  if (r.aborted) throw new Error('已取消');
  if (r.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg 编码失败：${r.stderr.slice(-300)}`);
  return out;
}

/**
 * lessgif 画质值搜索：q 越大体积越大、画质越好。encode(q) → { ok, bytes, file, err }。
 * 第 1 轮按推算值和前后各一点并行编（都不低于 floor）；之后按 ln(体积) 对 q 线性插值，每轮两个点（插值点、往装得下那边偏一点）。
 * 返回 { best: {q, bytes, file} | null, tries: [[q, bytes]] }；best 是装得下里 q 最大的。
 */
export async function fitQuality(encode, limit, { floor = 0, qPred, rounds = 2, near = 0.92, signal } = {}) {
  const pts = [];
  let best = null;
  const target = limit * 0.985;
  const tryRound = async (qs) => {
    const todo = [...new Set(qs.map((q) => clamp(Math.round(q), floor, 100)))].filter((q) => !pts.some((p) => p[0] === q));
    if (!todo.length) return false;
    if (signal?.aborted) throw new Error('已取消');
    const rs = await Promise.all(todo.map((q) => encode(q)));
    rs.forEach((r, i) => {
      if (!r.ok) throw new Error(signal?.aborted ? '已取消' : r.err || '编码失败');
      const q = todo[i];
      pts.push([q, r.bytes]);
      if (r.bytes <= limit && (!best || q > best.q)) best = { q, bytes: r.bytes, file: r.file };
    });
    return true;
  };
  const q0 = qPred ?? floor + 15;
  await tryRound([q0 - 6, q0, q0 + 6]);
  for (let round = 1; round < rounds; round++) {
    if (best && best.bytes >= limit * near) break;
    const fit = pts.filter((p) => p[1] <= limit).sort((a, b) => b[0] - a[0])[0]; // 装得下里 q 最大的
    const over = pts.filter((p) => p[1] > limit && (!fit || p[0] > fit[0])).sort((a, b) => a[0] - b[0])[0]; // 比它大的里 q 最小的
    let qs;
    if (fit && over) {
      if (over[0] - fit[0] <= 1) break;
      const q = fit[0] + ((over[0] - fit[0]) * (Math.log(target) - Math.log(fit[1]))) / (Math.log(over[1]) - Math.log(fit[1]));
      const qi = clamp(q, fit[0] + 1, over[0] - 1);
      qs = [qi, qi - Math.max(1, (qi - fit[0]) * 0.3)];
    } else if (over) {
      const lo = pts.reduce((a, b) => (b[0] < a[0] ? b : a));
      if (lo[0] <= floor) break; // 底线都装不下
      const q = lo[0] + Math.log(target / lo[1]) / LG_K;
      qs = [q, q - 5];
    } else {
      const hi = pts.reduce((a, b) => (b[0] > a[0] ? b : a));
      if (hi[0] >= 100) break;
      const q = hi[0] + Math.log(target / hi[1]) / LG_K;
      qs = [q, q - 3];
    }
    if (!(await tryRound(qs))) break;
  }
  return { best, tries: pts };
}

/**
 * 极速 / 标准转换。ladder、preset、safe 输出路径由 convert.js 传进来（避免循环依赖）。
 * ladder 里 direct 为真的档是 GIF 直接压（不解码）。
 * 返回结构和 convertFile 一样：{ ok, output, chosen, fill, check, color, tried, preset, mode, hint, reason, ms }
 */
export async function quickConvert(input, output, opts, { preset, ladder, info, color, start, dur, ranges, outPath }) {
  const mode = MODES[opts.mode] || MODES.fast;
  const progress = opts.onProgress || (() => {});
  const floor = opts.floor === false ? null : opts.floor || QUALITY_FLOOR;
  const fillOn = opts.fill !== false;
  const signal = opts.signal;
  const t0 = performance.now();
  const work = await mkdtemp(path.join(os.tmpdir(), 'gifkit-q-'));
  const tried = [];
  let chosen = null;
  try {
    const isGif = info.kind === 'gif';
    const gifSum = isGif ? gifSummary(await readFile(input)) : null;
    const total = ladder.length;
    const isDirect = (t) => isGif && t.direct && gifSum.frames <= preset.maxFrames;
    const framesOf = (t) => (isDirect(t) ? gifSum.frames : Math.round(dur * t.fps));
    const limitOf = (n) => preset.limit - (fillOn ? TINY_FRAME_BYTES * Math.max(0, preset.minFrames - n) : 0);
    const useLg = (t) => mode.lessgif && opts.lessgif !== false && !isDirect(t) && t.fps <= 15.5;
    let ref = null; // 快路子上一个实测过的档：{ tier, b0, slope }，推算后面各档要用多大的有损
    let decRef = null; // 上一个解码档的快路子无损体积：{ tier, b0 }，推算 lessgif 画质值
    let lgRef = null; // 上一次 lessgif 实测：{ tier, q, bytes }，有它就优先用它推算
    let fastBad = false; // 快路子在前面某档画质没过线（这类素材 bayer 底子不行），后面的解码档直接用 lessgif
    // GIF 直接压和解码重编是两条曲线（作者那张 GIF 直接压 s 约 0.14，解码后约 0.37），换了路子就不沿用校准过的 s
    const slopeFor = (t) => (ref && isDirect(t) === isDirect(ref.tier) ? ref.slope : undefined) ?? S_DEFAULT;
    const scaleB = (r, t) => (r.b0 * tierWeight(t)) / tierWeight(r.tier);
    const predFast = (t) => (ref ? lossyFor(Math.log(scaleB(ref, t) / (limitOf(framesOf(t)) * 0.985)), slopeFor(t)) : null);
    const predLg = (t) => {
      const lim = limitOf(framesOf(t));
      if (lgRef) return lgRef.q + Math.log((lim * 0.985) / ((lgRef.bytes * tierWeight(t)) / tierWeight(lgRef.tier))) / LG_K;
      return decRef ? lgPredQ(scaleB(decRef, t), lim) : undefined;
    };
    // 从第 from 档往后找第一个「快路子推算有损不超过 cap，或 lessgif 推算画质够底线」的档；都不行就最后一档。跳过的档记进 tried。
    const pick = (from) => {
      for (let j = from; j < ladder.length; j++) {
        const t = ladder[j];
        if (framesOf(t) > preset.maxFrames) {
          tried.push({ ...t, result: `总帧数约 ${framesOf(t)}，超过 ${preset.maxFrames}，跳过` });
          continue;
        }
        if (!ref || j === ladder.length - 1) return j;
        const nf = !fastBad || isDirect(t) ? predFast(t) : Infinity;
        const nq = useLg(t) ? predLg(t) : -Infinity;
        // 推算画质低于底线就跳过，不留余量：10-17 实测推算一直偏乐观（13 号粘贴档 800×8、700×10 推算 42–48、23 号 900×8 推算 ≥42，实测 45 都装不下）
        if (nf <= mode.cap || nq === undefined || nq >= lgFloor(t)) return j;
        const why = [nf < Infinity ? `快路子要有损约 ${Math.round(nf)}` : '', nq > -Infinity ? `lessgif 画质约 ${Math.round(nq)}` : ''].filter(Boolean).join('、');
        tried.push({ ...t, frames: framesOf(t), result: `推算${why}，跳过`, skipped: true });
      }
      return ladder.length;
    };
    const ssimOf = async (file, t, direct) => {
      // 直接压的 GIF 按原帧率算画质分；帧间隔全是 0 的 GIF 时长是 0，就用这一档的帧率（10-20 审查 E3：原来算出无穷大，算画质分时报错）。
      // 只有直接压 GIF 才有 gifSum，视频是 null，所以先看 direct（10-22 作者试用：E3 把这句挪到判断外面后，视频一检查画质就报「reading durationSec」）
      const directFps = direct && gifSum.durationSec > 0 ? Math.max(0.1, Math.round((gifSum.frames / gifSum.durationSec) * 100) / 100) : t.fps;
      const sc = await score(file, { ref: input, info, color, start, dur, ranges, crop: opts.crop, fps: direct ? directFps : t.fps, vmaf: false });
      return Math.round(sc.ssim * 10000) / 10000;
    };
    let ti = pick(0);
    while (ti < ladder.length) {
      const tier = ladder[ti];
      const last = ti === ladder.length - 1;
      if (signal?.aborted) throw new Error('已取消');
      const direct = isDirect(tier);
      const step = { step: ti + 1, steps: total, width: tier.width, fps: tier.fps };
      let frames = null; // 原始帧（RGBA 文件）：只有 lessgif 要用，用到时才写 / 取
      let nFrames = null; // 这一档取到几帧（基底直出或取原始帧时知道）
      let kept = null; // 基底直出时顺带留在内存里的原始帧 { chunks, w, h }：快路子过了就跟着这一档丢掉，要用 lessgif 才写成文件
      const getFrames = async () => {
        if (!frames) {
          const src = { file: input, start, dur, ranges, crop: opts.crop, color, fps: tier.fps, dir: work };
          if (kept) {
            frames = await writeRawFrames(kept.chunks, { ...src, w: kept.w, h: kept.h, n: nFrames });
            kept = null;
          } else {
            progress({ stage: '取帧', ...step });
            frames = await extractFrames({ ...src, info, width: tier.width, signal });
            nFrames = frames.n;
          }
        }
        return frames;
      };
      let base = null; // 快路子的输入（直接压是原 GIF，否则是 ffmpeg 基底）
      const getBase = async () => {
        if (!base) {
          if (direct) base = input;
          else {
            const out = path.join(work, `base_${tier.width}_${tier.fps}.gif`);
            const lgMaybe = useLg(tier); // 这一档可能还要 lessgif：原始帧得留着
            const { w, h } = frameChain({ info, color, width: tier.width, fps: tier.fps, crop: opts.crop });
            // 10-31 负载优化：一条 ffmpeg 从原片直出基底，不落原始帧（每 10 秒一段少写约 160 MB，结果逐字节一样）；可能还要 lessgif 的，原始帧顺带留内存，
            // 留不下（超过 RAW_IN_MEMORY_MAX）就照老做法先写原始帧文件——两种都只解码一次。读不出帧数也退回老做法
            if (!frames && (!lgMaybe || (framesOf(tier) + 2) * w * h * 4 <= RAW_IN_MEMORY_MAX)) {
              progress({ stage: '编码', ...step });
              const r = await encodeFromSource({ file: input, info, color, start, dur, ranges, width: tier.width, fps: tier.fps, crop: opts.crop, palette: BASE_PALETTE, out, keepFrames: lgMaybe, signal });
              if (r.n) {
                nFrames = r.n;
                if (lgMaybe) kept = { chunks: r.chunks, w: r.w, h: r.h };
                base = out;
                return base;
              }
            }
            await getFrames();
            progress({ stage: '编码', ...step });
            base = await ffmpegBase(frames, out, { signal });
          }
        }
        return base;
      };
      const fastFit = async (giveUp) => {
        const src = await getBase();
        const n = direct ? gifSum.frames : nFrames;
        progress({ stage: '压缩到上限以内', ...step });
        const fit = await fitLossy(
          (L) => gifsicleLossy(src, L, path.join(work, `q_${tier.width}_${tier.fps}_${L}.gif`), direct ? { width: tier.width, srcWidth: info.width, signal } : { signal }),
          limitOf(n), { rounds: mode.rounds, near: mode.near, signal, slope: ref && isDirect(ref.tier) === direct ? ref.slope : undefined, giveUp },
        );
        ref = { tier, b0: fit.tries[0][1], slope: fit.slope };
        if (!direct) decRef = { tier, b0: fit.tries[0][1] };
        return { fit, n };
      };
      const lgOk = useLg(tier);
      // ① 快路子。解码档跳过它的情况：已知这类素材快路子画质不行；或推算要的有损远超上限（不编基底，直接 lessgif）
      const fastHopeless = lgOk && !last && ref && predFast(tier) > mode.cap * 1.4;
      if (!((fastBad || fastHopeless) && lgOk)) {
        const cap = last && !lgOk ? Infinity : mode.cap;
        const { fit, n } = await fastFit(cap);
        const rec = { ...tier, frames: n, encoder: direct ? 'gifsicle' : 'ffmpeg+gifsicle', tries: fit.tries.length, lossless: fit.tries[0][1] };
        if (!fit.best || fit.best.lossy > cap) {
          const why = fit.best ? `要有损 ${fit.best.lossy} 才装得下，超过 ${cap}` : fit.gaveUp ? `推算要有损约 ${fit.need}，超过 ${cap}` : '有损开到最大也装不下';
          tried.push({ ...rec, pass: false, result: `快路子${why}` });
        } else {
          Object.assign(rec, { lossy: fit.best.lossy, q: 200 - fit.best.lossy, bytes: fit.best.bytes, pass: true, result: '采用' });
          let ok = true;
          if (floor && (mode.checkFloor || fit.best.lossy > CHECK_ABOVE)) {
            progress({ stage: '检查画质', ...step });
            rec.ssim = await ssimOf(fit.best.file, tier, direct);
            if (rec.ssim < floor.ssim) {
              if (last && !lgOk) {
                rec.belowFloor = true;
                rec.result = `采用（最后一档，SSIM ${rec.ssim} 没过 ${floor.ssim}）`;
              } else {
                ok = false;
                if (!direct) fastBad = true;
                tried.push({ ...rec, pass: false, result: `快路子 SSIM ${rec.ssim} 没过 ${floor.ssim}` });
              }
            }
          }
          if (ok) {
            tried.push(rec);
            chosen = { ...rec, file: fit.best.file };
            break;
          }
        }
      }
      // ② 同一档换 lessgif
      if (lgOk) {
        const fl = last ? 0 : lgFloor(tier);
        const qPred = predLg(tier);
        if (!last && qPred !== undefined && qPred < fl) {
          // 推算就不够底线：不取原始帧（10-31 负载优化：原来先取帧再跳过，帧白取）
          tried.push({ ...tier, frames: nFrames ?? framesOf(tier), pass: false, result: `lessgif 推算画质约 ${Math.round(qPred)}，低于底线 ${fl}`, skipped: true });
        } else {
          const f = await getFrames();
          const lim = limitOf(f.n);
          progress({ stage: '难素材：高画质编码', ...step });
          const lgEncode = async (q) => {
            const out = path.join(work, `lg_${tier.width}_${tier.fps}_${q}.gif`);
            return { ...(await encodeLessgif(f, q, out, { signal })), file: out }; // encodeLessgif 不回传路径
          };
          const lf = await fitQuality(lgEncode, lim, {
            floor: fl, qPred: qPred === undefined ? undefined : clamp(qPred, fl, 100), rounds: mode.lgRounds, near: mode.near, signal,
          });
          const near1 = lf.tries.filter((p) => p[1] <= lim).sort((a, b) => b[0] - a[0])[0] || lf.tries.sort((a, b) => a[1] - b[1])[0];
          if (near1) lgRef = { tier, q: near1[0], bytes: near1[1] };
          const rec = { ...tier, frames: f.n, encoder: 'lessgif', tries: lf.tries.length };
          if (lf.best) {
            Object.assign(rec, { q: lf.best.q, bytes: lf.best.bytes, pass: true, result: '采用' });
            tried.push(rec);
            chosen = { ...rec, file: lf.best.file };
            break;
          }
          tried.push({ ...rec, pass: false, result: `lessgif 画质 ${fl} 也装不下` });
        }
        // ③ 最后一档 lessgif 也不行：快路子不设上限兜底
        if (last) {
          const { fit, n } = await fastFit(Infinity);
          if (fit.best) {
            const rec = { ...tier, frames: n, encoder: 'ffmpeg+gifsicle', lossy: fit.best.lossy, q: 200 - fit.best.lossy, bytes: fit.best.bytes, tries: fit.tries.length, pass: true, belowFloor: true, result: '采用（最后一档兜底）' };
            tried.push(rec);
            chosen = { ...rec, file: fit.best.file };
            break;
          }
        }
      }
      ti = pick(ti + 1);
    }
    if (!chosen) {
      return { ok: false, color, tried, preset: preset.id, mode: mode.id, ms: Math.round(performance.now() - t0), reason: tooLongReason(tried, dur, preset.maxFrames) || '每一档都装不下；可以剪短片段或裁小画面' };
    }
    let buf = await readFile(chosen.file);
    let fill = null;
    chosen.outFrames = gifSummary(buf).frames;
    if (fillOn && chosen.outFrames < preset.minFrames) {
      const f = fillFrames(buf, preset.minFrames);
      if (f.ok) buf = f.buffer;
      fill = { ok: f.ok, before: f.before, after: f.after, added: f.added, reason: f.reason };
    }
    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await writeFile(outPath, buf);
    const check = await checkGif(outPath, preset);
    const { file, ...chosenInfo } = chosen;
    return { ok: check.ok, output: outPath, chosen: chosenInfo, fill, check, color, tried, preset: preset.id, mode: mode.id, hint: preset.hint, ms: Math.round(performance.now() - t0) };
  } finally {
    if (!opts.keepWork) await rm(work, { recursive: true, force: true, ...RM_RETRY });
  }
}
