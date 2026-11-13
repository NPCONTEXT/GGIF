// 在体积上限内找画质最高的 q：二分到相邻整数，找到后再往上试 3 档（防体积不单调）。和测评脚本 测评v2.py 的 搜索() 同一套做法。
import { copyFile, rm } from 'node:fs/promises';

/**
 * encode(q, out) → { ok, bytes, ms, err }
 * 返回 { best: {q, bytes} | null, tries: [{q, bytes, ms}], file }（best 的文件复制到 file）
 */
export async function searchQuality(encode, { lo, hi, limit, tmp, file, hint, onTry }) {
  const sizes = new Map();
  const tries = [];
  let best = null;
  async function tryQ(q) {
    if (sizes.has(q)) return sizes.get(q);
    const r = await encode(q, tmp);
    if (!r.ok) throw new Error(r.err || '编码失败');
    tries.push({ q, bytes: r.bytes, ms: Math.round(r.ms) });
    sizes.set(q, r.bytes);
    if (r.bytes <= limit && (!best || q > best.q)) {
      best = { q, bytes: r.bytes };
      await copyFile(tmp, file);
    }
    onTry?.({ q, bytes: r.bytes });
    return r.bytes;
  }
  try {
    if ((await tryQ(hi)) <= limit) return { best, tries, file };
    let a = null;
    let b = hi;
    if (hint !== undefined && hint !== null && lo < hint && hint < hi) {
      if ((await tryQ(hint)) <= limit) a = hint;
      else b = hint;
    }
    if (a === null) {
      if ((await tryQ(lo)) > limit) return { best: null, tries, file };
      a = lo;
    }
    while (b - a > 1) {
      const m = Math.floor((a + b) / 2);
      if ((await tryQ(m)) <= limit) a = m;
      else b = m;
    }
    for (let q = a + 2; q <= Math.min(a + 4, hi); q++) await tryQ(q);
    return { best, tries, file };
  } finally {
    await rm(tmp, { force: true });
  }
}
