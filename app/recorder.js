// 录屏（录屏卷 3.1、3.5）：主进程这边管录屏小助手（native/recorder.swift：苹果录屏接口 + 系统选择窗口，不用「屏幕录制」权限）、
// 选区域的透明层、录制控制条（同时是进度条）、打标切分。录制中不压缩。
// 作者：苹果接口；不录鼠标；单次最长 90 秒、到点自动停；打标 = 切一刀（N 刀 N+1 段，画面一点不丢）；
// 11.12（作者）：打标能开关（默认关）——关着不占 ⌥空格、整段一份；开着照旧切，一刀没切也是整段一份（不再每 10 秒切）；
// 停录后整段留一个录像、每段只记起止，事后能把每段的起止拖到整段任何位置。设计看 GIF工具/录屏/方案.md §八、§九。
//
// 状态：idle → picking（弹系统选择窗口）→ armed（准备好，区域框和控制条在，可以先去点播放）→ starting → recording（⌥空格 切一刀）
//       → stopping（拼整段、分段）→ idle。10-22 试用反馈起选了屏幕也不进 region（「拖一块」）：直接用上次的框（存进设置），
//       拖边角改大小、拖控制条挪；控制条上点「改区域」才进 region 重新画一块。
// 区域层、区域框、控制条都开内容保护，不会被录进去（10-19 晚实测）。
import { BrowserWindow, screen, globalShortcut } from 'electron';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { splitRanges, coveredUntil, assembleClip, rangeLabel, MAX_SEC, MIN_CUT_GAP, normRecFps, HIFI_FPS } from './rec-clips.js';

// 默认的两个快捷键（10-22 起设置里能换，现在用哪个从 getSettings().hotkeys 拿，见 ../prefs.js）
export const HOTKEY_REC = 'Control+Alt+R';
// 切一刀用 ⌥空格（作者想用空格：光空格注册成全局快捷键会抢走所有程序的空格，浏览器暂停不了、打不了字；
// ⌥空格系统和输入法都没占，只在录制中占用）
export const HOTKEY_MARK = 'Alt+Space';
export const HOTKEY_TEXT = { rec: '⌃⌥R', mark: '⌥空格' };
// 帧率：高保真录 60 帧（60 是 10、12、15、20 的公倍数，之后按任何 GIF 帧率取帧都正好落在录到的帧上）；
// 11.13 起能选 30 / 15 / 10 / 5（getSettings().fps，选了就锁，见 rec-clips.js REC_FPS），开录时定下、这次录屏中途不变
const MAX_WIDTH = 1920; // 公众号 GIF 最宽 1080，录太宽只是白占硬盘和编码器
const SEGMENT_SEC = 0.5;
const MIN_REGION = 64; // 区域最小边（点）
const NEAR_END = 15; // 最后多少秒进度条尾巴变红
const LONG_SEG = 30; // 高保真时一段超过多少秒提醒（每秒 10 帧就是 300 帧，公众号上限）；锁了帧率的是 300 ÷ 帧率

/** 屏幕中间一块（宽高各一半）：第一次录、或换了屏幕时用（10-22 试用反馈） */
export function defaultRegion(db) {
  const w = Math.max(MIN_REGION, Math.round(db.width / 2));
  const h = Math.max(MIN_REGION, Math.round(db.height / 2));
  return { x: Math.round((db.width - w) / 2), y: Math.round((db.height - h) / 2), w, h };
}
/** 记下的框收进这块屏幕（分辨率改小了也不出屏幕）；认不出来就 null */
export function fitRegion(r, db) {
  if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return null;
  const w = Math.min(db.width, Math.max(MIN_REGION, Math.round(r.w)));
  const h = Math.min(db.height, Math.max(MIN_REGION, Math.round(r.h)));
  return { x: Math.min(db.width - w, Math.max(0, Math.round(r.x))), y: Math.min(db.height - h, Math.max(0, Math.round(r.y))), w, h };
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export class Recorder extends EventEmitter {
  /**
   * helperPath：小助手（Swift 编出来的程序；以 .mjs 结尾的是测试用的假小助手，用 Electron 当 Node 跑）。
   * preload / rendererDir：界面用的 preload 和页面目录。clipsRoot：片段放哪（每次录屏一个以开录时刻命名的子文件夹）。
   * run / ffmpeg：引擎 tools.js 的 run 和 ffmpeg 路径。getSettings()：{ autoCompress, marking（录屏打标，11.12）, fps（录制帧率，11.13）, hotkeys: { rec, mark }, hotkeyText: { rec, mark } }。
   */
  constructor({ helperPath, preload, rendererDir, clipsRoot, run, ffmpeg, getSettings = () => ({}), saveRegion = () => {}, log = console.log, maxSec = MAX_SEC }) {
    super();
    // saveRegion(区域)：开录时记下这次的框，下次（重启后也算）直接用（10-22 试用反馈）；getSettings().recRegion 是记下的那个
    Object.assign(this, { helperPath, preload, rendererDir, clipsRoot, run, ffmpeg, getSettings, saveRegion, log, maxSec });
    this.state = 'idle';
    this.helper = null;
    this.helperReady = null;
    this.picked = null; // 小助手这次运行里选好的屏幕或窗口（小助手退出就没了，要重选）
    this.region = null; // 选中那块屏幕里的一块（点，相对这块屏幕左上角）；null = 整个屏幕
    this.regionDisplay = null;
    this.capture = null; // 小助手报的录制尺寸
    this.session = null;
    this.win = { region: null, outline: null, bar: null };
    this.waiters = [];
    this.markWaiters = [];
    this.tick = null;
    this.message = '';
    this.hotkeyOk = { rec: null, mark: null };
    this.markAccel = null; // 切一刀现在注册着的键（录制中才有）
  }

  // ---------- 小助手 ----------
  ensureHelper() {
    if (this.helper) return this.helperReady;
    const isScript = /\.m?js$/.test(this.helperPath);
    const h = isScript
      ? spawn(process.execPath, [this.helperPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      : spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.helper = h;
    this.picked = null;
    this.helperReady = new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        reject(new Error('录屏小助手 10 秒没启动起来，再按一次试试'));
        // 卡住的小助手杀掉、清掉，下次录屏重新起一个（10-20 审查 B3：原来一直指着它，之后每次都报同一个错，要重启 App）
        if (this.helper === h) {
          this.helper = null;
          this.picked = null;
        }
        h.kill();
        setTimeout(() => { if (h.exitCode === null && h.signalCode === null) h.kill('SIGKILL'); }, 1000);
      }, 10000);
      this.once('helper-ready', () => {
        clearTimeout(to);
        resolve();
      });
      h.once('exit', () => {
        clearTimeout(to);
        reject(new Error('录屏小助手一启动就退出了'));
      });
    });
    this.helperReady.catch(() => {});
    readline.createInterface({ input: h.stdout }).on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        this.log('录屏小助手的输出看不懂：', line.slice(0, 200));
        return;
      }
      this.onEvent(ev);
    });
    h.stderr.on('data', (d) => this.log(String(d).trim()));
    h.on('error', (e) => this.log('录屏小助手启动失败：', e.message));
    h.on('exit', (code) => {
      if (this.helper === h) {
        this.helper = null;
        this.picked = null;
      }
      if (this.state !== 'idle') this.fail(`录屏小助手退出了（${code}）`);
    });
    return this.helperReady;
  }

  send(obj) {
    if (this.helper?.stdin.writable) this.helper.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  waitEvent(pred, ms) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        if (!this.waiters.includes(w)) return;
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`等了 ${ms / 1000} 秒`));
      }, ms);
    });
  }

  onEvent(ev) {
    for (const w of [...this.waiters]) {
      if (w.pred(ev)) {
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(ev);
      }
    }
    switch (ev.ev) {
      case 'ready':
        this.emit('helper-ready');
        break;
      case 'picked':
        this.picked = ev;
        if (this.state === 'picking') this.afterPick();
        break;
      case 'pick-cancelled':
        if (this.state === 'picking') this.reset();
        break;
      case 'capturing':
        this.capture = { width: ev.width, height: ev.height, fps: ev.fps };
        break;
      case 'started':
        this.onStarted();
        break;
      case 'segment':
        this.onSegment(ev);
        break;
      case 'stats':
        if (this.session) this.session.stats = ev;
        break;
      case 'mark': {
        const w = this.markWaiters.shift();
        if (w) w(ev.t);
        break;
      }
      case 'error':
        this.log('录屏小助手报错：', ev.where, ev.msg);
        if (ev.where === 'stream' && this.state === 'recording') {
          this.message = '录制被系统打断了（选的窗口关了，或者在系统的录屏菜单里点了停止），已录的部分照常切片段';
          this.stop();
        } else if (['pick', 'start', 'writer'].includes(ev.where) && this.state !== 'idle' && this.state !== 'stopping') {
          this.fail(`录屏出错：${ev.msg}`);
        }
        break;
      default:
    }
  }

  // ---------- 流程 ----------
  /** ⌃⌥R：没在录就开始选；拖区域时等于回车（确定这一块）；准备好了就开录；在录就停。 */
  toggle() {
    if (this.state === 'idle') return this.begin();
    if (this.state === 'region') return this.win.region?.webContents.executeJavaScript('window.__confirm && window.__confirm()').catch(() => {});
    if (this.state === 'armed') return this.start();
    if (this.state === 'recording') return this.stop();
    return undefined;
  }

  async begin() {
    if (this.state !== 'idle') return;
    this.message = '';
    this.state = 'picking';
    this.emit('begin'); // 主进程：主界面开着就先收起来，免得挡住要录的画面（作者）
    this.emitState();
    try {
      await this.ensureHelper();
    } catch (e) {
      this.fail(e.message);
      return;
    }
    if (this.picked) this.afterPick();
    else this.send({ cmd: 'pick' });
  }

  /** 换屏幕或窗口：再弹一次系统选择窗口。 */
  repick() {
    if (!['region', 'armed'].includes(this.state)) return;
    this.closeWindows();
    this.state = 'picking';
    this.emitState();
    this.send({ cmd: 'pick' });
  }

  afterPick() {
    // 选了屏幕：直接到「准备好」，用上次的框（作者：「录屏的选区域感觉多余了，后面都可以调大小，选区域的环节可以去掉」）
    if (this.picked.kind === 'display') this.armWithRegion();
    else this.arm();
  }

  /** 准备好，框用上次的：这次运行里用过的 > 设置里记下的（同一块屏幕、或屏幕大小一样）> 屏幕中间一块；超出屏幕的收进来 */
  armWithRegion() {
    const d = this.pickedDisplay();
    this.regionDisplay = d;
    const saved = this.getSettings().recRegion;
    const cand = this.region && this.regionDisplayId === d.id ? this.region
      : saved && (saved.displayId === d.id || (saved.dw === d.bounds.width && saved.dh === d.bounds.height)) ? saved : null;
    this.region = fitRegion(cand, d.bounds) || defaultRegion(d.bounds);
    this.regionDisplayId = d.id;
    this.arm();
  }

  pickedDisplay() {
    return screen.getAllDisplays().find((d) => d.id === this.picked?.displayID)
      || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  showRegion() {
    this.closeWindows();
    this.state = 'region';
    const d = this.pickedDisplay();
    this.regionDisplay = d;
    if (this.region && this.regionDisplayId !== d.id) this.region = null;
    const w = this.panel(d.bounds, 'region.html', { focusable: true });
    this.win.region = w;
    w.once('ready-to-show', () => {
      w.show();
      w.focus();
    });
    this.emitState();
  }

  /** 区域层交回来的一块（点，相对这块屏幕）；null = 整个屏幕。 */
  setRegion(rect) {
    if (this.state !== 'region') return;
    const d = this.regionDisplay || this.pickedDisplay();
    if (rect) {
      const x = Math.max(0, Math.round(rect.x));
      const y = Math.max(0, Math.round(rect.y));
      const w = Math.min(d.bounds.width - x, Math.round(rect.w));
      const h = Math.min(d.bounds.height - y, Math.round(rect.h));
      if (w < MIN_REGION || h < MIN_REGION) return;
      this.region = { x, y, w, h };
    } else this.region = null;
    this.regionDisplayId = d.id;
    this.arm();
  }

  arm() {
    this.closeWindows();
    this.state = 'armed';
    this.showOutline(); // 录制框（底边就是进度）：选了一块、整个屏幕、单个窗口都有
    this.showBar();
    this.emitState();
  }

  /** 录的那块在整个桌面上的位置（点）。选窗口的用窗口的位置。 */
  targetBounds() {
    if (this.picked?.kind === 'window' && this.picked.windowFrame) {
      const f = this.picked.windowFrame;
      return { x: f.x, y: f.y, width: f.w, height: f.h };
    }
    const d = this.regionDisplay || this.pickedDisplay();
    if (!this.region) return d.bounds;
    return { x: d.bounds.x + this.region.x, y: d.bounds.y + this.region.y, width: this.region.w, height: this.region.h };
  }

  /**
   * 录制框（作者定：「四个框做成一体化，采用黑色边框+底部4px黑框+2px浅青色进度条」）：窗口比区域左右上各大 3 像素、下面大 5 像素，
   * 框画在区域外面；整个屏幕时窗口就是屏幕大小，框收进屏幕边。鼠标穿透、开了内容保护，不进画面。
   */
  /** 录制框窗口的位置：录制区域左右上各大 3 像素、下面大 5 像素，不出屏幕。 */
  outlineBounds(b = this.targetBounds()) {
    const d = screen.getDisplayMatching(b).bounds;
    const x = Math.max(d.x, b.x - 3);
    const y = Math.max(d.y, b.y - 3);
    const r = Math.min(d.x + d.width, b.x + b.width + 3);
    const btm = Math.min(d.y + d.height, b.y + b.height + 5);
    return { x, y, width: r - x, height: btm - y };
  }

  showOutline() {
    this.win.outline = this.panel(this.outlineBounds(), 'recframe.html', { clickThrough: true });
    this.win.outline.once('ready-to-show', () => this.win.outline?.showInactive());
  }

  /** 胶囊的位置：右边和录制框对齐；框上面放不下就放进框里右上角（开了内容保护，不进画面）。 */
  barPlace(b = this.targetBounds(), width = 420) {
    const H = 34;
    const wa = screen.getDisplayMatching(b).workArea;
    this.capRight = Math.min(b.x + b.width + 3, wa.x + wa.width - 4);
    let y = b.y - 3 - 4 - H;
    if (y < wa.y) y = Math.max(wa.y, b.y) + 8;
    return { x: Math.max(wa.x + 4, this.capRight - width), y, width, height: H };
  }

  /** 录制框右上角外面的小胶囊（作者选）：宽度由页面按内容报上来（fitBar）。 */
  showBar() {
    this.win.bar = this.panel(this.barPlace(), 'recbar.html', {});
    this.win.bar.once('ready-to-show', () => this.win.bar?.showInactive());
  }

  /**
   * 开录前按住控制条（胶囊）空白处拖：整个框跟着走，不出这块屏幕（10-22 试用反馈，作者选「B 拖控制条带着框走」）。
   * 只在准备好、选的是屏幕时能拖；胶囊跟着框挪，所以鼠标一直在胶囊上。
   */
  barAction(a) {
    if (a.act === 'bar-drag-end') {
      if (this.barDrag) this.emitState();
      this.barDrag = null;
      return;
    }
    if (this.state !== 'armed' || this.picked?.kind !== 'display' || !this.win.outline || this.win.outline.isDestroyed()) return;
    if (a.act === 'bar-drag-start') {
      if (Number.isFinite(a.sx) && Number.isFinite(a.sy)) this.barDrag = { sx: a.sx, sy: a.sy, b0: this.targetBounds() };
      return;
    }
    const bd = this.barDrag;
    if (a.act !== 'bar-drag' || !bd || !Number.isFinite(a.sx) || !Number.isFinite(a.sy)) return;
    const d = (this.regionDisplay || this.pickedDisplay()).bounds;
    const { width: w, height: h } = bd.b0;
    const x = Math.min(d.x + d.width - w, Math.max(d.x, bd.b0.x + (a.sx - bd.sx)));
    const y = Math.min(d.y + d.height - h, Math.max(d.y, bd.b0.y + (a.sy - bd.sy)));
    this.region = { x: Math.round(x - d.x), y: Math.round(y - d.y), w: Math.round(w), h: Math.round(h) };
    const b = this.targetBounds();
    this.win.outline.setBounds(this.outlineBounds(b));
    if (this.win.bar && !this.win.bar.isDestroyed()) {
      const cur = this.win.bar.getBounds();
      this.win.bar.setBounds(this.barPlace(b, cur.width));
    }
  }

  /**
   * 开录前拖录制框的边、角改大小（作者：「确认选框后，是不能拖动边框改变了吗？」）。页面发来鼠标在屏幕上的位置，
   * 这里算出新的录制区域，挪框和胶囊。只在准备好、选的是屏幕时能拖；开录后锁住（录到一半改区域，录像尺寸前后接不上）。
   */
  frameAction(a) {
    const ok = this.state === 'armed' && this.picked?.kind === 'display' && this.win.outline && !this.win.outline.isDestroyed();
    if (a.act === 'frame-hover') {
      if (this.win.outline && !this.win.outline.isDestroyed()) {
        if (ok && a.on) this.win.outline.setIgnoreMouseEvents(false);
        else this.win.outline.setIgnoreMouseEvents(true, { forward: true });
      }
      return;
    }
    if (!ok) return;
    if (a.act === 'frame-drag-start') {
      this.frameDrag = { edge: String(a.edge || ''), sx: a.sx, sy: a.sy, b0: this.targetBounds() };
      return;
    }
    if (a.act === 'frame-drag-end') {
      this.frameDrag = null;
      this.emitState();
      return;
    }
    const fd = this.frameDrag;
    if (a.act !== 'frame-drag' || !fd || !Number.isFinite(a.sx) || !Number.isFinite(a.sy)) return;
    const d = (this.regionDisplay || this.pickedDisplay()).bounds;
    const dx = a.sx - fd.sx;
    const dy = a.sy - fd.sy;
    let x1 = fd.b0.x;
    let y1 = fd.b0.y;
    let x2 = fd.b0.x + fd.b0.width;
    let y2 = fd.b0.y + fd.b0.height;
    if (fd.edge.includes('w')) x1 = Math.min(x2 - MIN_REGION, Math.max(d.x, x1 + dx));
    if (fd.edge.includes('e')) x2 = Math.max(x1 + MIN_REGION, Math.min(d.x + d.width, x2 + dx));
    if (fd.edge.includes('n')) y1 = Math.min(y2 - MIN_REGION, Math.max(d.y, y1 + dy));
    if (fd.edge.includes('s')) y2 = Math.max(y1 + MIN_REGION, Math.min(d.y + d.height, y2 + dy));
    this.region = { x: Math.round(x1 - d.x), y: Math.round(y1 - d.y), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
    this.regionDisplayId = (this.regionDisplay || this.pickedDisplay()).id;
    const b = this.targetBounds();
    this.win.outline.setBounds(this.outlineBounds(b));
    if (this.win.bar && !this.win.bar.isDestroyed()) {
      const cur = this.win.bar.getBounds();
      this.win.bar.setBounds(this.barPlace(b, cur.width));
    }
  }

  /** 浮在最上面（全屏的浏览器、游戏上面也有）、不进画面的透明窗口。 */
  panel(bounds, page, { focusable = false, clickThrough = false } = {}) {
    const w = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      type: 'panel',
      roundedCorners: false, // macOS 无边框窗口默认是圆角，会把录制框的四个角裁掉（作者：「四个角为啥是透明的」）
      focusable,
      enableLargerThanScreen: true,
      backgroundColor: '#00000000',
      webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.setContentProtection(true);
    if (clickThrough) w.setIgnoreMouseEvents(true, { forward: true }); // 不挡鼠标，但鼠标移动照样转给页面（录制框要知道鼠标到没到框线附近）
    w.webContents.on('did-finish-load', () => this.pushState(w));
    w.loadFile(path.join(this.rendererDir, page));
    return w;
  }

  /** 胶囊按内容调宽，右边贴着录制框不动；同一个状态里只变宽（小幅变窄不跟，免得跟着秒数抖），换了状态可以变窄。 */
  fitBar(w, state) {
    const bar = this.win.bar;
    if (!bar || bar.isDestroyed() || !Number.isFinite(w)) return;
    const b = bar.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const want = Math.min(wa.width - 8, Math.max(120, Math.ceil(w)));
    if (want === b.width) return;
    if (state === this.barState && want < b.width) return;
    this.barState = state;
    const right = this.capRight ?? b.x + b.width;
    bar.setBounds({ x: Math.max(wa.x + 4, right - want), y: b.y, width: want, height: b.height });
  }

  closeWindows() {
    this.barState = null;
    for (const k of Object.keys(this.win)) {
      const w = this.win[k];
      this.win[k] = null;
      if (w && !w.isDestroyed()) w.destroy();
    }
  }

  async start() {
    if (this.state !== 'armed') return;
    const id = stamp();
    let tmp;
    try {
      tmp = await mkdtemp(path.join(os.tmpdir(), 'gifkit-rec-'));
    } catch (e) {
      this.fail(`建临时文件夹失败：${e.message}`);
      return;
    }
    const root = typeof this.clipsRoot === 'function' ? this.clipsRoot() : this.clipsRoot; // 设置里能换（10-22 试用反馈 9.6b），每次开录时取
    const fps = normRecFps(this.getSettings().fps);
    this.session = { id, tmp, dir: path.join(root, id), segs: [], init: false, bytes: 0, cuts: [], stopped: false, startedAt: null, stats: null, fps };
    this.state = 'starting';
    this.capture = null;
    this.frameDrag = null;
    this.win.outline?.setIgnoreMouseEvents(true, { forward: true }); // 开录后框锁住、不挡鼠标
    this.holdMarkKey();
    this.emitState();
    const rect = this.picked.kind === 'display' ? this.region : null;
    if (rect) {
      const db = (this.regionDisplay || this.pickedDisplay()).bounds;
      this.saveRegion({ ...rect, displayId: this.regionDisplayId, dw: db.width, dh: db.height });
    }
    this.send({ cmd: 'start', dir: tmp, rect, fps, maxWidth: MAX_WIDTH, codec: 'h264', segment: SEGMENT_SEC, cursor: false });
    try {
      await this.waitEvent((e) => e.ev === 'started', 15000);
    } catch (e) {
      if (this.state === 'starting') this.fail(`录屏没开始（${e.message}）`);
    }
  }

  onStarted() {
    if (this.state !== 'starting' || !this.session) return;
    this.state = 'recording';
    this.session.startedAt = Date.now();
    clearInterval(this.tick);
    this.tick = setInterval(() => {
      // 到 90 秒自动停（作者：固定时长，想录更多就录第二次）
      if (this.state === 'recording' && (Date.now() - this.session.startedAt) / 1000 >= this.maxSec) {
        this.message = `到 ${this.maxSec} 秒了，自动停`;
        this.stop();
        return;
      }
      this.emitState();
    }, 250);
    this.emitState();
  }

  /** ⌥空格：在这里切一刀（时刻和画面用同一个时钟，小助手报的为准）。离开头或上一刀不到 0.5 秒的不算（手抖连按；和停录后分段同一个数）。 */
  async mark() {
    if (this.state !== 'recording' || !this.getSettings().marking) return;
    const t = await new Promise((resolve) => {
      this.markWaiters.push(resolve);
      this.send({ cmd: 'mark' });
      setTimeout(() => {
        // 3 秒没回音就算了；把这个等待从队列里拿掉，免得下一次打标拿到这一次迟到的回答
        this.markWaiters = this.markWaiters.filter((w) => w !== resolve);
        resolve(null);
      }, 3000);
    });
    const s = this.session;
    if (t == null || !s || s.stopped || this.state !== 'recording') return;
    const last = s.cuts.length ? s.cuts.at(-1) : 0;
    if (t - last < MIN_CUT_GAP) return;
    s.cuts.push(t);
    this.emitState();
  }

  onSegment(ev) {
    const s = this.session;
    if (!s) return;
    if (ev.type === 'init') s.init = true;
    else if (typeof ev.start === 'number') {
      s.segs.push({ file: ev.file, start: ev.start, dur: ev.dur });
      s.bytes += ev.bytes || 0;
    }
  }

  async stop() {
    if (this.state !== 'recording') return; // 还在「正在开始」时不停：第一帧到了再停，免得小助手那边刚开起来就没人管
    const s = this.session;
    this.state = 'stopping';
    clearInterval(this.tick);
    this.releaseMarkKey();
    this.emitState();
    this.send({ cmd: 'stop' });
    let st = null;
    try {
      st = await this.waitEvent((e) => e.ev === 'stopped', 20000);
    } catch {
      this.log('等停录超时，按已经写好的块切');
    }
    if (s) {
      s.stopped = true;
      const total = coveredUntil(s.segs);
      let file = null;
      let ranges = [];
      if (s.init && s.segs.length) {
        try {
          await mkdir(s.dir, { recursive: true });
          file = path.join(s.dir, '录屏.mp4');
          await assembleClip({ dir: s.tmp, segs: [...s.segs].sort((a, b) => a.start - b.start), out: file, run: this.run, ffmpeg: this.ffmpeg, fps: s.fps });
          ranges = splitRanges(total, s.cuts).map((r, i) => ({ n: i + 1, start: Math.round(r.from * 100) / 100, end: Math.round(r.to * 100) / 100 }))
            .map((r) => ({ ...r, label: rangeLabel(s.id, r.n, r.start, r.end) }));
        } catch (e) {
          this.log('拼整段录像失败：', e.message);
          this.message = `拼录像失败：${e.message}`;
          file = null;
        }
      }
      await rm(s.tmp, { recursive: true, force: true }).catch(() => {});
      this.emit('session-done', { id: s.id, dir: s.dir, file, ranges, seconds: total, cuts: s.cuts.length, frames: st?.frames ?? null, dropped: st?.dropped ?? null, fps: s.fps, message: this.message });
    }
    this.session = null;
    this.reset();
  }

  /**
   * 退出 App 前（10-20 审查 B1：原来只叫小助手退出，这次录的全丢、临时分段也不清）：正在录的照常停录、拼好整段（进列表由主进程管）；
   * 正在停的等它拼完；还在「正在开始」的放弃（还没录到东西）、删掉临时文件；选区域、准备好的直接收起。最多等 maxMs。
   */
  async finishForQuit(maxMs = 30000) {
    if (this.state === 'recording') {
      this.message = '退出 App 前停了录屏，录到的已切好放进列表';
      this.stop();
    } else if (this.state === 'starting') this.fail('退出 App，录屏还没开始就停了');
    else if (['picking', 'region', 'armed'].includes(this.state)) this.reset();
    const t0 = Date.now();
    while (this.state !== 'idle' && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 100));
    await this.cleaning;
  }

  /** 取消（选择、拖区域、准备好时）。在录的不取消，要停用 stop。 */
  cancel() {
    if (['picking', 'region', 'armed'].includes(this.state)) this.reset();
  }

  reset() {
    clearInterval(this.tick);
    this.tick = null;
    this.releaseMarkKey();
    this.closeWindows();
    this.state = 'idle';
    this.emitState();
  }

  fail(msg) {
    this.log('录屏：', msg);
    const s = this.session;
    this.session = null;
    if (s) this.send({ cmd: 'stop' }); // 万一小助手那边已经开录了，叫它停下
    if (s?.tmp) this.cleaning = rm(s.tmp, { recursive: true, force: true }).catch(() => {}); // 退出前要等它删完（finishForQuit）
    this.reset();
    this.emit('failed', msg);
  }

  /** 界面上的一个动作（区域层、控制条、菜单栏面板发来的）。 */
  action(a = {}) {
    switch (a.act) {
      case 'toggle': return this.toggle();
      case 'start': return this.start();
      case 'stop': return this.stop();
      case 'mark': return this.mark();
      case 'cancel': return this.cancel();
      case 'repick': return this.repick();
      case 'region': return this.setRegion(a.rect || null);
      case 'reregion': if (this.state === 'armed' && this.picked?.kind === 'display') this.showRegion(); return undefined;
      case 'auto': this.emit('set-auto', Boolean(a.on)); return this.emitState();
      case 'mark-toggle': this.emit('set-mark', Boolean(a.on)); return this.emitState(); // 11.12 打标开关：主进程存设置、三处同步
      case 'fps-set': this.emit('set-fps', normRecFps(a.fps)); return this.emitState(); // 11.13 录制帧率：主进程存设置，胶囊和设置页同步
      case 'bar-size': return this.fitBar(a.w, a.state);
      case 'frame-hover':
      case 'frame-drag-start':
      case 'frame-drag':
      case 'frame-drag-end': return this.frameAction(a);
      case 'bar-drag-start':
      case 'bar-drag':
      case 'bar-drag-end': return this.barAction(a);
      default: return undefined;
    }
  }

  // ---------- 给界面的状态 ----------
  view() {
    const s = this.session;
    const elapsed = s?.startedAt ? (Date.now() - s.startedAt) / 1000 : 0;
    const d = this.regionDisplay || (this.picked?.kind === 'display' ? this.pickedDisplay() : null);
    const cuts = s?.cuts || [];
    const segStart = cuts.length ? cuts.at(-1) : 0;
    const fps = s?.fps ?? normRecFps(this.getSettings().fps); // 录的时候用开录时定下的
    return {
      state: this.state,
      kind: this.picked?.kind || null,
      target: this.picked?.kind === 'window' ? `${this.picked.app || ''}${this.picked.title ? `「${this.picked.title}」` : ''}` : '屏幕',
      display: d ? { width: d.bounds.width, height: d.bounds.height, scale: d.scaleFactor } : null,
      region: this.region,
      maxWidth: MAX_WIDTH,
      capture: this.capture,
      maxSec: this.maxSec,
      nearEnd: NEAR_END,
      fps,
      longSeg: fps < HIFI_FPS ? 300 / fps : LONG_SEG,
      elapsed,
      cuts,
      segment: cuts.length + 1, // 正在录第几段
      segLen: Math.max(0, elapsed - segStart),
      frames: s?.stats?.frames ?? null,
      dropped: s?.stats?.dropped ?? null,
      bytes: s?.bytes || 0,
      hotkeys: { ...HOTKEY_TEXT, ...(this.getSettings().hotkeyText || {}), recOk: this.hotkeyOk.rec, markOk: this.hotkeyOk.mark },
      auto: Boolean(this.getSettings().autoCompress),
      mark: Boolean(this.getSettings().marking), // 11.12 录屏打标开着才写「⌥空格 切」、第几段
      message: this.message,
    };
  }

  /** 开录时占上切一刀的键（设置里换过就用换的，10-22 设置卷）；打标关着不占（11.12，关着时别的程序照常用 ⌥空格） */
  holdMarkKey() {
    if (!this.getSettings().marking) {
      this.hotkeyOk.mark = null;
      this.markAccel = null;
      return;
    }
    const k = this.getSettings().hotkeys?.mark || HOTKEY_MARK;
    this.hotkeyOk.mark = globalShortcut.register(k, () => this.mark());
    this.markAccel = this.hotkeyOk.mark ? k : null;
    this.log(`切一刀的键 ${k}${this.hotkeyOk.mark ? '' : ' 注册不上'}`);
  }

  /** 停录时放掉切一刀的键 */
  releaseMarkKey() {
    if (this.markAccel) globalShortcut.unregister(this.markAccel);
    this.markAccel = null;
  }

  /** 打标开关改了（11.12）：录制中马上占上或放掉切一刀的键（已经切的刀照旧保留）；平时只刷新胶囊上的字 */
  refreshMarking() {
    if (['starting', 'recording'].includes(this.state)) {
      if (this.getSettings().marking && !this.markAccel) this.holdMarkKey();
      else if (!this.getSettings().marking && this.markAccel) this.releaseMarkKey();
    }
    this.emitState();
  }

  /** 设置里换了切一刀的键：录制中就马上换成新的；平时没占着，下次开录按新的注册 */
  refreshMarkKey() {
    if (!this.markAccel) return;
    this.releaseMarkKey();
    this.holdMarkKey();
    this.emitState();
  }

  pushState(w) {
    if (w && !w.isDestroyed()) w.webContents.send('rec-state', this.view());
  }

  emitState() {
    const v = this.view();
    for (const w of Object.values(this.win)) if (w && !w.isDestroyed()) w.webContents.send('rec-state', v);
    this.emit('state', v);
  }

  quit() {
    if (this.helper) {
      this.send({ cmd: 'quit' });
      const h = this.helper;
      setTimeout(() => { if (h.exitCode === null) h.kill(); }, 1000);
    }
  }
}
