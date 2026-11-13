// 导入上限：超出就在解码之前拒绝（探测只要几十毫秒）。
// 作者定位：「这是微信公众号GIF压缩工具，不是GIF或视频编辑器」，超大素材「本身就是要预处理的素材，我这个小工具担当不起」；
// 数值要「根据现有素材和性能测试确定，不要直接采用拍脑袋的数值」。
// 10-18 凌晨统计（样本、个人号测试、Gifox 录像、桌面和下载，共 62 个 GIF、55 个视频，只读文件信息）：
//   GIF 最大 34.7MB、最长 10.5 秒；视频最大 199MB、最长 85.6 秒、解码量最大 10.65 十亿像素；探测都在 70 毫秒内。
//   实测取帧：1840×1036@60 的 26 秒录像按 900 宽每秒 10 帧取一遍 2.6 秒（约 11 亿像素 / 秒）。
// 体积上限作者定：「导入上限直接收敛为GIF 200MB、视频100MB，这个标准来自我多年处理数千张动图的实际经验，
// 预计足够覆盖绝大多数需求…不需要再围绕极端素材研究大型性能适配方案，超过限制直接提示预处理即可」。
// （按这个数，上面统计的 55 个视频里有 10 个 Gifox 原始录像超 100MB 会被拒；GIF 没有超 200MB 的。）
// 时长和长边是兜底（体积不大但解码很慢的，比如低码率长视频），保留第一版的值。
import path from 'node:path';

export const INPUT_LIMITS = {
  gif: { maxBytes: 200e6, maxSeconds: 120, maxSide: 4096 },
  video: { maxBytes: 100e6, maxSeconds: 300, maxSide: 4096 },
};

export const OVER_LIMIT_HINT = '素材超出 GGIF 的处理范围。建议先使用视频编辑软件截取需要的片段，再导入压缩。';

// 本工具自己录的片段放在这些文件夹里（界面启动时登记「下载/GGIF录屏」和改名前的「下载/GIF工具录屏」）：不受体积上限。
// 体积上限是给外来素材的（作者：超大素材「本身就是要预处理的素材」）；片段是工具自己按打标切的 1080p 录像，解码不重。
// 打标很长（约 45 秒以上）的片段会过 100MB，原来连主界面都打不开、没法剪短（10-19 晚录屏 3.1 时加）。时长、长边照查。
const OWN_DIRS = [];
export function allowOwnRecordings(dir) {
  const d = path.resolve(dir);
  if (!OWN_DIRS.includes(d)) OWN_DIRS.push(d);
}
const isOwnRecording = (file) => Boolean(file) && OWN_DIRS.some((d) => path.resolve(file).startsWith(d + path.sep));

/**
 * info：probe() 的结果；bytes：文件大小；file：文件路径（看是不是工具自己录的片段）。返回 { ok, reason }，reason 写明超了哪一项。
 * ignoreBytes：不查体积（主界面打开来剪、打标的视频：作者选「主界面打开不限体积」，100MB 只管整段直接压的；长边照查）。
 * ignoreSeconds：视频不查时长（主界面打开的，10-20 起；5 分钟原来是我加的兜底，只管整段直接压的）。
 */
export function checkInputLimits(info, bytes, file, { ignoreBytes = false, ignoreSeconds = false } = {}) {
  if (process.env.GIFKIT_NO_INPUT_LIMITS === '1') return { ok: true }; // 只给内部测评脚本用（测评素材里有超 100MB 的原片）
  const lim = INPUT_LIMITS[info.kind === 'gif' ? 'gif' : 'video'];
  const what = info.kind === 'gif' ? 'GIF' : '视频';
  const over = [];
  if (bytes > lim.maxBytes && !ignoreBytes && !isOwnRecording(file)) over.push(`${(bytes / 1e6).toFixed(0)}MB，超过 ${what} 上限 ${lim.maxBytes / 1e6}MB`);
  // ignoreSeconds：视频不查时长（主界面打开来切段、剪的：作者「可以改进」；切段、导出只解码选中那段，超过 300 帧的在解码前就跳过）；GIF 照查
  if ((info.duration || 0) > lim.maxSeconds && !(ignoreSeconds && info.kind !== 'gif')) over.push(`${Math.round(info.duration)} 秒，超过 ${what} 上限 ${lim.maxSeconds} 秒`);
  const side = Math.max(info.width || 0, info.height || 0);
  if (side > lim.maxSide) over.push(`${info.width}×${info.height}，长边超过 ${lim.maxSide}`);
  return over.length ? { ok: false, reason: `${OVER_LIMIT_HINT}（${over.join('；')}）` } : { ok: true };
}
