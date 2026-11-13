// 合规检查：体积、总帧数、宽度、能不能完整解码。只读。
import { readFile } from 'node:fs/promises';
import { gifSummary } from './gif.js';
import { TOOLS, run } from './tools.js';

/**
 * 检查一个 GIF 是否符合预设。返回
 * { ok, problems: [...], needsFill, summary }
 * needsFill = 总帧数不到 minFrames（凑帧能解决，单独列出来，不算「不合规」）。
 */
export async function checkGif(file, preset, { decode = true } = {}) {
  const buf = await readFile(file);
  const s = gifSummary(buf);
  const problems = [];
  if (!s.ok) problems.push(`文件结构有问题：${s.error}`);
  if (s.truncated) problems.push('文件不完整（没有结束符）');
  if (s.bytes > preset.limit) problems.push(`体积 ${fmtBytes(s.bytes)} 超过上限 ${fmtBytes(preset.limit)}`);
  if (s.frames > preset.maxFrames) problems.push(`总帧数 ${s.frames} 超过 ${preset.maxFrames}`);
  if (s.width > preset.maxWidth) problems.push(`宽 ${s.width} 超过 ${preset.maxWidth}`);
  if (decode && s.ok) {
    // -enc_time_base demux：按 GIF 自己的 1/100 秒时间基输出。不加的话，凑帧后的短延时会被 null 输出按帧率时间基四舍五入成同一个时间戳，报「non monotonically increasing dts」误报（10-17 实测）。
    const r = await run(TOOLS.ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-enc_time_base', 'demux', '-f', 'null', '-']);
    if (r.code !== 0 || r.stderr.trim()) problems.push(`完整解码出错：${r.stderr.trim().slice(-200)}`);
  }
  return { ok: problems.length === 0, problems, needsFill: s.frames < preset.minFrames, summary: s };
}

export function fmtBytes(b) {
  return `${(b / 1e6).toFixed(2)}MB（${b.toLocaleString('en-US')} 字节）`;
}
