// 主界面打标条（10-19 深夜，TODO 2.71）：段的计算（renderer/marks.cjs）。界面怎么画、按键灵不灵在测试桩里测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../renderer/marks.cjs');
const rs = (segs) => segs.map((s) => [s.start, s.end]);

test('切一刀（作者：按两下出现三段）：没切过时按时间轴两头切成两段；再切切开包含它的那段', () => {
  let r = M.cut([], -1, 10, { start: 0, end: 30 });
  assert.deepEqual(rs(r.segs), [[0, 10], [10, 30]]);
  assert.equal(r.at, 1);
  r = M.cut(r.segs, -1, 20, null);
  assert.deepEqual(rs(r.segs), [[0, 10], [10, 20], [20, 30]]);
  assert.equal(r.at, 2);
  // 时间轴两头剪过：按剪过的切
  assert.deepEqual(rs(M.cut([], -1, 5, { start: 2, end: 8 }).segs), [[2, 5], [5, 8]]);
});

test('切不了的：选段外面、离头尾或上一刀不到 0.5 秒（和录屏切分一样）、落在两段之间的空当里', () => {
  assert.ok(M.cut([], -1, 1, { start: 2, end: 8 }).error);
  assert.ok(M.cut([], -1, 2.3, { start: 2, end: 8 }).error);
  const two = M.cut([], -1, 10, { start: 0, end: 30 }).segs;
  assert.ok(M.cut(two, -1, 10.3, null).error);
  assert.ok(!M.cut(two, -1, 10.6, null).error);
  const gap = [{ start: 0, end: 5 }, { start: 8, end: 12 }];
  assert.ok(M.cut(gap, -1, 6, null).error);
});

test('选中的那段被切开：选中后一半（播放从切点接着往后走）；选中别的段时编号跟着挪', () => {
  const segs = M.cut([], -1, 10, { start: 0, end: 30 }).segs;
  let r = M.cut(segs, 1, 20, null);
  assert.equal(r.sel, 2);
  r = M.cut(segs, 1, 5, null);
  assert.deepEqual(rs(r.segs), [[0, 5], [5, 10], [10, 30]]);
  assert.equal(r.sel, 2);
});

test('精修（各段各调各的起止，可以伸到相邻段里、不带动别的段）；没选中时改的是整体的头尾', () => {
  const segs = M.cut(M.cut([], -1, 10, { start: 0, end: 30 }).segs, -1, 20, null).segs;
  let out = M.setRange(segs, 1, 9, 22);
  assert.deepEqual(rs(out), [[0, 10], [9, 22], [20, 30]]);
  assert.deepEqual(out[1].orig, { start: 10, end: 20 }); // 切出来时的起止留着，「还原这段」和切点位置用
  out = M.setRange(segs, -1, 1.5, 28);
  assert.deepEqual(rs(out), [[1.5, 10], [10, 20], [20, 28]]);
  assert.deepEqual(M.span(out), { start: 1.5, end: 28 });
});

test('删一刀：和前一段合成一段（起止取两段合起来）；只剩一段又不是菜单栏里的行，就当没切过', () => {
  const segs = M.cut(M.cut([], -1, 10, { start: 0, end: 30 }).segs, -1, 20, null).segs;
  let r = M.merge(segs, 2, 2);
  assert.deepEqual(rs(r.segs), [[0, 10], [10, 30]]);
  assert.equal(r.sel, 1);
  r = M.merge(r.segs, -1, 1);
  assert.deepEqual(r.segs, []);
  assert.deepEqual(r.base, { start: 0, end: 30 });
  assert.ok(M.merge(segs, -1, 0).error);
  // 精修过的两段：合起来取最早的开头、最晚的结尾
  const tuned = M.setRange(segs, 1, 9, 22);
  assert.deepEqual(rs(M.merge(tuned, -1, 2).segs), [[0, 10], [9, 30]]);
});

test('菜单栏里的行（gid）：没压过的切开后前一半接着用那一行；压过的切开、合并后都是新的段（原来那行结果留着）', () => {
  const rec = [{ start: 0, end: 10, gid: 7, done: false }, { start: 10, end: 20, gid: 8, done: true }];
  let r = M.cut(rec, -1, 5, null);
  assert.deepEqual(r.segs.map((s) => s.gid), [7, null, 8]);
  r = M.cut(rec, -1, 15, null);
  assert.deepEqual(r.segs.map((s) => s.gid), [7, null, null]);
  r = M.merge(rec, -1, 1);
  assert.equal(r.segs[0].gid, 7);
  assert.deepEqual(rs(r.segs), [[0, 20]]); // 还是菜单栏里的一行：不当没切过
});

test('太长的段（作者：只切一刀、后面那段太长要提前提醒）：超过上限的段挑出来，正好等于不算', () => {
  const segs = [{ start: 0, end: 10 }, { start: 10, end: 85 }, { start: 85, end: 115 }];
  assert.deepEqual(M.longOnes(segs, 30), [1]);
  assert.deepEqual(M.longOnes(segs, 20), [1, 2]);
  assert.deepEqual(M.longOnes([], 30), []);
});

// ---------- 多选（11.14 多选导出，11-06 作者：「直接升级成多选导出」，示意图选 A） ----------
const three = () => M.cut(M.cut([], -1, 11.06, { start: 0, end: 26.35 }).segs, -1, 20.82, null).segs; // 作者那次：0–11.06、11.06–20.82、20.82–26.35

test('多选：⌘点加减（单选也算一段），两段以上才算多选；⇧点从上次点的那段连着选', () => {
  assert.deepEqual(M.togglePick(-1, [], 0), { sel: 0, pick: [] }, '什么都没选时 ⌘点 = 单选');
  assert.deepEqual(M.togglePick(0, [], 2), { sel: -1, pick: [0, 2] }, '单选第 1 段再 ⌘点第 3 段 = 多选 1、3');
  assert.deepEqual(M.togglePick(-1, [0, 2], 1), { sel: -1, pick: [0, 1, 2] });
  assert.deepEqual(M.togglePick(-1, [0, 2], 2), { sel: 0, pick: [] }, '去掉一段只剩一段 = 变回单选');
  assert.deepEqual(M.togglePick(0, [], 0), { sel: -1, pick: [] }, '⌘点唯一选中的那段 = 都不选');
  assert.deepEqual(M.rangePick(-1, [], 1, 3), { sel: -1, pick: [1, 2, 3] });
  assert.deepEqual(M.rangePick(3, [], 3, 0), { sel: -1, pick: [0, 1, 2, 3] }, '往前连选也行');
  assert.deepEqual(M.rangePick(-1, [], -1, 2), { sel: 2, pick: [] }, '没点过：⇧点 = 单选');
});

test('多选：拼的段按时间排（不按点的先后），算总长和「1+3」；预览在空当跳到下一段、过了最后一段回第一段', () => {
  const segs = three();
  assert.deepEqual(M.joinParts(segs, [2, 0]), [{ start: 0, dur: 11.06 }, { start: 20.82, dur: 5.53 }]);
  assert.equal(M.joinDur(segs, [0, 2]), 16.59);
  assert.equal(M.pickLabel([0, 2]), '1+3');
  assert.deepEqual(M.pickSpan(segs, [0, 2]), { start: 0, end: 26.35 });
  assert.deepEqual(M.skipped(segs, [0, 2]), [1], '1、3 中间的第 2 段变暗');
  assert.deepEqual(M.skipped(segs, [1, 2]), [], '连着选的没有变暗的');
  assert.equal(M.nextPlay(segs, [0, 2], 5), null, '在第 1 段里照常放');
  assert.equal(M.nextPlay(segs, [0, 2], 11.05), 20.82, '第 1 段放完（差 0.02 秒内）跳到第 3 段');
  assert.equal(M.nextPlay(segs, [0, 2], 15), 20.82, '停在第 2 段里点播放：跳到第 3 段');
  assert.equal(M.nextPlay(segs, [0, 2], 26.34), 0, '第 3 段放完回第 1 段');
  assert.equal(M.nextPlay(segs, [1, 2], 3), 11.06, '在第一段选中的前面：跳到它的开头');
});

test('多选：切刀、删刀以后选中的段号跟着变；改起止只改选中的几段合起来的头尾', () => {
  const segs = three();
  // 在第 1 段里再切一刀：第 1 段的两半都还选着，第 3 段变成第 4 段
  const c = M.cut(segs, -1, 5, null);
  assert.deepEqual(M.pickAfterCut([0, 2], c.at), [0, 1, 3]);
  // 在没选的第 2 段里切：后面的往后挪
  const c2 = M.cut(segs, -1, 15, null);
  assert.deepEqual(M.pickAfterCut([0, 2], c2.at), [0, 3]);
  // 删掉第 2 刀（第 2、3 段合成一段）：有一半选着就算选着，剩不到两段变单选
  const m = M.merge(segs, -1, 2);
  assert.deepEqual(M.pickAfterMerge([0, 2], 2, m.segs), { sel: -1, pick: [0, 1] });
  const m1 = M.merge(segs, -1, 1);
  assert.deepEqual(M.pickAfterMerge([0, 1], 1, m1.segs), { sel: 0, pick: [] }, '选着的两段合成一段 = 单选');
  // 改起止：多选 2、3 时只改第 2 段的开头、第 3 段的结尾，第 1 段不动
  const r = M.setRange(segs, -1, 12, 25, [1, 2]);
  assert.deepEqual(rs(r), [[0, 11.06], [12, 20.82], [20.82, 25]]);
  // 没选中时照旧改整体的头尾
  assert.deepEqual(rs(M.setRange(segs, -1, 1, 25)), [[1, 11.06], [11.06, 20.82], [20.82, 25]]);
});
