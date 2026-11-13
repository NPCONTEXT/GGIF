// 主界面打标条的「段」（10-19 深夜，作者选 A：框外细条，展开时长成时间轴）：切一刀、删一刀、改起止，只做计算，界面（app.js）和单元测试共用。
// 打标 = 切一刀（作者：「按两下出现三段，按三下出现四段」）。切开以后各段各调各的起止，可以伸到相邻段里、不带动别的段
// （10-19 录屏定的机制：整段留一份、每段只记起止；作者转来的 GPT 意见也这么建议）。
// 段：{ start, end, gid, done, orig }。gid 是菜单栏里那一行的编号（导出过、或者是录屏的段才有）；done 是那一行已经有压好的结果；
// orig 是切出来时的起止（「还原这段」用）。切点 = 第 2 段起每段的开头。
// 浏览器里当普通脚本加载（挂在 window.Marks），node 测试里 require。
(function (root) {
  const MIN = 0.3; // 一段最短多少秒（和时间轴选段最短一样）
  const GAP = 0.5; // 切点离头尾、离上一刀至少多远（和录屏切分一样，手抖连按两下不算）
  const r2 = (x) => Math.round(x * 100) / 100;
  const fresh = (start, end, gid = null) => ({ start, end, gid, done: false, orig: { start, end } });

  /** 所有段合起来从哪到哪（没选中某一段时，预览放的就是这一截）。 */
  function span(segs) {
    return { start: Math.min(...segs.map((s) => s.start)), end: Math.max(...segs.map((s) => s.end)) };
  }

  /**
   * 在 t 切一刀。base：还没切过时整段的起止（时间轴两头剪过就按剪过的）。
   * 返回 { segs, sel, at }（at：新切点是第几段的开头，界面让它弹一下），切不了返回 { error }。
   */
  function cut(segs, sel, t, base) {
    t = r2(t);
    if (!segs.length) {
      if (t <= base.start || t >= base.end) return { error: '这里在选段外面，切不了' };
      if (t - base.start < GAP || base.end - t < GAP) return { error: '离开头或结尾太近了（不到 0.5 秒）' };
      return { segs: [fresh(r2(base.start), t), fresh(t, r2(base.end))], sel: -1, at: 1 };
    }
    // 先看选中的那段，再按顺序找包含 t 的
    const inside = (s) => s.start < t && t < s.end;
    const k = sel >= 0 && inside(segs[sel]) ? sel : segs.findIndex(inside);
    if (k < 0) return { error: '这里不在任何一段里，切不了' };
    const s = segs[k];
    if (t - s.start < GAP || s.end - t < GAP) return { error: '离上一刀或这一段的头尾太近了（不到 0.5 秒）' };
    // 已经压过的段切开以后两半都算新的（原来那行结果留在菜单栏）；还没压的，前一半接着用原来那行
    const out = [...segs.slice(0, k), fresh(s.start, t, s.done ? null : s.gid), fresh(t, s.end), ...segs.slice(k + 1)];
    // 正在看的就是被切的这段：选中后一半（播放从切点接着往后走）
    const nsel = sel < 0 ? -1 : sel > k ? sel + 1 : sel === k ? k + 1 : sel;
    return { segs: out, sel: nsel, at: k + 1 };
  }

  /**
   * 删掉第 k 刀（第 k 段的开头，k ≥ 1）：和前一段合成一段（起止取两段合起来）。
   * 只剩一段、又不是菜单栏里的行时，就当没切过：返回 segs: []，base 是这一段的起止。
   */
  function merge(segs, sel, k) {
    if (k < 1 || k >= segs.length) return { error: '没有这一刀' };
    const a = segs[k - 1];
    const b = segs[k];
    const gid = !a.done && a.gid ? a.gid : !b.done && b.gid ? b.gid : null;
    const m = fresh(Math.min(a.start, b.start), Math.max(a.end, b.end), gid);
    const out = [...segs.slice(0, k - 1), m, ...segs.slice(k + 1)];
    if (out.length === 1 && !m.gid) return { segs: [], sel: -1, base: { start: m.start, end: m.end } };
    const nsel = sel < 0 ? -1 : sel >= k - 1 && sel <= k ? k - 1 : sel > k ? sel - 1 : sel;
    return { segs: out, sel: nsel };
  }

  /**
   * 改起止：选中了某段就改这段（可以伸到相邻段里，不带动别的段）；多选了几段就改这几段合起来的头尾；
   * 没选中就改整体的头尾（最早那段的开头、最晚那段的结尾）。s、e 已经按原片时长限好。返回新的段。
   */
  function setRange(segs, sel, s, e, pick = []) {
    const out = segs.map((x) => ({ ...x }));
    if (sel >= 0) {
      out[sel].start = r2(s);
      out[sel].end = r2(e);
      return out;
    }
    const idx = pick.length ? pick : out.map((_, i) => i);
    const first = idx.reduce((m, i) => (out[i].start < out[m].start ? i : m), idx[0]);
    const last = idx.reduce((m, i) => (out[i].end > out[m].end ? i : m), idx[0]);
    out[first].start = r2(Math.min(s, out[first].end - MIN));
    out[last].end = r2(Math.max(e, out[last].start + MIN));
    return out;
  }

  /** 超过 maxSec 秒的段（导出可能导不出来：公众号最多 300 帧）。返回段的下标。 */
  function longOnes(segs, maxSec) {
    return segs.map((s, i) => (s.end - s.start > maxSec + 0.05 ? i : -1)).filter((i) => i >= 0);
  }

  // ---------- 多选（11.14 多选导出，11-06 作者：「直接升级成多选导出」，示意图选 A） ----------
  // pick：多选的几段的下标（升序，至少两段才算多选，这时 sel = -1）；一段就是单选 sel；⌘点加减、⇧点连选，和菜单栏列表一样。

  /** 现在选中的是哪几段（单选也算一段）。 */
  const chosen = (sel, pick) => (pick && pick.length ? pick : sel >= 0 ? [sel] : []);
  /** 选中的下标整理成 { sel, pick }：两段以上 = 多选；一段 = 单选；没有 = 都不选。 */
  function norm(list) {
    const u = [...new Set(list)].sort((a, b) => a - b);
    return u.length >= 2 ? { sel: -1, pick: u } : { sel: u.length ? u[0] : -1, pick: [] };
  }
  /** ⌘点第 i 段：加进 / 移出选中的几段。 */
  function togglePick(sel, pick, i) {
    const cur = chosen(sel, pick);
    return norm(cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]);
  }
  /** ⇧点第 i 段：从上次点的那段（anchor）连着选到 i；没有 anchor 就从现在选中的第一段起。 */
  function rangePick(sel, pick, anchor, i) {
    const cur = chosen(sel, pick);
    const a = anchor >= 0 ? anchor : cur.length ? cur[0] : i;
    const lo = Math.min(a, i);
    return norm(Array.from({ length: Math.abs(a - i) + 1 }, (_, k) => lo + k));
  }
  /** 切了一刀（at = 新切点是第几段的开头，即第 at-1 段被切开）：多选的下标跟着挪，被切的那段选着的话两半都选着。 */
  function pickAfterCut(pick, at) {
    const k = at - 1;
    return pick.flatMap((p) => (p < k ? [p] : p === k ? [k, k + 1] : [p + 1]));
  }
  /** 删掉第 k 刀（第 k-1、k 段合成一段）：两半有一半选着就算选着，后面的下标 -1；剩不到两段变成单选。segs 是合完的段。 */
  function pickAfterMerge(pick, k, segs) {
    if (!segs.length) return { sel: -1, pick: [] };
    return norm(pick.map((p) => (p >= k ? p - 1 : p)));
  }
  /** 选中的几段按时间顺序（开头早的在前，不按点的先后）给引擎拼：[{ start, dur }]。 */
  function joinParts(segs, pick) {
    return pick.map((i) => segs[i]).sort((a, b) => a.start - b.start || a.end - b.end).map((x) => ({ start: r2(x.start), dur: r2(x.end - x.start) }));
  }
  /** 拼起来多长（秒）。 */
  const joinDur = (segs, pick) => r2(joinParts(segs, pick).reduce((t, p) => t + p.dur, 0));
  /** 「1+3」：选中的段号（从 1 数）。 */
  const pickLabel = (pick) => pick.map((i) => i + 1).join('+');
  /** 选中的几段合起来从哪到哪（预览循环、时间轴两头）。 */
  const pickSpan = (segs, pick) => span(pick.map((i) => segs[i]));
  /** 两段之间没选的（时间在第一段开头和最后一段结尾之间）：展开时变暗。返回段的下标。 */
  function skipped(segs, pick) {
    const r = pickSpan(segs, pick);
    return segs.map((x, i) => (!pick.includes(i) && x.start >= r.start - 0.01 && x.end <= r.end + 0.01 ? i : -1)).filter((i) => i >= 0);
  }
  /**
   * 预览跳着放：播放到 t 秒时要不要跳。在选中的某段里返回 null（照常放）；在两段之间的空当里返回下一段的开头；
   * 在最后一段的结尾（差 0.02 秒以内）或更后面返回第一段的开头（像 GIF 一样从头循环）。
   */
  function nextPlay(segs, pick, t) {
    const parts = pick.map((i) => segs[i]).sort((a, b) => a.start - b.start);
    if (parts.some((x) => x.start - 0.005 <= t && t < x.end - 0.02)) return null;
    const nx = parts.find((x) => x.start > t);
    return nx ? nx.start : parts[0].start;
  }

  const Marks = { MIN, GAP, span, cut, merge, setRange, longOnes, togglePick, rangePick, pickAfterCut, pickAfterMerge, joinParts, joinDur, pickLabel, pickSpan, skipped, nextPlay };
  if (typeof module === 'object' && module.exports) module.exports = Marks;
  else root.Marks = Marks;
})(typeof window !== 'undefined' ? window : globalThis);
