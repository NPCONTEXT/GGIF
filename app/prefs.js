// 设置（10-22 设置卷，作者批准第一批）：settings.json 里新加的几项的默认值，和读进来时的整理——
// 缺的字段用默认、旧版存的文件照样读（只有档位、两种都要、录完自动压、时间轴这几项）、认不出的值换回默认。
// 新开关默认保持原来的行为；「启动时打开完整界面」作者选「默认关（更轻量）」。
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const Hotkeys = require('./renderer/hotkeys.cjs');

export const SPEED_IDS = ['fast', 'standard', 'best'];
export const PREF_DEFAULTS = Object.freeze({
  hotkeys: Object.freeze({ ...Hotkeys.DEFAULTS }), // 开始 / 停止录屏、切一刀
  openMainOnStart: false, // 启动时打开完整界面（开机自启那次不管它都不弹）
  notifyDone: true, // 压完了发通知（出错的照样发）
  fill: true, // 凑到 61 帧（一键、菜单栏、双击都按它；自定义里还能单次改）
  rememberPreset: true, // 主界面记住上次的档位和速度
  rememberTimeline: true, // 记住时间轴展开 / 收起
  mainPreset: null, // 主界面上次选的档位、速度（rememberPreset 开着才用）
  mainSpeed: null,
  settingsTab: 'set', // 设置那层上次停在哪页：set / help
  outDir: null, // 结果放哪（第二批）：null = 原文件旁边；路径 = 都放进这个文件夹
  oplog: true, // 操作日志（脱敏，第二批）：测试期间默认开
  recDir: null, // 录像放哪（10-22 试用反馈 9.6b）：null = 下载/GGIF录屏；路径 = 放进这个文件夹
  recRegion: null, // 上次录屏的框（10-22 试用反馈 9.6c）：{ x, y, w, h, displayId, dw, dh }，点、相对那块屏幕左上角
  dropBlockOn: false, // Windows：屏幕边的投放块。11-08 先选了投放块，当晚改成拖到托盘弹面板（作者：「A」），投放块默认关、设置里留着当后备；
  //                    换了名字（原来叫 dropBlock，默认开），老设置里存的 dropBlock: true 不再算。Mac 上不用
  dropBlockY: null, // Windows：投放块在屏幕右边的上下位置，0–1（占可用高度的比例）；null = 默认
  panelPinned: false, // Windows：面板「固定」，开着时失去焦点不收（作者：「看看怎么固定浮窗」）
});

/** 整理读进来的设置（raw 是 settings.json 解析出来的对象，可以缺字段、可以是旧版的） */
export function normalizePrefs(raw, { presetIds = [] } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const bool = (k) => (typeof r[k] === 'boolean' ? r[k] : PREF_DEFAULTS[k]);
  const hk = r.hotkeys && typeof r.hotkeys === 'object' ? r.hotkeys : {};
  let rec = typeof hk.rec === 'string' && !Hotkeys.check(hk.rec) ? Hotkeys.normalize(hk.rec) : PREF_DEFAULTS.hotkeys.rec;
  let mark = typeof hk.mark === 'string' && !Hotkeys.check(hk.mark, rec) ? Hotkeys.normalize(hk.mark) : PREF_DEFAULTS.hotkeys.mark;
  if (mark === rec) ({ rec, mark } = PREF_DEFAULTS.hotkeys); // 换回默认后撞上了：两个都用默认
  return {
    hotkeys: { rec, mark },
    openMainOnStart: bool('openMainOnStart'),
    notifyDone: bool('notifyDone'),
    fill: bool('fill'),
    rememberPreset: bool('rememberPreset'),
    rememberTimeline: bool('rememberTimeline'),
    mainPreset: presetIds.includes(r.mainPreset) ? r.mainPreset : null,
    mainSpeed: SPEED_IDS.includes(r.mainSpeed) ? r.mainSpeed : null,
    settingsTab: r.settingsTab === 'help' ? 'help' : 'set',
    // 绝对路径才认（Windows版 11-08：原来只认 / 开头，Windows 的 C:\ 路径存不住）；在不在等用的时候再查（外接硬盘可能只是没接）
    outDir: typeof r.outDir === 'string' && path.isAbsolute(r.outDir) ? r.outDir : null,
    oplog: bool('oplog'),
    recDir: typeof r.recDir === 'string' && path.isAbsolute(r.recDir) ? r.recDir : null, // 在不在等开录时再查
    recRegion: normRegion(r.recRegion),
    dropBlockOn: bool('dropBlockOn'),
    panelPinned: bool('panelPinned'),
    dropBlockY: Number.isFinite(r.dropBlockY) && r.dropBlockY >= 0 && r.dropBlockY <= 1 ? r.dropBlockY : null,
  };
}

/** 上次录屏的框：几个数都得是数、宽高至少 64 点，不然当没记 */
function normRegion(v) {
  if (!v || typeof v !== 'object') return null;
  const n = (k) => (Number.isFinite(v[k]) ? Math.round(v[k]) : null);
  const r = { x: n('x'), y: n('y'), w: n('w'), h: n('h'), displayId: Number.isFinite(v.displayId) ? v.displayId : null, dw: n('dw'), dh: n('dh') };
  return [r.x, r.y, r.w, r.h].every((x) => x !== null) && r.x >= 0 && r.y >= 0 && r.w >= 64 && r.h >= 64 ? r : null;
}
