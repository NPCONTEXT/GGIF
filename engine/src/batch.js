// 批量：一次处理一堆 GIF / 视频。合规的不动（输出在别的目录时才复制一份）；只是帧数不够的只凑帧；超标的 GIF 重压缩；视频走 convertFile。
// 绝不覆盖原文件：输出目录和输入在同一个目录时加「_压缩」后缀（作者定统一叫「原文件名_压缩.gif」），重名再加「 (1)」。
import { copyFile, readFile, writeFile, mkdir, mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probe } from './probe.js';
import { gifSummary } from './gif.js';
import { extractFrames } from './frames.js';
import { encodeLessgif, gifsicleDirect, QUALITY_RANGE } from './encoders/index.js';
import { searchQuality } from './search.js';
import { score } from './quality.js';
import { fillFrames, TINY_FRAME_BYTES } from './fill.js';
import { checkGif } from './check.js';
import { convertFile, resolvePreset, safeOutputPath, round4, round2, outputBase } from './convert.js';
import { normalizeManual } from './manual.js';
import { checkInputLimits } from './limits.js';
import { RM_RETRY } from './tools.js';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

/** 展开输入：文件原样；目录只看一层里的 GIF 和视频。 */
export async function expandInputs(inputs) {
  const out = [];
  for (const p of inputs) {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const x of (await readdir(p)).sort()) {
        const ext = path.extname(x).toLowerCase();
        if (ext === '.gif' || VIDEO_EXT.has(ext)) out.push(path.join(p, x));
      }
    } else out.push(p);
  }
  return out;
}

function outputFor(file, outDir, preset, keepSuffix = false) {
  const same = path.resolve(path.dirname(file)) === path.resolve(outDir);
  // 放回原目录时加这一档的后缀；已经带本工具后缀的先去掉，不叠成「_压缩_压缩」。
  // keepSuffix：放进设置里指定的文件夹时也加（不然「两种都要」的 9.9 和 4.8 两版撞名，10-22 设置卷）
  const suffix = same || keepSuffix;
  const base = suffix ? outputBase(file) : path.basename(file, path.extname(file));
  return safeOutputPath(path.join(outDir, `${base}${suffix ? preset.fileSuffix || '_压缩' : ''}.gif`));
}

/**
 * 超标 GIF 重压缩：宽度候选只往下（原宽但不超过上限宽、900、700，去重、不放大），
 * 每档试「解码后 lessgif」和「gifsicle 直接压」，按以输入 GIF 为参照的画质分取高（10-17 重压缩测试：这样选和以原片为参照选 12 组里 11 组一样）。
 */
export async function recompressGif(input, output, opts = {}) {
  const preset = resolvePreset(opts.preset);
  const progress = opts.onProgress || (() => {});
  const buf = await readFile(input);
  const sum = gifSummary(buf);
  if (!sum.ok) throw new Error(`读不了这个 GIF：${sum.error}`);
  const info = await probe(input);
  // 帧间隔全是 0 的 GIF 读不出时长：按浏览器的放法（太短的间隔当 0.1 秒）当每秒 10 帧（10-20 审查 E3：原来帧率算成无穷大，取帧失败）
  const dur = sum.durationSec > 0 ? sum.durationSec : info.duration > 0 ? info.duration : sum.frames / 10;
  let fps = Math.max(0.1, Math.round((sum.frames / dur) * 100) / 100);
  if (Math.round(dur * fps) > preset.maxFrames) fps = Math.floor((preset.maxFrames / dur) * 100) / 100;
  const top = Math.min(sum.width, preset.maxWidth);
  const even = (w) => w - (w % 2);
  const widths = [...new Set([top, 900, 700].map((w) => even(Math.min(w, top))))];
  const fillOn = opts.fill !== false;
  const work = await mkdtemp(path.join(os.tmpdir(), 'gifkit-re-'));
  const cands = [];
  try {
    for (const w of widths) {
      progress({ stage: '取帧', width: w, fps });
      const frames = await extractFrames({ file: input, info, color: null, width: w, fps, dir: work });
      const limit = preset.limit - (fillOn ? TINY_FRAME_BYTES * Math.max(0, preset.minFrames - frames.n) : 0);
      const [lo, hi] = QUALITY_RANGE.lessgif;
      progress({ stage: '编码 lessgif', width: w });
      const lg = await searchQuality((q, out) => encodeLessgif(frames, q, out), {
        lo, hi, limit, tmp: path.join(work, 'lg_试.gif'), file: path.join(work, `lg_${w}.gif`),
      });
      if (lg.best) cands.push({ encoder: 'lessgif（解码后重编）', width: w, frames: frames.n, bytes: lg.best.bytes, file: lg.file });
      if (sum.frames <= preset.maxFrames) {
        const directLimit = preset.limit - (fillOn ? TINY_FRAME_BYTES * Math.max(0, preset.minFrames - sum.frames) : 0);
        const [glo, ghi] = QUALITY_RANGE.gifsicleDirect;
        progress({ stage: 'gifsicle 直接压', width: w });
        const gs = await searchQuality((q, out) => gifsicleDirect(input, q, out, { width: w, srcWidth: sum.width }), {
          lo: glo, hi: ghi, limit: directLimit, tmp: path.join(work, 'gs_试.gif'), file: path.join(work, `gs_${w}.gif`),
        });
        if (gs.best) cands.push({ encoder: 'gifsicle 直接压', width: w, frames: sum.frames, bytes: gs.best.bytes, file: gs.file });
      }
    }
    if (!cands.length) return { ok: false, reason: '每一档都压不进上限；可以剪短或裁小画面' };
    progress({ stage: '算画质分' });
    for (const c of cands) c.score = await score(c.file, { ref: input, info, fps, vmaf: true });
    cands.sort((a, b) => b.score.ssim - a.score.ssim);
    const best = cands[0];
    let out = await readFile(best.file);
    let fill = null;
    const n = gifSummary(out).frames;
    if (fillOn && n < preset.minFrames) {
      const f = fillFrames(out, preset.minFrames);
      if (f.ok) out = f.buffer;
      fill = { ok: f.ok, before: f.before, after: f.after, added: f.added, reason: f.reason };
    }
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, out);
    const check = await checkGif(output, preset);
    return {
      ok: check.ok, output, fill, check,
      chosen: { encoder: best.encoder, width: best.width, frames: best.frames, bytes: best.bytes, ssim: round4(best.score.ssim), vmaf: round2(best.score.vmaf) },
      others: cands.slice(1).map((c) => ({ encoder: c.encoder, width: c.width, bytes: c.bytes, ssim: round4(c.score.ssim), vmaf: round2(c.score.vmaf) })),
    };
  } finally {
    if (!opts.keepWork) await rm(work, { recursive: true, force: true, ...RM_RETRY });
  }
}

/** 批量。返回 { items:[{input, output, action, ok, detail}], counts, summary } */
export async function batch(inputs, outDir, opts = {}) {
  const preset = resolvePreset(opts.preset);
  // 手动参数（有改过的项时）：GIF 不再按「合规的不动、只凑帧」走捷径，一律按手动参数重做；极限档也走 convertFile（recompressGif 不认手动参数）
  const manualOn = Boolean(normalizeManual(opts.manual));
  const fillOn = opts.fill !== false; // 设置里关了凑帧（10-22 设置卷）：只差帧数的 GIF 不凑、当已合规
  const files = await expandInputs(inputs);
  await mkdir(outDir, { recursive: true });
  const items = [];
  for (const file of files) {
    const progress = (p) => opts.onProgress?.({ file, ...p });
    const ext = path.extname(file).toLowerCase();
    const output = outputFor(file, outDir, preset, Boolean(opts.keepSuffix));
    const sameDir = path.resolve(path.dirname(file)) === path.resolve(outDir);
    const item = { input: file, output, action: '', ok: false, detail: '' };
    try {
      // 超大素材在解码前拒绝（作者：「超过限制时明确拒绝，提示用户先用专业软件预处理」）
      if (ext === '.gif' || VIDEO_EXT.has(ext)) {
        const lim = checkInputLimits(await probe(file), (await stat(file)).size, file, { ignoreBytes: Boolean(opts.ignoreByteLimit), ignoreSeconds: Boolean(opts.ignoreDurationLimit) });
        if (!lim.ok) {
          Object.assign(item, { action: '跳过', ok: false, detail: lim.reason, output: null });
          items.push(item);
          opts.onItem?.(item);
          continue;
        }
      }
      if (ext === '.gif') {
        const chk = await checkGif(file, preset);
        if (!manualOn && chk.ok && (!chk.needsFill || !fillOn)) {
          // 已合规：输出在原目录时不复制，直接用原文件（作者定「合规的不复制」）；输出到别的目录才复制一份。
          // 关了凑帧时只差帧数的也算（读者会看到 640 宽的版本）
          const noFill = chk.needsFill ? `，不到 ${preset.minFrames} 帧没凑帧（设置里关了），读者会看到 640 宽的版本` : '';
          if (sameDir) Object.assign(item, { action: '已合规', ok: true, output: file, detail: `${chk.summary.frames} 帧，${chk.summary.width} 宽，已合规，直接用原文件${noFill}` });
          else {
            await copyFile(file, output);
            Object.assign(item, { action: '原样保留', ok: true, detail: `${chk.summary.frames} 帧，${chk.summary.width} 宽，已合规${noFill}` });
          }
        } else if (!manualOn && chk.ok && chk.needsFill) {
          const f = fillFrames(await readFile(file), preset.minFrames);
          if (f.ok) {
            await writeFile(output, f.buffer);
            Object.assign(item, { action: '凑帧', ok: true, detail: `${f.before} → ${f.after} 帧，多 ${f.buffer.length - (await stat(file)).size} 字节，画面不变` });
          } else if (sameDir) {
            Object.assign(item, { action: '已合规', ok: true, output: file, detail: `凑帧失败（${f.reason}），读者会看到 640 宽的版本` });
          } else {
            await copyFile(file, output);
            Object.assign(item, { action: '原样保留', ok: true, detail: `凑帧失败（${f.reason}），读者会看到 640 宽的版本` });
          }
        } else {
          const r = opts.mode === 'best' && !manualOn
            ? await recompressGif(file, output, { ...opts, preset, onProgress: progress })
            : await convertFile(file, output, { ...opts, preset, onProgress: progress, overwrite: true });
          Object.assign(item, {
            action: '压缩', ok: r.ok,
            detail: (r.ok ? `${r.chosen.encoder}，${r.chosen.width} 宽，${(r.chosen.bytes / 1e6).toFixed(2)}MB${r.chosen.ssim ? `，SSIM ${r.chosen.ssim}` : ''}` : r.reason || (r.check?.problems || []).join('；'))
              + (r.manual ? `；手动参数：${[r.manual.summary, ...r.manual.notes].join('；')}` : ''),
            result: r,
          });
          if (!r.ok && !r.output) item.output = null;
        }
      } else if (VIDEO_EXT.has(ext)) {
        const r = await convertFile(file, output, { ...opts, preset, onProgress: progress, overwrite: true });
        Object.assign(item, {
          action: '转换', ok: r.ok,
          detail: r.ok ? `${r.chosen.width}×${r.chosen.fps}，${(r.chosen.bytes / 1e6).toFixed(2)}MB` : r.reason,
          result: r,
        });
        if (!r.ok) item.output = null;
      } else {
        Object.assign(item, { action: '跳过', ok: false, detail: '不是 GIF 也不是视频', output: null });
      }
    } catch (e) {
      Object.assign(item, { action: '失败', ok: false, detail: String(e.message || e), output: null });
    }
    items.push(item);
    opts.onItem?.(item);
  }
  const counts = {};
  for (const it of items) {
    const k = it.ok ? it.action : '失败';
    counts[k] = (counts[k] || 0) + 1;
  }
  const summary = `共 ${items.length} 个：` + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('，');
  return { items, counts, summary, preset: preset.id, hint: preset.hint };
}
