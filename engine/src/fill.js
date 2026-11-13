// 凑帧：给总帧数不够的 GIF 补 1×1 透明小帧（保留上一帧画面），凑够帧数。画面、总时长都不变，原有压缩数据一个字节不动。
//
// 起因：公众号文章里，≤60 帧的 GIF 会被微信重新编码并缩到 640 宽；≥61 帧原样下发（10-17 个人号、电脑网页端实测；手机端没验证）。
// 和测评时的 脚本/凑帧.py 比，修了两处（K3 / 子代理核查指出）：
//   1. 一帧可以拆多次（每段延时 ≥ 2 百分之一秒），原来每帧只拆一次，帧数太少就凑不够；
//   2. 只拆处置方式 0 / 1 的帧。小帧插在原帧后面，原帧的处置会在小帧显示前执行；处置方式 2 / 3 会让那段时间画面被清空或回退，看起来会闪。
import { parseGif } from './gif.js';

// 1×1 图像块：带 2 色局部色表，LZW 数据是「一个像素，索引 0」。
const TINY_IMG = Buffer.from([
  0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00,
]);
export const TINY_FRAME_BYTES = 8 + TINY_IMG.length; // GCE 8 字节 + 图像块 21 字节 = 29

function tinyFrame(delay) {
  const gce = Buffer.from([0x21, 0xf9, 0x04, 0x05, delay & 0xff, delay >> 8, 0x00, 0x00]); // 处置 1（保留）+ 透明索引 0
  return Buffer.concat([gce, TINY_IMG]);
}

const MIN_SEG = 2; // 每段最少 2/100 秒；小于 2 很多浏览器会当成 10

/** 把延时 d 分成 parts 段，每段尽量平均，前面的段多分余数。 */
function splitDelay(d, parts) {
  const base = Math.floor(d / parts);
  const rem = d - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0));
}

/**
 * 凑帧。返回 { buffer, before, after, added, ok, reason }。
 * 帧数已够就原样返回（同一个 Buffer）。凑不够时 ok=false、buffer 是原文件。
 */
export function fillFrames(d, target = 61) {
  const g = parseGif(d);
  const before = g.frames.length;
  if (g.error || g.truncated) return { buffer: d, before, after: before, added: 0, ok: false, reason: g.error || '文件不完整' };
  const need = target - before;
  if (need <= 0) return { buffer: d, before, after: before, added: 0, ok: true, reason: '帧数已够' };

  const splittable = g.frames
    .map((f, i) => ({ i, f, cap: f.gceIndex >= 0 && f.disposal <= 1 ? Math.floor(f.delay / MIN_SEG) - 1 : 0 }))
    .filter((x) => x.cap > 0);
  const capacity = splittable.reduce((s, x) => s + x.cap, 0);
  if (capacity < need) {
    const skipped = g.frames.filter((f) => f.disposal > 1).length;
    return {
      buffer: d, before, after: before, added: 0, ok: false,
      reason: `最多只能补 ${capacity} 帧，还差 ${need - capacity} 帧（帧的延时太短${skipped ? `，另有 ${skipped} 帧处置方式是 2/3 不能拆` : ''}）`,
    };
  }

  // 轮流给每个可拆的帧加一个小帧，分得尽量散
  const extra = new Map();
  let left = need;
  while (left > 0) {
    for (const x of splittable) {
      if (left === 0) break;
      const k = extra.get(x.i) || 0;
      if (k < x.cap) {
        extra.set(x.i, k + 1);
        left -= 1;
      }
    }
  }

  const parts = [d.subarray(0, g.headEnd)];
  const frameOfImg = new Map(g.frames.map((f, i) => [f.imgIndex, i]));
  const frameOfGce = new Map(g.frames.map((f, i) => [f.gceIndex, i]).filter(([k]) => k >= 0));
  g.blocks.forEach((blk, bi) => {
    let piece = d.subarray(blk.start, blk.end);
    const fi = blk.kind === 'gce' ? frameOfGce.get(bi) : undefined;
    if (fi !== undefined && extra.has(fi)) {
      const segs = splitDelay(g.frames[fi].delay, extra.get(fi) + 1);
      piece = Buffer.from(piece);
      piece.writeUInt16LE(segs[0], 4);
    }
    parts.push(piece);
    const fj = blk.kind === 'img' ? frameOfImg.get(bi) : undefined;
    if (fj !== undefined && extra.has(fj)) {
      const segs = splitDelay(g.frames[fj].delay, extra.get(fj) + 1);
      for (const s of segs.slice(1)) parts.push(tinyFrame(s));
    }
  });
  parts.push(Buffer.from([0x3b]));
  const buffer = Buffer.concat(parts);
  return { buffer, before, after: before + need, added: need, ok: true, reason: `补了 ${need} 个透明小帧` };
}
