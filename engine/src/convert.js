// 单个视频 → 公众号 GIF：读色彩标记 → 按档位从高往低试 → lessgif 在上限内找最高画质 → 画质过最低线就收 → 凑帧 → 合规检查。
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { checkInputLimits } from './limits.js';
import os from 'node:os';
import path from 'node:path';
import { probe, colorPlan } from './probe.js';
import { extractFrames, joinRanges, joinedDur } from './frames.js';
import { encodeLessgif, encodeGifskiLossy, QUALITY_RANGE } from './encoders/index.js';
import { searchQuality } from './search.js';
import { score } from './quality.js';
import { estimateLessgif, rememberRatio } from './estimate.js';
import { fillFrames, TINY_FRAME_BYTES } from './fill.js';
import { checkGif } from './check.js';
import { gifSummary } from './gif.js';
import { quickConvert } from './fast.js';
import { normalizeManual, manualConvert } from './manual.js';
import { PRESETS, DEFAULT_PRESET, defaultLadder, widthSteps, QUALITY_FLOOR, FPS_STEPS, SKIP_RATIO, FIT_RATIO, tooLongReason, steadyGifLadder } from './presets.js';
import { RM_RETRY } from './tools.js';

export function resolvePreset(p) {
  if (p && typeof p === 'object') return p;
  const preset = PRESETS[p || DEFAULT_PRESET];
  if (!preset) throw new Error(`没有这个预设：${p}（可选 ${Object.keys(PRESETS).join(' / ')}）`);
  return preset;
}

/**
 * 输出文件名的「原名」部分：已经带本工具后缀的（各档的「_压缩」「_压缩_4.8M」、重名加的「 (1)」、更早的「_公众号」）先去掉，
 * 再加这一档的后缀，免得从压过的结果再压时叠成「_压缩_压缩」（作者：压过的也可以反复压）。
 */
const OUR_SUFFIX = new RegExp(`(${[...new Set([...Object.values(PRESETS).map((p) => p.fileSuffix).filter(Boolean), '_公众号'])]
  .sort((a, b) => b.length - a.length)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')})( \\(\\d+\\))?$`);
export function outputBase(file) {
  return path.basename(file, path.extname(file)).replace(OUR_SUFFIX, '');
}

/** 输出路径已经有文件时加「 (1)」「 (2)」…，绝不覆盖。 */
export function safeOutputPath(p) {
  if (!existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; ; i++) {
    const q = `${base} (${i})${ext}`;
    if (!existsSync(q)) return q;
  }
}

/**
 * 试档顺序。prefer='smooth' 时帧率优先（先保 15 帧再降宽），默认宽度优先。
 * src（probe 的结果）：lockFps 是录屏选了帧率的录像（11.13）——没手动定帧率时锁在这个帧率、只降宽度；
 * gifRate.steady 是匀速动图——没手动定帧率时按 steadyGifLadder（只用原帧率的 1/k；定了宽度就只在那个宽度上试）。
 */
export function buildLadder(srcW, preset, { width, fps, prefer } = {}, src = {}) {
  if (!fps && src?.lockFps) fps = src.lockFps;
  const top = Math.min(srcW, preset.maxWidth);
  const even = (w) => w - (w % 2);
  let widths = widthSteps(top); // 不到 200 宽的小图只用原宽（10-20 审查 E6）
  if (width) widths = [even(Math.min(width, top))];
  let ladder;
  const steady = !fps && src?.gifRate?.steady ? steadyGifLadder(src.gifRate.fps, widths) : [];
  if (fps) ladder = widths.map((w) => ({ width: w, fps }));
  else if (steady.length) ladder = steady;
  else if (prefer === 'smooth') ladder = FPS_STEPS.flatMap((f) => widths.map((w) => ({ width: w, fps: f })));
  else if (width) ladder = [10, 8].map((f) => ({ width: widths[0], fps: f }));
  else ladder = defaultLadder(srcW, preset.maxWidth);
  return ladder;
}

/**
 * opts: { preset, start, dur, ranges:[{start,dur}…]（两段以上 = 按这个顺序拼成一张，11.14 多选导出；给了就不看 start、dur）,
 *         crop:{w,h,x,y}, width, fps, prefer:'clear'|'smooth', fine, fill=true,
 *         floor:{ssim,vmaf}|false, allowBelowFloor, color:'auto'|'none'|'p3', overwrite, keepWork, onProgress,
 *         manual: 手动参数（见 manual.js；有改过的项才走手动流程，全自动时和没给一样）,
 *         extraFilter: 接在色彩转换后面的取帧滤镜（manual.js 内部用，比如饱和度；给了就不走 GIF 直接压），
 *         ignoreByteLimit: 不查导入的体积上限（主界面打开来剪的、录屏的段；时长、长边照查）,
 *         ignoreDurationLimit: 视频不查时长上限（主界面打开来切段、剪的，只解码选中那段；作者「可以改进」；GIF 照查） }
 * 返回 { ok, output, chosen, fill, check, color, tried, reason, hint }（走手动流程时另有 manual）
 */
export async function convertFile(input, output, opts = {}) {
  const preset = resolvePreset(opts.preset);
  if (path.resolve(input) === path.resolve(output)) throw new Error('输出不能覆盖输入文件');
  const manual = normalizeManual(opts.manual); // 参数不对直接抛错；全是自动时为 null，下面照原流程走
  const progress = opts.onProgress || (() => {});
  const info = await probe(input);
  const lim = checkInputLimits(info, (await stat(input)).size, input, { ignoreBytes: Boolean(opts.ignoreByteLimit), ignoreSeconds: Boolean(opts.ignoreDurationLimit) }); // 超大素材在解码前拒绝（主界面剪的不查体积、视频不查时长）
  if (!lim.ok) throw new Error(lim.reason);
  const color0 = colorPlan(info, opts.color);
  const color = opts.extraFilter ? { ...color0, filter: `${color0.filter}${opts.extraFilter}` } : color0;
  const parts = joinRanges(opts.ranges); // 拼接：几段合起来当一段压（时长是几段之和）；不是拼接为 null
  const start = parts ? parts[0].start : opts.start || 0;
  const dur = parts ? joinedDur(parts) : opts.dur || (info.duration ? info.duration - start : null);
  if (!dur || dur <= 0) throw new Error('片长读不出来，或起点超出了片长');
  const srcW = opts.crop ? opts.crop.w : info.width;
  // 源本身帧率低（比如每秒 8 帧的 GIF）时，档位帧率不超过源帧率：往上采样只会多出重复帧
  const srcFps = info.fps ? Math.round(info.fps) : null;
  // 录屏锁了帧率的不按平均帧率压（只存有变化的帧，静止的地方多，平均帧率会偏低）
  const capFps = (t) => (!info.lockFps && srcFps && t.fps > srcFps ? { ...t, fps: srcFps } : t);
  const ladder = dedupeTiers(buildLadder(srcW, preset, opts, info).map(capFps));
  if (manual) {
    // 手动参数：宽度帧率用手动值排档（同样不放大、不超原片帧率），其余交给 manual.js
    const mLadder = dedupeTiers(buildLadder(srcW, preset, { width: manual.width ?? opts.width, fps: manual.fps ?? opts.fps, prefer: opts.prefer }, info).map(capFps));
    return manualConvert(input, output, opts, {
      manual, preset, info, color, start, dur, ranges: parts, srcW, srcFps, ladder: mLadder,
      outPath: opts.overwrite ? output : safeOutputPath(output), convertFile,
    });
  }
  // 三档：fast 极速（默认）/ standard 标准 走 fast.js 的快路子；best 极限 走下面 lessgif 多方案搜索
  const mode = opts.mode || 'fast';
  if (mode !== 'best') {
    let qLadder = ladder;
    if (info.kind === 'gif') {
      // GIF：宽度优先（作者定「宽度优先」，和 17:35 正式盲选一致）。
      // 不用缩宽时先 gifsicle 直接压（保留原帧和延时）；要缩宽的一律先用 ffmpeg 解码缩小：
      // 10-17 实测 gifsicle 自己缩放单线程（13 号 1080 宽编一次 11 秒），缩完重新抖色出颗粒和色块。
      // 每个宽度依次试：原帧率（最高 15）→ 10 → 8 帧，再降宽。
      const top = Math.min(srcW, preset.maxWidth);
      const even = (w) => w - (w % 2);
      const g = gifSummary(await readFile(input));
      const gifFps = g.durationSec ? Math.round((g.frames / g.durationSec) * 10) / 10 : srcFps || 10;
      const widths = opts.width ? [even(Math.min(opts.width, top))] : widthSteps(top); // 不到 200 宽的小图只用原宽（10-20 审查 E6）
      const fpsSteps = opts.fps ? [opts.fps] : [...new Set([Math.min(gifFps, 15), 10, 8].filter((f) => f <= gifFps + 0.5))];
      qLadder = [];
      // 裁了时长或画面就不能直接压（gifsicle 直接压保留全部原帧和原画面），一律解码
      const trimmed = parts || start > 0.005 || (opts.dur && info.duration && opts.dur < info.duration - 0.05) || opts.crop;
      if (!opts.width && !opts.fps && !opts.extraFilter && !trimmed && srcW <= preset.maxWidth && g.frames <= preset.maxFrames) qLadder.push({ width: srcW, fps: gifFps, direct: true });
      // 11.13（作者选 C）：匀速动图只用原帧率的 1/k（见 presets.js steadyGifLadder）；延时忽长忽短的照旧按上面的帧率按时间取
      const steady = !opts.fps && info.gifRate?.steady ? steadyGifLadder(info.gifRate.fps, widths) : [];
      if (steady.length) qLadder.push(...steady);
      else for (const w of widths) for (const f of fpsSteps) qLadder.push({ width: w, fps: f });
      qLadder = qLadder.filter((t, i) => i === 0 || !(t.width === qLadder[0].width && Math.abs(t.fps - qLadder[0].fps) < 0.05));
      if (!qLadder.length) qLadder = [{ width: widths[0], fps: Math.min(gifFps, 10) }];
    }
    const outPath = opts.overwrite ? output : safeOutputPath(output);
    return quickConvert(input, output, opts, { preset, ladder: qLadder, info, color, start, dur, ranges: parts, outPath });
  }
  const floor = opts.floor === false ? null : opts.floor || QUALITY_FLOOR;
  const fillOn = opts.fill !== false;
  const key = `${path.resolve(input)}|${start}|${dur}|${JSON.stringify(opts.crop || null)}|${color.convert}${parts ? `|${JSON.stringify(parts)}` : ''}`;
  const work = await mkdtemp(path.join(os.tmpdir(), 'gifkit-'));
  const tried = [];
  let chosen = null;
  let fallback = null;
  try {
    const signal = opts.signal;
    for (const tier of ladder) {
      if (signal?.aborted) throw new Error('已取消');
      const expect = Math.round(dur * tier.fps);
      if (expect > preset.maxFrames) {
        tried.push({ ...tier, result: `总帧数约 ${expect}，超过 ${preset.maxFrames}，跳过` });
        continue;
      }
      progress({ stage: '取帧', ...tier });
      const frames = await extractFrames({ file: input, info, color, start, dur, ranges: parts, width: tier.width, fps: tier.fps, crop: opts.crop, dir: work, signal });
      if (frames.n > preset.maxFrames) {
        tried.push({ ...tier, frames: frames.n, result: `总帧数 ${frames.n}，超过 ${preset.maxFrames}，跳过` });
        continue;
      }
      const limit = preset.limit - (fillOn ? TINY_FRAME_BYTES * Math.max(0, preset.minFrames - frames.n) : 0);
      const est = await estimateLessgif(frames, { limit, key });
      const ratio = est.estimate / limit;
      progress({ stage: '预估', ...tier, estimate: est.estimate, fits: est.fits });
      if (floor && ratio > SKIP_RATIO) {
        tried.push({ ...tier, frames: frames.n, estimate: est.estimate, limit, ratio: round2(ratio), skipped: true,
          result: `快速预估最高画质要 ${(est.estimate / 1e6).toFixed(1)}MB，是上限的 ${ratio.toFixed(1)} 倍，画质过不了线，没编码直接跳过` });
        continue;
      }

      const cands = [];
      progress({ stage: '编码 lessgif', ...tier });
      const [lo, hi] = QUALITY_RANGE.lessgif;
      const lg = await searchQuality((q, out) => encodeLessgif(frames, q, out, { signal }), {
        lo, hi, limit, tmp: path.join(work, 'lessgif_试.gif'), file: path.join(work, `lessgif_${tier.width}_${tier.fps}.gif`),
      });
      if (signal?.aborted) throw new Error('已取消');
      const q100 = lg.tries.find((t) => t.q === 100);
      if (q100) rememberRatio(key, est.proxyBytes, q100.bytes);
      if (lg.best) cands.push({ encoder: 'lessgif', q: lg.best.q, bytes: lg.best.bytes, file: lg.file, tries: lg.tries.length });

      if (opts.fine) {
        progress({ stage: '编码 gifski（精细模式）', ...tier });
        const [glo, ghi] = QUALITY_RANGE.gifskiLossy;
        const gs = await searchQuality((q, out) => encodeGifskiLossy(frames, q, out), {
          lo: glo, hi: ghi, limit, tmp: path.join(work, 'gifski_试.gif'), file: path.join(work, `gifski_${tier.width}_${tier.fps}.gif`),
        });
        if (gs.best) cands.push({ encoder: 'gifski+gifsicle', q: gs.best.q, bytes: gs.best.bytes, file: gs.file, tries: gs.tries.length });
      }
      if (!cands.length) {
        tried.push({ ...tier, frames: frames.n, estimate: est.estimate, result: '画质降到最低也装不下' });
        continue;
      }
      progress({ stage: '算画质分', ...tier });
      const scoreOpts = { ref: input, info, color, start, dur, ranges: parts, crop: opts.crop, fps: tier.fps };
      for (const c of cands) c.score = await score(c.file, { ...scoreOpts, vmaf: false }); // 先只算 SSIM（快）
      cands.sort((a, b) => b.score.ssim - a.score.ssim);
      const best = cands[0];
      const ssimOk = !floor || best.score.ssim >= floor.ssim;
      if (ssimOk) best.score = await score(best.file, { ...scoreOpts, vmaf: true }); // SSIM 过线了才算 VMAF（慢）
      const pass = !floor || (ssimOk && (best.score.vmaf ?? 0) >= floor.vmaf);
      const why = !ssimOk ? `SSIM ${round4(best.score.ssim)} 没过 ${floor.ssim}` : `VMAF ${round2(best.score.vmaf)} 没过 ${floor.vmaf}`;
      const rec = {
        ...tier, frames: frames.n, estimate: est.estimate, limit, ratio: round2(ratio), encoder: best.encoder, q: best.q, bytes: best.bytes,
        ssim: round4(best.score.ssim), vmaf: round2(best.score.vmaf), pass,
        result: pass ? '画质过线，采用' : `画质没过最低线（${why}），往下一档`,
        others: cands.slice(1).map((c) => ({ encoder: c.encoder, bytes: c.bytes, ssim: round4(c.score.ssim), vmaf: round2(c.score.vmaf) })),
      };
      tried.push(rec);
      if (pass) {
        chosen = { ...rec, file: best.file };
        break;
      }
      if (!fallback || best.score.ssim > fallback.ssim) fallback = { ...rec, file: best.file };
    }
    if (!chosen && fallback && opts.allowBelowFloor) chosen = { ...fallback, result: '没有档过线，按你的设置用了画质最高的那档' };
    if (!chosen) {
      const trims = trimSuggestions(tried, dur);
      return {
        ok: false, color, tried, preset: preset.id, trims,
        reason: tooLongReason(tried, dur, preset.maxFrames) || (fallback ? '每一档的画质都没过最低线' : '每一档都装不下')
          + (trims.length ? `；剪短可以保住宽度：${trims.map((t) => `${t.width}×${t.fps} 剪到约 ${t.dur} 秒`).join('，')}（按体积比例推算的保守值，实际可能更长也行；剪哪一段会影响结果）` : '；可以剪短片段或裁小画面'),
      };
    }
    let buf = await readFile(chosen.file);
    let fill = null;
    // 按编出来的实际帧数判断（编码器会合并相同的相邻帧，比输入帧数少）
    chosen.outFrames = gifSummary(buf).frames;
    if (fillOn && chosen.outFrames < preset.minFrames) {
      fill = fillFrames(buf, preset.minFrames);
      if (fill.ok) buf = fill.buffer;
      fill = { ok: fill.ok, before: fill.before, after: fill.after, added: fill.added, reason: fill.reason };
    }
    const outPath = opts.overwrite ? output : safeOutputPath(output);
    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await writeFile(outPath, buf);
    const check = await checkGif(outPath, preset);
    const { file, ...chosenInfo } = chosen;
    return { ok: check.ok, output: outPath, chosen: chosenInfo, fill, check, color, tried, preset: preset.id, hint: preset.hint };
  } finally {
    if (!opts.keepWork) await rm(work, { recursive: true, force: true, ...RM_RETRY });
  }
}

function dedupeTiers(ladder) {
  const seen = new Set();
  return ladder.filter((t) => {
    const k = `${t.width}x${t.fps}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 剪短建议：对预估过的档（宽度优先的前几档），按「体积和时长成正比」推算剪到多长，预估比能降到 FIT_RATIO。
 * 只给比现在短的，最多 3 个，按宽度、帧率从高到低。
 */
export function trimSuggestions(tried, dur) {
  const out = [];
  for (const t of tried) {
    if (!t.estimate || !t.limit) continue;
    const k = (FIT_RATIO * t.limit) / t.estimate;
    if (k >= 1) continue;
    const d = Math.floor(dur * k * 10) / 10;
    if (d < 1) continue;
    if (!out.some((o) => o.width === t.width)) out.push({ width: t.width, fps: t.fps, dur: d });
    if (out.length === 3) break;
  }
  return out;
}

export function round4(x) {
  return x === null || x === undefined ? null : Math.round(x * 10000) / 10000;
}
export function round2(x) {
  return x === null || x === undefined ? null : Math.round(x * 100) / 100;
}
