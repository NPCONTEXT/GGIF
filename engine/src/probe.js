// 读输入文件的信息（尺寸、帧率、时长、色彩标记），决定要不要转色。
import { readFile } from 'node:fs/promises';
import { TOOLS, run } from './tools.js';
import { parseGif } from './gif.js';
import { isSteadyGif } from './presets.js';

function num(x) {
  if (x === undefined || x === null || x === 'N/A') return null;
  if (typeof x === 'string' && x.includes('/')) {
    const [a, b] = x.split('/').map(Number);
    return b ? a / b : null;
  }
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

/**
 * 画面旋转了多少度（0、90、180、270）。手机竖拍的视频常常存成横的、另带一个「显示时转 90°」的标记；
 * ffmpeg 解码时默认按标记转好（取帧、缩略图、画质分都是转好的画面），浏览器播放也转，所以宽高要按转好的算。
 * 10-19 晚查出：不对调的话竖屏视频按横的宽高缩放，被压扁成横图。
 */
function rotationOf(s) {
  const fromSide = (s.side_data_list || []).map((d) => num(d.rotation)).find((x) => x !== null);
  const deg = fromSide ?? num(s.tags?.rotate) ?? 0;
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

/** 返回 { kind:'gif'|'video', width, height, fps, duration, codec, primaries, transfer, matrix, range, rotation, lockFps, gifRate }；width / height 是转好以后的。
 * lockFps：录屏选了帧率（11.13）时录像里记的帧率（导出锁在这个帧率）；gifRate：GIF 的 { fps: 帧数 ÷ 时长, steady: 每帧延时差不多 }
 * （ffprobe 给 GIF 的平均帧率不准：12 帧的读成 12.5、13.9 帧的读成 14.29） */
export async function probe(file) {
  const r = await run(TOOLS.ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries',
    'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,color_primaries,color_transfer,color_space,color_range:stream_side_data=rotation:stream_tags=rotate:format=duration,format_name:format_tags=comment',
    '-of', 'json', file,
  ]);
  if (r.code !== 0) throw new Error(`读不了这个文件：${r.stderr.trim().slice(-200)}`);
  const j = JSON.parse(r.stdout);
  const s = (j.streams || [])[0];
  if (!s) throw new Error('文件里没有画面');
  const fps = num(s.avg_frame_rate) || num(s.r_frame_rate);
  const rotation = rotationOf(s);
  const turned = rotation === 90 || rotation === 270;
  const kind = s.codec_name === 'gif' ? 'gif' : 'video';
  const lock = /ggif-fps=(\d+)/.exec(j.format?.tags?.comment || '');
  const lockFps = lock && Number(lock[1]) > 0 && Number(lock[1]) < 60 ? Number(lock[1]) : null;
  let gifRate = null;
  if (kind === 'gif') {
    try {
      const delays = parseGif(await readFile(file)).frames.map((f) => f.delay);
      const cs = delays.reduce((a, b) => a + b, 0);
      gifRate = { fps: cs > 0 ? delays.length / (cs / 100) : null, steady: isSteadyGif(delays) };
    } catch {}
  }
  return {
    kind,
    codec: s.codec_name,
    width: turned ? s.height : s.width,
    height: turned ? s.width : s.height,
    rotation,
    fps,
    duration: num(j.format?.duration),
    primaries: s.color_primaries || null,
    transfer: s.color_transfer || null,
    matrix: s.color_space || null,
    range: s.color_range || null,
    lockFps: kind === 'video' ? lockFps : null,
    gifRate,
  };
}

// ffmpeg colorspace 滤镜认识的取值（ffmpeg 文档 colorspace 一节）
const OK_SPACE = new Set(['bt709', 'fcc', 'bt470bg', 'smpte170m', 'smpte240m', 'ycgco', 'bt2020nc']);
const OK_TRC = new Set(['bt709', 'bt470m', 'bt470bg', 'gamma22', 'gamma28', 'smpte170m', 'smpte240m', 'linear',
  'srgb', 'iec61966-2-1', 'xvycc', 'iec61966-2-4', 'bt2020-10', 'bt2020-12']);

/**
 * 色彩处理方案。
 * Display P3（smpte432）→ 转成 sRGB 再编码（Gifox 也这么做；不转颜色偏淡，盲选挑得出来）；
 * bt709 / sRGB → 不动；没标记或不认识 → 按 sRGB 处理并给出提示（界面上可以手动改）。
 * 返回 { convert, filter, note, warn }；filter 是要插进滤镜链的一段（以逗号结尾），不转时是空串。
 */
export function colorPlan(p, override) {
  if (override === 'none') return { convert: false, filter: '', note: '按你的设置不转色', warn: false };
  if (p.kind === 'gif') return { convert: false, filter: '', note: 'GIF 按 sRGB 处理', warn: false };
  const prim = override === 'p3' ? 'smpte432' : p.primaries;
  if (prim === 'smpte432') {
    const space = OK_SPACE.has(p.matrix) ? p.matrix : 'bt709';
    const trc = OK_TRC.has(p.transfer) ? p.transfer : 'bt709';
    const range = p.range === 'pc' ? 'pc' : 'tv';
    return {
      convert: true,
      filter: `colorspace=ispace=${space}:itrc=${trc}:iprimaries=smpte432:irange=${range}:space=bt709:trc=bt709:primaries=bt709:range=tv:fast=0,`,
      note: '原片是 Display P3 广色域，已转成 sRGB',
      warn: false,
    };
  }
  if (prim === 'bt709') return { convert: false, filter: '', note: '原片是 bt709 / sRGB，不用转色', warn: false };
  if (!prim || prim === 'unknown' || prim === 'unspecified') {
    return { convert: false, filter: '', note: '原片没有色彩标记，按 sRGB 处理；颜色偏淡的话可以手动选「按 Display P3 转」', warn: true };
  }
  return { convert: false, filter: '', note: `原片的色彩标记是 ${prim}，暂不支持转换，按 sRGB 处理`, warn: true };
}
