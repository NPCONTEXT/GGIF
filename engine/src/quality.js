// 画质分：成品对参照，两边都按显示宽 min(1080, 参照宽) 用 bicubic 缩放后比 SSIM 和 VMAF。
// 参照是视频原片时，按同样的起止、裁剪、取帧规则、色彩转换取帧（参照也要转色，否则 SSIM 会把正确的转色算成失真）。
// 参照是 GIF（批量重压缩）时，参照就是输入 GIF 本身。
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run, TOOLS, RM_RETRY } from './tools.js';
import { cropFilter, sourceFpsFilter, sourceInputs, sourceChain, targetHeight } from './frames.js';

/**
 * opts: { ref: 参照文件, info: 参照的 probe 结果, color, start, dur, ranges（拼接的几段，见 frames.js joinRanges）, crop, fps, vmaf = true }
 * 返回 { ssim, vmaf, ms }；vmaf=false 时只算 SSIM（快很多）。
 */
export async function score(gif, { ref, info, color, start = 0, dur, ranges, crop, fps, vmaf = true }) {
  const srcW = crop ? crop.w : info.width;
  const srcH = crop ? crop.h : info.height;
  const rw = Math.min(1080, srcW) - (Math.min(1080, srcW) % 2);
  const rh = targetHeight(srcW, srcH, rw);
  const sc = `scale=${rw}:${rh}:flags=bicubic,format=yuv420p`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-score-'));
  // VMAF 的记录文件只写相对名、让 ffmpeg 在 dir 里跑：Windows 的绝对路径带盘符冒号，滤镜参数会把冒号当分隔符；
  // 用户名是中文时 libvmaf 也写不进（Windows版卷 11-07）。输入都换成绝对路径，不受工作目录影响。
  const vj = path.join(dir, 'vmaf.json');
  const refChain = `${cropFilter(crop)}${sourceFpsFilter(info, fps)}${color?.filter || ''}${sc}`;
  const ref1 = sourceChain(ranges, 1, refChain); // 参照从第 1 个输入起（第 0 个是成品）；一段时就是 [1:v]${refChain}
  const graph = vmaf
    ? `[0:v]fps=${fps},${sc},split=2[d1][d2];${ref1},split=2[r1][r2];[d1][r1]ssim[o1];[d2][r2]libvmaf=log_path=vmaf.json:log_fmt=json:n_threads=4[o2]`
    : `[0:v]fps=${fps},${sc}[d1];${ref1}[r1];[d1][r1]ssim[o1]`;
  const args = ['-hide_banner', '-nostdin', '-nostats', '-i', path.resolve(gif), ...sourceInputs(path.resolve(ref), info, { start, dur, ranges }),
    '-filter_complex', graph, '-map', '[o1]', ...(vmaf ? ['-map', '[o2]'] : []), '-f', 'null', '-'];
  try {
    const r = await run(TOOLS.ffmpeg, args, { cwd: dir });
    const m1 = r.stderr.match(/SSIM Y:[\d.]+ \([^)]*\) U:[\d.]+ \([^)]*\) V:[\d.]+ \([^)]*\) All:([\d.]+)/);
    if (!m1) throw new Error(`算画质分失败：${r.stderr.slice(-300)}`);
    const out = { ssim: Number(m1[1]), vmaf: null, ms: Math.round(r.ms), width: rw };
    if (vmaf) {
      const j = JSON.parse(await readFile(vj, 'utf8'));
      out.vmaf = j.pooled_metrics?.vmaf?.mean ?? null;
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true, ...RM_RETRY });
  }
}
