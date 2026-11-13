// 测试用的素材（都在 GIF工具/ 下，只读）。路径可以用环境变量 GIFKIT_SAMPLES 改成别的根目录。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GIF_ROOT = process.env.GIFKIT_SAMPLES || path.resolve(here, '..', '..', '..');
const T = path.join(GIF_ROOT, '个人号测试');

// 云端（GitHub 的 Windows 机器）没有这些私人素材（样本只在本机，不推，Windows版卷 11-07）：设了 GIFKIT_NO_PRIVATE_SAMPLES=1 时，
// 用到它们的测试标「跳过」并写原因；本机不设这个变量，素材缺了照旧报错。
export const NO_PRIVATE = process.env.GIFKIT_NO_PRIVATE_SAMPLES === '1' ? '云端没有私人素材，这条只在本机跑' : false;

export const SAMPLES = {
  t1_40f: path.join(T, 'T1_900宽_40帧_lessgif.gif'), // 900×506，40 帧，8.46MB
  t2_78f: path.join(T, 'T2_900宽_78帧_lessgif.gif'), // 900×506，78 帧，9.47MB
  w1440: path.join(T, '第2轮', 'W1440_61帧_凑准.gif'), // 1440 宽
  f301: path.join(T, '第2轮', 'F301帧_300宽_凑准.gif'), // 301 帧
  s10mib: path.join(T, '第2轮', 'S10485760字节_测10MiB边界.gif'), // 正好 10MiB，超 9.9MB
  n2: path.join(GIF_ROOT, '样本.nosync', '新录屏', '2026-10-17 03-11-17.mov'), // bt709，2400×1350@60
  // Display P3。原片 101MB 超了视频 100MB 导入上限（作者定），10-18 用 ffmpeg -c copy 截前 7 秒（不重编、色彩标记和时间戳不变）
  p3: path.join(GIF_ROOT, '样本.nosync', '小样', '03_P3_前7秒.mov'),
  ui13: path.join(GIF_ROOT, '样本.nosync', 'gifox原片', '2026-09-30 18.09.27', '2026-09-30 18.09.27.mov'), // 13 号 UI，Display P3，粘贴档整段 10.75 秒没有一档过线
  // 作者录的竖屏 732×1286@60、49 秒：极速压 9.9 档时第 3–5 段撞上 fd0b0aa 的「reading durationSec」（原件在 下载/GGIF录屏，只读，复制了一份）
  rec1022: path.join(GIF_ROOT, '样本.nosync', '录屏-1022', '2026-10-22 16-01-40 录屏.mp4'),
  hard13: path.join(GIF_ROOT, '样本.nosync', '难GIF', '13_动漫剧情_1245宽137帧.gif'), // 作者给的历史疑难 GIF，24.26MB，每秒 13.9 帧
};
