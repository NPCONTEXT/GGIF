// 录屏片段：录屏小助手把画面写成约 0.5 秒一块的分段 MP4（init.mp4 + seg_xxxxx.m4s，每块以关键帧开头），
// 停录后整段原样拼起来、换成一个普通 MP4（不重新编码，时间从 0 开始），每段只记起止（10-18 答复作者的机制：片段共用一份原素材）。
// 作者定：打标 = 切一刀（「按两下出现三段，按三下出现四段」），画面一点不丢；单次最长 90 秒。
// 11.12（作者：「还10秒一段的话就很尴尬，所以逻辑是去掉10秒一段的默认」）：没切就整段一份，不再每 10 秒自动切。
import path from 'node:path';

export const MAX_SEC = 90; // 单次录屏最长（作者：一口气能处理的 8–10 段 × 10 秒，「那就固定这个值」）
// 11.13 录制帧率（作者定）：高保真（录 60 帧，导出照旧自动选帧率）加 30 / 15 / 10 / 5 四档，只放能被 60 整除的；
// 选了数字就锁：按这个帧率录，录像里记一笔（mp4 注释 ggif-fps=N，引擎 probe 读成 lockFps），导出也是这个帧率、装不下只降宽度。
export const REC_FPS = [60, 30, 15, 10, 5];
export const HIFI_FPS = 60;
/** 设置里存的录制帧率：认不出来就当高保真 */
export function normRecFps(v) {
  const n = Number(v);
  return REC_FPS.includes(n) ? n : HIFI_FPS;
}
/** 一段最长多少秒还压得进一张 GIF（公众号最多 maxFrames 帧）：锁了帧率是 maxFrames ÷ 帧率；高保真照旧 hifiSec（最低每秒 8 帧，37.5 秒） */
export function fitSecFor(fps, maxFrames, hifiSec) {
  return fps && fps < HIFI_FPS ? maxFrames / fps : hifiSec;
}
export const MIN_CUT_GAP = 0.5; // 切点离开头、结尾、上一刀至少多少秒（录制中按 ⌥空格 也按它算，10-20 审查 B10：原来录制中按 0.3 秒算，段号对不上）

/** 和 [from, to) 有重叠的块，按开始时刻排好。块：{ file, start, dur }（秒，从开录算）。 */
export function segmentsFor(segs, from, to) {
  return segs
    .filter((s) => s.start + s.dur > from + 1e-6 && s.start < to - 1e-6)
    .sort((a, b) => a.start - b.start);
}

/**
 * 切点 → 段：按切点把 [0, total] 分开，N 刀 N+1 段；离开头、结尾或上一刀不到 minGap 秒的切点不算（手抖连按）；
 * 一刀都没有就整段一份（11.12 起不再每 10 秒自动切）。返回 [{ from, to }]。
 */
export function splitRanges(total, cuts, { minGap = MIN_CUT_GAP } = {}) {
  const pts = [...cuts].filter((c) => Number.isFinite(c)).sort((a, b) => a - b);
  const bounds = [0];
  for (const c of pts) if (c - bounds.at(-1) >= minGap && total - c >= minGap) bounds.push(c);
  bounds.push(total);
  return bounds.slice(0, -1).map((from, i) => ({ from, to: bounds[i + 1] }));
}

/** 录到第几秒的块都齐了（块是按顺序写出来的）。 */
export function coveredUntil(segs) {
  return segs.reduce((m, s) => Math.max(m, s.start + s.dur), 0);
}

/** 秒 → 「1:05」。 */
export function clock(s) {
  const x = Math.max(0, Math.round(s));
  return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
}

/** 菜单栏里一段的名字：「录屏 19-30 · 第 2 段 0:12–0:19」。 */
export function rangeLabel(sessionId, n, from, to) {
  return segLabel(recPrefix(sessionId), n, from, to);
}

/** 录屏那一组段的名字前半截：「录屏 19-30」。 */
export function recPrefix(sessionId) {
  const hm = (String(sessionId).match(/(\d{2})-(\d{2})-\d{2}$/) || []).slice(1, 3).join('-');
  return `录屏${hm ? ` ${hm}` : ''}`;
}

/** 一段的名字：前半截（录屏是「录屏 19-30」，主界面切的是文件名）+「第 N 段 起–止」（主界面打标，10-19 深夜）。 */
export function segLabel(prefix, n, from, to) {
  return `${prefix} · 第 ${n} 段 ${clock(from)}–${clock(to)}`;
}

/** 拼起来的那一行的名字（11.14 多选导出）：「录屏 15-25 · 第 1+3 段 拼起来 16.6 秒」。join：[{ start, end }]。 */
export function joinLabel(prefix, n, join) {
  const sec = join.reduce((t, p) => t + (p.end - p.start), 0);
  return `${prefix} · 第 ${n} 段 拼起来 ${Math.round(sec * 10) / 10} 秒`;
}

/**
 * 拼录像：init.mp4 + 这几块，用 ffmpeg 的 concat 协议顺着读、换成普通 MP4（-c copy，不重新编码；不换的话时间戳是开机时钟、从几十万秒开始）。
 * 10-31 负载优化：原来先把各块拼成一个临时大文件、转封装后再加 faststart 整份重写一遍，一次录像写 3 份；现在只写这一份
 * （和原来逐帧一样，只是索引在文件尾；faststart 只对网上边下边播有用，本机播放、拖动、压缩都不受影响）。
 * run / ffmpeg：引擎 tools.js 的 run 和 ffmpeg 路径。返回输出路径。块的路径里不能有「|」（临时目录和 seg_00001.m4s 这种名字都没有）。
 */
export async function assembleClip({ dir, segs, out, run, ffmpeg, fps = HIFI_FPS }) {
  if (!segs.length) throw new Error('这一段没有录到画面');
  const parts = [path.join(dir, 'init.mp4'), ...segs.map((s) => path.join(dir, s.file))];
  if (parts.some((p) => p.includes('|'))) throw new Error('录像分块的路径里有「|」，拼不了');
  const tag = fps < HIFI_FPS ? ['-metadata', `comment=ggif-fps=${fps}`] : []; // 11.13 选了帧率的录像记一笔，导出锁这个帧率
  const r = await run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', `concat:${parts.join('|')}`, '-c', 'copy', ...tag, out]);
  if (r.code !== 0) throw new Error(`拼片段失败：${r.stderr.slice(-200)}`);
  return out;
}
