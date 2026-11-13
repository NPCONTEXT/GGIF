// GIF 文件结构解析：只读块结构，不解码像素。凑帧、合规检查、批量判断都靠它。

/** 跳过一串子块，返回结束符之后的位置；数据不完整时返回 -1。 */
function skipSubBlocks(d, pos) {
  while (pos < d.length) {
    const n = d[pos];
    pos += 1;
    if (n === 0) return pos;
    pos += n;
  }
  return -1;
}

/**
 * 解析 GIF。返回
 * { width, height, headEnd, blocks: [{kind:'gce'|'img'|'ext', start, end}], frames: [{imgIndex, gceIndex, delay, disposal, transparent}], truncated, error }
 * delay 单位是 1/100 秒；disposal 0–7。
 */
export function parseGif(d) {
  const r = { width: 0, height: 0, headEnd: 0, blocks: [], frames: [], truncated: false, error: '' };
  const sig = d.subarray(0, 6).toString('latin1');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') {
    r.error = '不是 GIF 文件';
    return r;
  }
  r.width = d.readUInt16LE(6);
  r.height = d.readUInt16LE(8);
  const flags = d[10];
  let pos = 13 + (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0);
  r.headEnd = pos;
  let pendingGce = -1;
  while (pos < d.length) {
    const b = d[pos];
    if (b === 0x21) {
      const label = d[pos + 1];
      const end = skipSubBlocks(d, pos + 2);
      if (end < 0) { r.truncated = true; break; }
      const kind = label === 0xf9 ? 'gce' : 'ext';
      r.blocks.push({ kind, start: pos, end });
      if (kind === 'gce') pendingGce = r.blocks.length - 1;
      pos = end;
    } else if (b === 0x2c) {
      if (pos + 10 > d.length) { r.truncated = true; break; }
      const pf = d[pos + 9];
      const p = pos + 10 + (pf & 0x80 ? 3 * (2 << (pf & 7)) : 0);
      const end = skipSubBlocks(d, p + 1);
      if (end < 0) { r.truncated = true; break; }
      r.blocks.push({ kind: 'img', start: pos, end });
      const frame = { imgIndex: r.blocks.length - 1, gceIndex: -1, delay: 0, disposal: 0, transparent: false };
      if (pendingGce >= 0 && pendingGce === r.blocks.length - 2) {
        const g = r.blocks[pendingGce];
        const packed = d[g.start + 3];
        frame.gceIndex = pendingGce;
        frame.disposal = (packed >> 2) & 7;
        frame.transparent = Boolean(packed & 1);
        frame.delay = d.readUInt16LE(g.start + 4);
      }
      r.frames.push(frame);
      pendingGce = -1;
      pos = end;
    } else if (b === 0x3b) {
      break;
    } else {
      r.error = `第 ${pos} 字节遇到不认识的块 0x${b.toString(16)}`;
      break;
    }
  }
  if (pos >= d.length && !r.error) r.truncated = true;
  return r;
}

/** 摘要：给合规检查和界面用。 */
export function gifSummary(d) {
  const g = parseGif(d);
  const totalCs = g.frames.reduce((s, f) => s + f.delay, 0);
  return {
    ok: !g.error,
    error: g.error,
    truncated: g.truncated,
    width: g.width,
    height: g.height,
    frames: g.frames.length,
    durationSec: totalCs / 100,
    disposals: [...new Set(g.frames.map((f) => f.disposal))].sort(),
    bytes: d.length,
  };
}
