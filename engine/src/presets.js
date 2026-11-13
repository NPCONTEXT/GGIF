// 预设和默认规则。数字的来源见 GIF工具/方案.md 顶部「10-17 定下的事」和 技术评估报告.md。

export const PRESETS = {
  upload: {
    id: 'upload',
    name: '公众号 · 图片库上传',
    limit: 9_900_000, // 真实上限 10MiB = 10,485,760 字节（10-17 实测），留约 5.9%
    minFrames: 61, // ≤60 帧会被微信缩成 640 宽重压（电脑网页端实测）
    maxFrames: 300, // 301 帧服务器拒
    maxWidth: 1080, // 超过会被缩到约 1079 宽
    fileSuffix: '_压缩', // 结果文件名「原文件名_压缩.gif」（作者定）
    hint: '在公众号编辑器里用「图片 → 从图片库选择 → 上传文件」上传（不限时）；不要用「本地上传」（15 秒超时，大图常失败）。',
  },
  paste: {
    id: 'paste',
    name: '公众号 · 飞书粘贴',
    limit: 4_800_000, // 飞书粘贴 ≤5MB 12/12 一次成功，>5MB 6/20；从访达直接粘贴 GIF 硬上限 5,242,880 字节（公众号探测会话 10-17 实测）
    minFrames: 61,
    maxFrames: 300,
    maxWidth: 1080,
    fileSuffix: '_压缩_4.8M', // 和 9.9 档放在同一目录也分得清（作者定）
    hint: '适合从飞书文档复制粘贴到公众号；超过 5MB 粘贴容易显示「系统繁忙」。',
  },
};
export const DEFAULT_PRESET = 'upload'; // 作者定：「两档都放，默认上传 9.9MB」

// 档位：相邻一级叫一档。默认从 900 宽、每秒 10 帧起，宽度优先（盲选 11 组：差不多 7、选宽 4、选帧率高 0）。
export const WIDTHS = [900, 800, 700, 600];
export const FPS_STEPS = [15, 12, 10, 8];
export const DEFAULT_START = { width: 900, fps: 10 };

// 画质最低线（端到端，参照原片按显示宽 min(1080, 原宽) 比）。10-17 标定盲选（测评记录「标定画质最低线」）：
// VMAF 差 3 分以内的 10 次全「差不多」（SSIM 0.92 对 0.955 也看不出）；被比下去的 VMAF 都 ≤88.7。
// 作者没点过「两张都不能用」，没有绝对下限数据；VMAF 90 取在 88.7 和 91.4 之间，SSIM 0.90 只挡明显糊的。我定的，以后再标。
export const QUALITY_FLOOR = { ssim: 0.9, vmaf: 90 };

// lessgif 最高画质体积 ≈ 仿 Gifox 全片体积 × 0.94（19:03 回测 96 格：P95 1.05、最大 1.07）。
export const PROXY_RATIO = 0.94;
export const ESTIMATE_MARGIN = 1.1; // 判定「能装下」：估计 × 1.1 ≤ 上限

// 跳档和剪短建议用的「预估比」= 快速预估的 lessgif 最高画质体积 / 本档上限。10-17 两档对比 39 个档的数据（测评记录「选档提速」）：
// 预估比 ≤1.65 的全过线；≥2.54 的全没过（过线的最高是 2.51）。SKIP_RATIO 留了余量，FIT_RATIO 取「基本都过线」那段的上沿。
export const SKIP_RATIO = 2.8; // 预估比超过它，这档肯定过不了线，不编码直接跳过
export const FIT_RATIO = 1.6; // 剪短建议：把片段剪到预估比约等于它。偏保守：13 号粘贴档建议 900×10 剪到 3.6 秒，实测剪到 5.8 秒也过线（VMAF 93.0）

/**
 * 宽度候选：WIDTHS 里不超过 top 的（偶数），最小 200；原图本来就不到 200 宽（表情、贴纸这类小图）就只用原宽
 * （10-20 审查 E6：原来全被筛掉，GIF 报 ffmpeg 错、视频误报「每一档都装不下」）。
 */
export function widthSteps(top) {
  const even = (w) => Math.max(2, w - (w % 2));
  const ws = [...new Set(WIDTHS.map((w) => even(Math.min(w, top))))].filter((w) => w >= 200);
  return ws.length ? ws : [even(top)];
}

// 动图降帧（11.13，作者选 C）：每帧延时差不多的动图只用原帧率的 1/k（按序号每 k 帧取 1 帧，间隔均匀，见 frames.js）。
// 原帧率 ≤15 的先在各个宽度保住原帧率，都装不下再减半（再 1/3）；>15 的只用 ≤15 的 1/k，每个宽度先试帧率高的。
// 延时忽长忽短（有停顿、快慢混着）的照旧按时间取 [原帧率（最高 15）, 10, 8]：按序号取会把原图的快慢节奏抹平。
export const GIF_FPS_CAP = 15;
export const GIF_FPS_MIN = 4.5;
/** 每帧延时（厘秒）差不多：最长最短差 ≤2 厘秒，也没有 0、1（浏览器当 10 厘秒放） */
export function isSteadyGif(delays) {
  if (!delays?.length) return false;
  let lo = Infinity;
  let hi = 0;
  for (const d of delays) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return lo >= 2 && hi - lo <= 2;
}
/** 匀速动图的降帧档 [{ width, fps }]：F 是原帧率（帧数 ÷ 时长），widths 从宽到窄；一档都凑不出（原帧率太低）返回 [] */
export function steadyGifLadder(F, widths) {
  const divs = [];
  for (let k = 1; k <= 30 && divs.length < 3; k++) {
    const f = F / k;
    if (f > GIF_FPS_CAP + 0.5) continue;
    if (f < GIF_FPS_MIN) break;
    divs.push(Math.round(f * 100) / 100); // 两位小数：界面上写得下；按序号取帧容差 1%，不受影响
  }
  if (!divs.length) return [];
  if (F <= GIF_FPS_CAP + 0.5) return divs.flatMap((f) => widths.map((w) => ({ width: w, fps: f })));
  return widths.flatMap((w) => divs.map((f) => ({ width: w, fps: f })));
}

/** 默认试档顺序：宽度优先，先降帧率再降宽。 */
export function defaultLadder(srcWidth, maxWidth = 1080) {
  const top = Math.min(srcWidth, maxWidth);
  const widths = widthSteps(top);
  const out = [];
  for (const w of widths) for (const f of [10, 8]) out.push({ width: w, fps: f });
  return out;
}

/**
 * 每一档都因为帧数超了被跳过（片段太长）时的说法：直接说太长、要剪到几秒以内。不是这种情况返回 null。
 * 作者：只切一刀、后面那段很长，原来写「每一档都装不下」，看不出是太长。
 */
export function tooLongReason(tried, dur, maxFrames) {
  if (!tried.length || !tried.every((t) => /总帧数.*超过/.test(t.result || ''))) return null;
  const fps = Math.min(...tried.map((t) => t.fps).filter(Boolean));
  if (!Number.isFinite(fps) || !dur) return null;
  const maxDur = Math.floor((maxFrames / fps) * 10) / 10;
  return `太长了：${dur.toFixed(1)} 秒按每秒 ${fps} 帧也有约 ${Math.round(dur * fps)} 帧，公众号最多 ${maxFrames} 帧；剪到 ${maxDur} 秒以内，或者再切几刀`;
}
