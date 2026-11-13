// 快速预估：仿 Gifox 全片编一遍（约 1 秒级），× 比率 ≈ lessgif 最高画质的体积。
// 19:03 回测（2b 96 格）：全局比率 0.94 时实际 / 预测 P95 1.05、最大 1.07；同一段素材用实测比率校正后 P95 1.03。
// 只回测了 lessgif 最高画质（q=100）的体积；q=100 装不下时，lessgif 会降画质贴着上限编。
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { encodeProxy, PROXY_PALETTE } from './encoders/index.js';
import { encodeFromSource } from './frames.js';
import { PROXY_RATIO, ESTIMATE_MARGIN } from './presets.js';

/** 每段素材的实测比率（编过一次 lessgif q100 之后记下来），键是调用方给的素材标识。 */
const ratioCache = new Map();

export function rememberRatio(key, proxyBytes, lessgifQ100Bytes) {
  if (key && proxyBytes > 0 && lessgifQ100Bytes > 0) ratioCache.set(key, lessgifQ100Bytes / proxyBytes);
}

/**
 * 返回 { proxyBytes, estimate, ratio, ratioSource, fits, ms }
 * fits：估计 × 1.1 ≤ limit（界面上的「能装下」）。
 */
export async function estimateLessgif(frames, { limit, key } = {}) {
  const out = path.join(frames.dir, `代理_${path.basename(frames.raw, '.rgba')}_${process.hrtime.bigint()}.gif`);
  const r = await encodeProxy(frames, out);
  await rm(out, { force: true });
  if (!r.ok) throw new Error(`快速预估失败：${r.err}`);
  return estimateFromProxy(r.bytes, { limit, key, ms: r.ms });
}

/** 代理体积 → 预估（estimateLessgif 和主界面预估共用同一套算法）。 */
export function estimateFromProxy(proxyBytes, { limit, key, ms } = {}) {
  const cached = key ? ratioCache.get(key) : undefined;
  const ratio = cached ?? PROXY_RATIO;
  const estimate = Math.round(proxyBytes * ratio);
  return {
    proxyBytes,
    estimate,
    ratio,
    ratioSource: cached ? '这段素材的实测比率' : '默认比率 0.94',
    fits: limit ? estimate * ESTIMATE_MARGIN <= limit : null,
    range: [Math.round(estimate * 0.9), Math.round(estimate * 1.07)],
    ms: Math.round(ms ?? 0),
  };
}

/**
 * 主界面预估用（10-31 负载优化）：一条 ffmpeg 从原片直出代理 GIF 到管道、只数字节，不落原始帧也不落代理 GIF
 * （原来每次写原始帧几百 MB + 代理几十 MB，原始帧还一直留在缓存里）。和「取帧 + encodeProxy」逐字节一样。
 * src: { file, info, color, start, dur, width, fps, crop }。返回 { bytes, n, w, h, ms }；n 读不出来是 null。
 */
export async function proxyFromSource(src, { signal } = {}) {
  const r = await encodeFromSource({ ...src, palette: PROXY_PALETTE, out: null, signal });
  return { bytes: r.bytes, n: r.n, w: r.w, h: r.h, ms: r.ms };
}
