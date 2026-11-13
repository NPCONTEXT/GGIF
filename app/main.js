// 主进程：菜单栏图标 + 小面板（拖入即压、结果拖出）+ 完整界面窗口，引擎功能通过 IPC 交给界面。引擎在 ../engine（开发时的目录结构）。
// 调试：GIFKIT_OPEN=<文件> 启动后直接打开这个文件；GIFKIT_SHOT=<png> 等界面算完预估后截图并退出（我自己看界面用）；GIFKIT_PANEL=1 截图前展开体积下拉面板；
//       GIFKIT_TRAY_DROP=<文件|文件> 启动后当作拖到菜单栏图标上；GIFKIT_TRAY_SHOT=<png> 队列跑完后给小面板截图并退出。
import { app, BrowserWindow, ipcMain, dialog, shell, Tray, nativeImage, Notification, Menu, clipboard, screen, globalShortcut } from 'electron';
import { existsSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, stat, readFile, rename, mkdir, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Library, MEDIA_EXT, friendlyError } from './library.js';
import { Recorder } from './recorder.js';
import { staleTempDirs } from './tempclean.js';
import { rangeLabel, recPrefix, segLabel, joinLabel, normRecFps, fitSecFor, HIFI_FPS } from './rec-clips.js';
import { Hotkeys, SPEED_IDS, normalizePrefs } from './prefs.js';
import { OpLog, remember } from './oplog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// 10-22 改名 GGIF（作者定：GG + GIF，「终结公众号 GIF 压缩难题」）。装好的包照旧用原来「GIF工具」的数据文件夹：
// 列表、设置都在里面，改名不丢（名字一改，默认会换成「GGIF」文件夹、列表就空了）
// 判断装好的包用 process.defaultApp（开发时 `electron .` 启动才是 true）：app.isPackaged 看的是可执行文件名，
// 我们的包留着 Electron 这个名字（Electron 按它找 helper），isPackaged 永远是 false（10-22 装包试压时新建了「GGIF」文件夹才发现）
// Windows版（11-08）：一期（压缩版）不做录屏；数据文件夹叫 GGIF（Windows 没装过改名前的老版，作者定的名字）；
// 只开一个 GGIF，第二次打开带的文件交给第一个；通知要应用编号（和 Mac 包的 BUNDLE_ID、Windows 安装包的 appId 一样）
const WIN = process.platform === 'win32';
const CAN_RECORD = !WIN;
const APP_ID = 'local.gifkit.app';
const PAGE_OPTS = WIN ? { query: { plat: 'win32' } } : undefined; // 页面靠网址里的 ?plat=win32 认 Windows（preload、hotkeys.cjs）
if (!process.defaultApp) app.setPath('userData', path.join(app.getPath('appData'), WIN ? 'GGIF' : 'GIF工具'));
if (WIN && !app.requestSingleInstanceLock()) app.exit(0);
if (WIN) app.setAppUserModelId(APP_ID);
// 录屏、粘贴的片段放哪：新的放「下载/GGIF录屏」「下载/GGIF粘贴」；改名前录的还在「下载/GIF工具录屏」，照样认作工具自己录的
// 10-22 试用反馈 9.6b：设置里「录像放在」能换（prefs.recDir）；GIFKIT_REC_DIR 是测试用的、最优先；GIFKIT_REC_DEFAULT 换掉默认的（测「文件夹不在了」用，免得写进真的下载文件夹）
const REC_DEFAULT = () => process.env.GIFKIT_REC_DEFAULT || path.join(app.getPath('downloads'), 'GGIF录屏');
const REC_ROOT = () => process.env.GIFKIT_REC_DIR || prefs.recDir || REC_DEFAULT();
/** 现在录像放哪：设置里选的文件夹不在了（外接硬盘没接、删了），先放默认的「下载/GGIF录屏」 */
const recRootNow = () => (process.env.GIFKIT_REC_DIR || !prefs.recDir || isDir(prefs.recDir) ? REC_ROOT() : REC_DEFAULT());
/** 给人看的位置：「下载/GGIF录屏」；不在下载里就写「~/…」 */
const placeText = (d) => {
  const dl = app.getPath('downloads');
  const r = path.relative(dl, d);
  return !r.startsWith('..') && !path.isAbsolute(r) ? `下载${r ? `/${r}` : ''}` : d.replace(os.homedir(), '~');
};
const REC_ROOT_OLD = () => path.join(app.getPath('downloads'), 'GIF工具录屏');
const ENGINE = path.resolve(here, '..', 'engine', 'src');
// 动态 import 要给 file:// 网址（Windows版 11-08 云端查出）：Windows 的 C:\ 绝对路径会被当成「c:」协议直接报错，主进程一启动就挂在报错框上；
// Mac 的 /Users/… 能直接用，换成网址也一样
const engine = (f) => import(pathToFileURL(path.join(ENGINE, f)).href);
const { probe, colorPlan } = await engine('probe.js');
const { proxyFromSource, estimateFromProxy } = await engine('estimate.js');
const { convertFile, resolvePreset, safeOutputPath, outputBase } = await engine('convert.js');
const { joinRanges, joinedDur } = await engine('frames.js'); // 11.14 多选导出：几段拼成一张
const { PRESETS, DEFAULT_PRESET, SKIP_RATIO, FIT_RATIO, QUALITY_FLOOR, defaultLadder } = await engine('presets.js');
const { missingTools, TOOLS, run } = await engine('tools.js');
const { batch, expandInputs } = await engine('batch.js');
const { checkGif } = await engine('check.js');
const { gifSummary } = await engine('gif.js');
const { checkInputLimits, allowOwnRecordings } = await engine('limits.js');

let win; // 完整界面
let pop; // 菜单栏小面板
let tray;
let trayPreset = DEFAULT_PRESET; // 拖到菜单栏图标上用哪个用途
let trayDual = false; // 「两种都要」：同时出 9.9 和 4.8 两版（默认关，赶稿时开；作者方案）
let recAuto = false; // 录屏「录完自动全部压缩」（默认关，录屏卷方案 §八）
let recMark = false; // 录屏打标（11.12，作者：默认关）：关着整段一份、不占 ⌥空格；开着录的时候能切。录制胶囊、菜单栏顶上、设置三处是同一个
// 录屏的一段多长以内才自动压：最低每秒 8 帧（引擎默认档位的最低帧率）还不超过 300 帧，即 37.5 秒；更长的一定压不进，留成「待压缩」等用户在主界面挑一段（11.12）
const MAX_FRAMES = Math.min(...Object.values(PRESETS).map((p) => p.maxFrames));
const AUTO_FIT_SEC = MAX_FRAMES / Math.min(...defaultLadder(1920).map((t) => t.fps));
// 录制帧率（11.13，作者定）：高保真 60（默认，导出照旧自动选）或 30 / 15 / 10 / 5（选了就锁）。录制胶囊、设置两处是同一个，记住上次选的
let recFps = HIFI_FPS;
const fitSecOf = (fps) => fitSecFor(fps, MAX_FRAMES, AUTO_FIT_SEC); // 锁了帧率的录像，一段最长 300 ÷ 帧率 秒
let timelineOpen = false; // 主界面时间轴展开着（作者选「重启后也记住（推荐）」；默认收起成打标条）
let prefs = normalizePrefs({}); // 设置那层的各项（10-22 设置卷，prefs.js）：快捷键、通知、凑帧、记住、启动时开不开主界面、停在哪页
const hkText = (w) => Hotkeys.toText(prefs.hotkeys[w]);
let oplog = null; // 操作日志（第二批，oplog.js）：启动时按设置打开
let readyAt = 0; // 启动完成的时刻：刚启动那一下系统发的「激活」不当成用户点了程序图标
let openedWithFiles = false; // 是被双击 GIF 启动的：只在后台压，不开完整界面
const pendingOpen = []; // 启动完成前收到的「打开文件」
let dragging = false; // 正在从小面板往外拖文件时，小面板失焦也不收起
let workDir; // 「实时真编」的结果、GIF 的低分辨率预览放这里，退出时删（10-31 起预估不再往这里写原始帧）
const workByFile = new Map();
let running = null; // 完整界面正在跑的导出 / 批量的 AbortController，「取消」按钮用
let debugAfterEdit = null; // 调试：编辑导出回写后给小面板截图
const thumbs = new Map(); // 素材 id → 缩略图 dataURL（只在内存里）
const dragIcons = new Map(); // 素材 id → 拖拽时跟着鼠标的小图

async function workFor(file, color) {
  const key = `${file}|${color || 'auto'}`;
  if (!workByFile.has(key)) {
    // 换了文件就把别的文件的取帧缓存删掉，免得一次开很多文件时临时目录越堆越大
    for (const [k, d] of workByFile) {
      if (!k.startsWith(`${file}|`)) {
        rm(d, { recursive: true, force: true });
        workByFile.delete(k);
      }
    }
    workByFile.set(key, await mkdtemp(path.join(workDir, 'f-')));
  }
  return workByFile.get(key);
}

function createWindow() {
  // 默认就开最小尺寸（作者：「我希望是精简工具，所以不要一开始就弹出巨大界面」）
  win = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 1000,
    minHeight: 680,
    title: 'GGIF',
    // 10-22 界面重做（参考应用宝）：隐藏标题栏，系统的红黄绿叠在内容左上；底色和 theme.css 的 --bg 一样，打开时不闪白
    // Windows（作者选 B）：GGIF 自己的深色顶栏到顶，右上角是 Windows 的三个键（颜色和 --bg 一样）
    ...(WIN ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1d1d25', symbolColor: '#c9c9d3', height: 32 } } : { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 24 } }),
    backgroundColor: '#1d1d25',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(here, 'renderer', 'index.html'), PAGE_OPTS);
  win.on('closed', () => {
    win = null;
    holdRecKey(false); // 正在录新快捷键时关了窗口：把「开始 / 停止」占回来
    app.dock?.hide(); // 关了完整界面就只留菜单栏图标
  });
}

/** 打开完整界面；带 load 就在界面加载好后把这个素材载进去编辑。 */
function showMain(load) {
  app.dock?.show();
  if (!win) {
    createWindow();
    if (load) win.webContents.once('did-finish-load', () => win.webContents.send('load-job', load));
  } else {
    win.show();
    win.focus();
    if (load) win.webContents.send('load-job', load);
  }
}

// ---------- 菜单栏 ----------
// 一行一个原素材，后面是各档位的版本（蓝点 9.9MB、绿点 4.8MB + 实际大小）。拖版本 = 拖出真实文件；单击版本预览；双击行编辑；其他操作只在右键。
const PRESET_IDS = Object.keys(PRESETS);
/** 这个版本的文件满不满足某档：体积、帧数、宽度都在规矩内。 */
function satisfies(v, presetId) {
  const p = PRESETS[presetId];
  // 设置里关了凑帧（10-22）：不到 61 帧也算合规（用户自己选的，读者看到 640 宽的版本），不标成不合规、能复用
  return Boolean(p && v.bytes && v.bytes <= p.limit && v.frames >= (prefs.fill ? p.minFrames : 1) && v.frames <= p.maxFrames && v.width <= p.maxWidth);
}
const lib = new Library({ runOne: runTrayVersion, satisfies, presetIds: PRESET_IDS, file: null });

async function thumbOf(file) {
  try {
    return await nativeImage.createThumbnailFromPath(file, { width: 56, height: 56 });
  } catch {
    return null;
  }
}

/** 录屏的一段：取这段开头附近的一帧当缩略图（每段不一样，好认）。 */
async function rangeThumb(g) {
  const t = g.range.start + Math.min(1, (g.range.end - g.range.start) / 2);
  const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', t.toFixed(2), '-i', g.source, '-frames:v', '1',
    '-vf', 'scale=112:112:force_original_aspect_ratio=increase,crop=112:112', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', '-']);
  return r.code === 0 && r.stdoutBuffer?.length ? nativeImage.createFromBuffer(r.stdoutBuffer) : null;
}

/**
 * 录屏段的缩略图要起 ffmpeg：排队，最多同时 2 个（10-20 审查 A7：启动、撤销时每段各起一个，几十段一起起会卡一阵）。
 * 同一行正在取的不重复取。
 */
const THUMB_JOBS = 2;
const thumbQueue = [];
const thumbBusy = new Set();
let thumbRunning = 0;
function pumpThumbs() {
  while (thumbRunning < THUMB_JOBS && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbRunning++;
    job().finally(() => {
      thumbRunning--;
      pumpThumbs();
    });
  }
}
function queueThumb(fn) {
  return new Promise((resolve) => {
    thumbQueue.push(() => fn().then(resolve, () => resolve(null)));
    pumpThumbs();
  });
}

async function makeThumb(g) {
  if (thumbs.has(g.id) || thumbBusy.has(g.id)) return;
  if (g.range) {
    thumbBusy.add(g.id);
    try {
      const img = existsSync(g.source) ? await queueThumb(() => rangeThumb(g)) : null;
      if (!img || img.isEmpty()) return;
      thumbs.set(g.id, img.toDataURL());
      dragIcons.set(g.id, img);
      lib.changed(false);
    } finally {
      thumbBusy.delete(g.id);
    }
    return;
  }
  const v = g.versions.find((x) => x.state === 'done' && x.file && existsSync(x.file));
  const src = existsSync(g.source) ? g.source : v?.file;
  if (!src) return;
  const img = await thumbOf(src);
  if (!img) return;
  thumbs.set(g.id, img.toDataURL());
  dragIcons.set(g.id, img);
  lib.changed(false);
}

async function describe(file) {
  const sum = gifSummary(await readFile(file));
  const st = await stat(file);
  // 设备号 + 文件编号：结果被改名、挪到同一块硬盘别处后按它找回（作者）
  return { file, bytes: st.size, width: sum.width, height: sum.height, frames: sum.frames, durationSec: sum.durationSec, dev: st.dev, ino: st.ino };
}

// ---------- 列表跟着文件走（作者：「本地文件移动/删除/改名等，图片列表怎么办」） ----------
/**
 * 按「设备号:编号」问 Swift 小助手这些文件现在在哪（同一块硬盘上改名、挪走都找得到）。返回 Map(编号 → 路径)，找不到的没有这一项。
 * 超时、出错、输出行数对不上就抛错（10-20 审查 B4：原来照常返回，只跑了一半的当成都没找到，文件还在也被去掉）；重查那边这次就先不动。
 */
function locateFiles(ids) {
  return new Promise((resolve, reject) => {
    const helper = recorderHelperPath();
    if (!ids.length || /\.m?js$/.test(helper) || !existsSync(helper)) return resolve(new Map());
    execFile(helper, ['locate', ...ids], { timeout: 5000 }, (err, stdout) => {
      const lines = String(stdout || '').split('\n');
      if (process.env.GIFKIT_DEBUG_LISTFS) console.log('找路径：', JSON.stringify({ helper, ids, 出错: err ? err.message : null, 输出: lines }));
      if (err) return reject(new Error(`找路径的小助手出错：${err.killed ? '超过 5 秒' : err.message}`));
      if (lines.length < ids.length) return reject(new Error(`找路径的小助手只回了 ${lines.length} 行（要 ${ids.length} 行）`));
      resolve(new Map(ids.map((id, i) => [id, lines[i]]).filter(([, p]) => p)));
    });
  });
}
/** 在不在废纸篓里（挪进废纸篓的当删掉）。GIFKIT_TRASH_DIR：测试时当作废纸篓的文件夹。 */
function isTrash(p) {
  if (WIN) return /[\\/]\$Recycle\.Bin[\\/]/i.test(p) || Boolean(process.env.GIFKIT_TRASH_DIR && p.startsWith(path.resolve(process.env.GIFKIT_TRASH_DIR) + path.sep)); // Windows 回收站：每块盘的 \$Recycle.Bin\…
  const dirs = [path.join(os.homedir(), '.Trash'), process.env.GIFKIT_TRASH_DIR].filter(Boolean).map((d) => path.resolve(d) + path.sep);
  return dirs.some((d) => p.startsWith(d) || p.startsWith(`/private${d}`)) || /\/\.Trashes\//.test(p);
}
/** 重查列表里的文件：改名、挪走的找回，删掉的去掉（面板打开、点 / 拖之前、启动后、编辑之前）。变了就推给面板。 */
let refreshing = null;
function refreshFiles() {
  if (!refreshing) {
    refreshing = lib.reconcile(locateFiles, { isTrash })
      .then((changed) => { if (changed) pushList(); return changed; })
      .catch(() => false)
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** 录屏的一段从哪到哪（主界面调过就用调过的）。 */
function rangeOf(g) {
  if (!g.range) return null;
  if (g.range.join) {
    // 拼起来的那一行（11.14 多选导出）：几段的起止（主界面调过就用调过的），start 是第一段的开头、dur 是几段之和
    const ranges = g.edit?.ranges?.length >= 2 ? g.edit.ranges : g.range.join.map((p) => ({ start: p.start, dur: Math.round((p.end - p.start) * 100) / 100 }));
    return { start: ranges[0].start, dur: joinedDur(ranges), ranges };
  }
  const start = g.edit?.dur ? g.edit.start || 0 : g.range.start;
  const dur = g.edit?.dur ? g.edit.dur : g.range.end - g.range.start;
  return { start, dur };
}

// ---------- 结果放哪（10-22 设置卷第二批；作者选「指定文件夹时合规的复制一份过去」） ----------
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
let outDirWarned = false; // 指定的文件夹不在了：这次运行只提示一次
/** 设置里指定的结果文件夹（在的话）；不在了（删了、外接硬盘没接）返回 null、结果放回原文件旁边，提示一次 */
function activeOutDir() {
  if (!prefs.outDir) return null;
  if (isDir(prefs.outDir)) return prefs.outDir;
  if (!outDirWarned) {
    outDirWarned = true;
    const text = `设置里指定的结果文件夹「${path.basename(prefs.outDir)}」不在了，这次先放回原文件旁边`;
    if (pop?.isVisible()) pop.webContents.send('tray-toast', { text, err: true });
    else notify('error', { title: '结果文件夹不在了', body: text })?.show();
    oplog?.log('结果放哪', '指定的文件夹不在了，放回原文件旁边');
  }
  return null;
}
const resultDirFor = (source) => activeOutDir() || path.dirname(source);
/** 结果名字的前半截：放进指定文件夹时，录屏的整段录像（都叫「录屏.mp4」）换成「录屏 10-22 03-14-35」，几次录屏放一起不撞名 */
function resultBase(source, dir) {
  const sid = path.basename(path.dirname(source));
  if (path.resolve(dir) !== path.resolve(path.dirname(source)) && isOwnRecordingFile(source) && /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(sid)) return `录屏 ${sid.slice(5)}`;
  return outputBase(source);
}
/** 设置里改结果放哪：null = 原文件旁边；路径要是在的文件夹。出错返回原因 */
function setOutDir(v) {
  if (v === null || v === '') prefs.outDir = null;
  else if (typeof v !== 'string' || !path.isAbsolute(v)) return '认不出这个文件夹';
  else if (!isDir(v)) return '这个文件夹不在了';
  else prefs.outDir = v;
  outDirWarned = false;
  return '';
}

/** 一段的结果文件名：「录屏_第2段_压缩.gif」（和原文件放一起）；放进指定文件夹时「录屏 10-22 03-14-35_第2段_压缩.gif」。 */
function rangeOutput(g, presetId) {
  const dir = resultDirFor(g.source);
  return safeOutputPath(path.join(dir, `${resultBase(g.source, dir)}_第${g.range.n}段${resolvePreset(presetId).fileSuffix}.gif`));
}

/** 压一个版本：GIF 按批量规则（合规的不动、帧数不够的凑帧、超标的压），视频转换；结果放原文件旁边或设置里指定的文件夹。录屏的一段按它的起止压。 */
async function runTrayVersion(g, v, { signal, onProgress }) {
  oplog?.log('压缩', '开始', { 素材: g.id, 段: g.range?.n, 档位: v.preset, 速度: v.mode, 凑帧: prefs.fill, 放进: activeOutDir() ? '指定文件夹' : '原文件旁边' });
  if (g.range) {
    const { start, dur, ranges } = rangeOf(g);
    const r = await convertFile(g.source, rangeOutput(g, v.preset), { preset: v.preset, mode: v.mode, start, dur, ranges, fill: prefs.fill, signal, onProgress, overwrite: true, ignoreByteLimit: true, ignoreDurationLimit: true });
    if (signal.aborted) throw new Error('已取消');
    if (!r.ok || !r.output) {
      if (dur > 30 || /装不下/.test(r.reason || '')) {
        throw Object.assign(new Error(`这一段 ${dur.toFixed(1)} 秒，压不进 ${(resolvePreset(v.preset).limit / 1e6).toFixed(1)}MB；双击这一行，把起止拖短一点再压`), { tooLong: true });
      }
      throw new Error(r.reason || (r.check?.problems || []).join('；') || '没做成');
    }
    Object.assign(v, await describe(r.output), { action: '压缩', isSource: false });
    return;
  }
  const r = await batch([g.source], resultDirFor(g.source), { preset: v.preset, mode: v.mode, fill: prefs.fill, keepSuffix: true, signal, onProgress });
  const it = r.items[0];
  if (signal.aborted) throw new Error('已取消');
  if (!it.ok || !it.output) {
    // 太长（每秒 10 帧超过 300 帧，或者每一档都装不下）：不算失败，是该剪短了（作者：裁剪是压缩的第三条退路）
    const dur = (await probe(g.source).catch(() => ({}))).duration || 0;
    if (dur > 30 || /装不下/.test(it.detail || '')) {
      throw Object.assign(new Error(`太长了（${dur.toFixed(1)} 秒），压不进 ${(resolvePreset(v.preset).limit / 1e6).toFixed(1)}MB；双击这一行，剪到 ${dur > 30 ? '30 秒以内' : '短一点'}再压`), { tooLong: true });
    }
    throw new Error(it.detail || '没做成');
  }
  Object.assign(v, await describe(it.output), { action: it.action, isSource: path.resolve(it.output) === path.resolve(g.source) });
}

/**
 * 拖进来的文件夹展开成里面的 GIF 和视频（只看第一层，和原来的批量页一样），只跳过隐藏文件。
 * 之前压好的「_压缩」结果不按名字跳过（作者：用户常常不知道哪些压过；合规的直接用、不重编不另存，超标的再压）。
 */
async function expandDropped(inputs) {
  const files = [];
  let folders = 0;
  for (const f of inputs) {
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      files.push(f);
      continue;
    }
    folders++;
    try {
      for (const x of await expandInputs([f])) if (!path.basename(x).startsWith('.')) files.push(x);
    } catch {}
  }
  return { files, folders };
}

/**
 * 拖进来的文件排队（文件夹先展开）。「两种都要」时先压 9.9，再压 4.8；9.9 的结果已经 ≤4.8MB 就不再编码。已有合格结果、原素材没变的直接复用。
 * 超出导入上限的在解码前拒绝（只探测一下，几十毫秒），放进 rejected 里说明原因。
 * 一次进来多个（或有文件夹）就算一批：全部跑完给一行汇总，中间不一个个发通知（作者：批量合进这条队列）。
 * preset：主界面交过来的批量按主界面当前的用途压；不给就按菜单栏的档位（和「两种都要」）。
 */
/**
 * 拖进来（或双击）的是列表里某个素材的压缩结果（路径对得上、大小没变），原素材也还在、也没超导入上限：
 * 就当拖的是原素材——高亮原来那一行，不新开一行；缺的档位从原素材压，画质比从结果再压好（作者）。
 */
async function sourceOfResult(f, st) {
  for (const g of lib.groups) {
    if (g.range) continue;
    if (g.source === f) return null;
    const hit = g.versions.some((v) => v.state === 'done' && v.file === f && (!v.bytes || v.bytes === st.size));
    if (!hit || !existsSync(g.source)) continue;
    try {
      const gst = statSync(g.source);
      if (checkInputLimits(await probe(g.source), gst.size, g.source).ok) return { source: g.source, stat: gst };
    } catch {}
  }
  return null;
}

// 操作日志里「从哪来」的说法（第二批）
const FROM_TEXT = { tray: '拖进菜单栏', open: '双击', main: '主界面批量', paste: '粘贴' };
/** 素材的样子（记日志用，不带名字和路径）：GIF 还是视频、扩展名、宽高、时长、帧率、体积 */
const mediaFacts = (info, f, bytes) => ({
  类型: info?.kind === 'gif' ? 'GIF' : info?.kind === 'video' ? '视频' : info?.kind, 扩展名: path.extname(f).toLowerCase(),
  宽高: info?.width ? `${info.width}×${info.height}` : undefined, 时长秒: info?.duration ? +info.duration.toFixed(1) : undefined,
  帧率: info?.fps ? +Number(info.fps).toFixed(2) : undefined, 体积MB: bytes ? +(bytes / 1e6).toFixed(2) : undefined,
});
async function enqueueFiles(input, { preset = null, from = 'tray' } = {}) {
  const { files, folders } = await expandDropped(input);
  let n = 0;
  let firstNew = null;
  const rejected = [];
  const entries = [];
  const single = files.length === 1 && !folders;
  for (const f of files) {
    if (!MEDIA_EXT.has(path.extname(f).toLowerCase())) continue;
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    remember(f);
    try {
      const info = await probe(f);
      const lim = checkInputLimits(info, st.size, f);
      oplog?.log('素材', lim.ok ? '进来' : '被拒', { 来源: FROM_TEXT[from] || from, ...mediaFacts(info, f, st.size), 原因: lim.ok ? undefined : lim.reason });
      if (!lim.ok) {
        rejected.push({ name: path.basename(f), reason: lim.reason });
        continue;
      }
    } catch (e) {
      oplog?.log('素材', '读不了', { 来源: FROM_TEXT[from] || from, 扩展名: path.extname(f).toLowerCase(), 原因: String(e.message || e).slice(0, 200) });
      rejected.push({ name: path.basename(f), reason: `读不了这个文件：${String(e.message || e).slice(0, 80)}` });
      continue;
    }
    const orig = await sourceOfResult(f, st);
    const src = orig ? orig.source : f;
    const order = preset ? [resolvePreset(preset).id] : trayDual ? PRESET_IDS : [trayPreset];
    const got = [];
    for (const [k, p] of order.entries()) got.push(lib.request(src, p, { sourceStat: orig ? orig.stat : st, skipIfSatisfied: k > 0 }));
    const first = got[0];
    if (first?.group) {
      makeThumb(first.group);
      entries.push({ file: src, groupId: first.group.id, primary: first.version.id, reused: Boolean(first.reused), versionIds: got.filter((r) => r.version).map((r) => r.version.id) });
      if (first.reused) {
        if (single && from === 'tray') highlight(first.version.id);
      } else firstNew ??= first.version.id;
    }
    n++;
  }
  if (rejected.length) reportRejected(rejected);
  if (entries.length > 1 || folders || from === 'main') trackBatch(entries, { from });
  return { added: n, firstNew, rejected, folders, files: entries.map((e) => e.file), entries };
}

// ---------- 一批的汇总 ----------
const batches = []; // { entries, from }
const inBatch = (versionId) => batches.some((b) => b.entries.some((e) => e.versionIds.includes(versionId)));
const ACTIVE_STATES = new Set(['waiting', 'running']);

function trackBatch(entries, meta) {
  if (!entries.length) return;
  batches.push({ entries, ...meta });
  checkBatches();
}

/** 这个文件这次压成了什么（按第一档的版本算）。还在排队 / 在压就返回 null。 */
function outcomeOf(e) {
  if (e.reused) return '之前压过、直接用';
  const { version: v } = lib.findVersion(e.primary);
  if (!v) return '取消';
  if (ACTIVE_STATES.has(v.state)) return null;
  if (v.state === 'done') return v.isSource || v.action === '已合规' || v.action === '原样保留' ? '原本就合规' : v.action === '凑帧' ? '凑帧' : '已压缩';
  if (v.state === 'failed') return v.tooLong ? '太长' : '没做成';
  return '取消';
}

/** 结果放在哪：同一个文件夹就写文件夹名，好几个就写几个文件夹。 */
function whereText(files) {
  const out = activeOutDir();
  if (out) return { text: `结果放在「${path.basename(out)}」文件夹（设置里指定的）`, dir: out, dirs: [out] };
  const dirs = [...new Set(files.map((f) => path.dirname(f)))];
  if (dirs.length === 1) return { text: `结果和原文件放在一起：「${path.basename(dirs[0])}」文件夹`, dir: dirs[0], dirs };
  return { text: `结果在各自原文件旁边（${dirs.length} 个文件夹）`, dir: dirs[0], dirs };
}

function checkBatches() {
  for (const b of [...batches]) {
    const stillActive = b.entries.some((e) => e.versionIds.some((id) => ACTIVE_STATES.has(lib.findVersion(id).version?.state)));
    if (stillActive) continue;
    batches.splice(batches.indexOf(b), 1);
    const counts = {};
    for (const e of b.entries) {
      const k = outcomeOf(e) || '取消';
      counts[k] = (counts[k] || 0) + 1;
    }
    const order = ['已压缩', '凑帧', '原本就合规', '之前压过、直接用', '太长', '没做成', '取消'];
    const parts = order.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`);
    const where = whereText(b.entries.map((e) => e.file));
    const bad = (counts['太长'] || 0) + (counts['没做成'] || 0);
    const text = `这批 ${b.entries.length} 个压完了：${parts.join('，')}。${where.text}`;
    if (pop?.isVisible()) {
      // 录屏压完不在面板里弹汇总：列表里转圈、变成大小就看得出来（作者选「录屏的都去掉、批量留着」）；面板关着时照旧发通知
      if (b.from !== 'rec') pop.webContents.send('tray-toast', { text, err: bad > 0, long: true });
    } else if (b.from === 'main' && win?.isVisible()) {
      // 主界面开着：汇总写在主界面的提示里，不另发通知
    } else {
      const n = notify(bad ? 'error' : 'done', { title: bad ? `这批压完了，有 ${bad} 个没压成` : '这批压完了', body: `${parts.join('，')}。${where.text}` });
      n?.on('click', () => showPopover());
      n?.show();
    }
    if (b.from === 'main') win?.webContents.send('batch-done', { text, dir: where.dir, bad: bad > 0 });
  }
}

/** 系统通知：成功的（压完了）看设置里「压完了发通知」，出错的照样发（10-22 设置卷）。不发就返回 null。 */
function notify(kind, opts) {
  if (!Notification.isSupported() || (kind === 'done' && !prefs.notifyDone)) return null;
  return new Notification(opts);
}

/** 被拒绝的素材：面板开着就在面板里提示，没开就发系统通知。 */
function reportRejected(rejected) {
  const text = rejected.map((r) => `${r.name}：${r.reason}`).join('\n');
  if (pop?.isVisible()) pop.webContents.send('tray-toast', { text, err: true });
  else notify('error', { title: '没有导入', body: text })?.show();
}

function createPopover() {
  pop = new BrowserWindow({
    width: 380,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#272632', // 和 theme.css 的 --bg2 一样（菜单栏面板的底）
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  popReady = new Promise((resolve) => pop.webContents.once('did-finish-load', resolve));
  pop.loadFile(path.join(here, 'renderer', 'tray.html'), PAGE_OPTS);
  pop.on('blur', () => {
    if (!dragging && !process.env.GIFKIT_TRAY_SHOT && !(WIN && prefs.panelPinned)) pop.hide(); // Windows：「固定」开着时不收（W11a）
  });
  pop.on('hide', () => {
    if (!parking) exitBubble(); // 双击时把 App 从前台退下去也会收一下小条：那一下不清空，马上再弹回来
    showDropBlock(); // Windows：面板收了，屏幕边的投放块回来
  });
  pop.on('show', () => hideDropBlock()); // Windows：面板开着时投放块先让开（面板本身就能拖进来），免得挡住面板右边
}
let popReady = null;

let popSize = { w: 380, h: 520 }; // Windows：面板该多大（小条时是内容高度）；Mac 照旧 setSize / getSize
let popResizeFix = false; // Windows：这台机器上不能调大小的窗口改不了尺寸时，以后都临时开可调大小再摆（W11g）
function setPopBounds(r) {
  if (popResizeFix) pop.setResizable(true);
  pop.setBounds(r);
  if (popResizeFix) {
    pop.setResizable(false);
    return;
  }
  const g = pop.getBounds();
  if (Math.abs(g.width - r.width) > 2 || Math.abs(g.height - r.height) > 2) {
    popResizeFix = true;
    oplog?.log('面板', '改尺寸要临时开可调大小', { 要: `${r.width}×${r.height}`, 实际: `${g.width}×${g.height}` });
    pop.setResizable(true);
    pop.setBounds(r);
    pop.setResizable(false);
  }
}
function placePopover() {
  const b = tray.getBounds();
  const [w, h] = pop.getSize();
  if (WIN) {
    // Windows：托盘图标多在右下角，面板贴着任务栏往上弹；任务栏在上面时贴着它往下（按图标在屏幕哪一边算）。
    // 大小用记着的 popSize、带大小 setBounds（W11g：不能调大小的窗口 setSize 可能不生效；缩放不是 100% 时只 setPosition 会越摆越大）
    const pw = popSize.w;
    const ph = popSize.h;
    const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const a = d.workArea;
    const x = Math.min(Math.max(Math.round(b.x + b.width / 2 - pw / 2), a.x + 8), a.x + a.width - pw - 8);
    const below = b.y < d.bounds.y + d.bounds.height / 2; // 图标在上半屏：任务栏在上面
    const y = below ? a.y + 8 : a.y + a.height - ph - 8;
    return setPopBounds({ x, y: Math.max(a.y, y), width: pw, height: ph });
  }
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const x = Math.min(Math.max(Math.round(b.x + b.width / 2 - w / 2), area.x + 4), area.x + area.width - w - 4);
  const y = Math.min(Math.round(b.y + b.height + 4), area.y + area.height - h);
  pop.setPosition(x, y);
}

function showPopover({ inactive = false } = {}) {
  exitBubble(); // 显示完整列表：小条先退出
  placePopover();
  if (inactive) pop.showInactive();
  else {
    pop.show();
    pop.focus();
  }
  refreshFiles(); // 打开时重查文件：在访达里改名、挪走、删掉的，列表跟着变（作者）
}

/** 展开面板并高亮某个版本（导出后、复用已有结果时）。 */
let highlightHook = null; // 调试用：导出完调 highlight 的那一刻记一下
function highlight(versionId) {
  highlightHook?.(versionId);
  showPopover();
  pushList();
  setTimeout(() => { if (pop && !pop.isDestroyed()) pop.webContents.send('tray-highlight', versionId); }, 200);
}

function createTray() {
  // Windows：托盘图标用程序图标（Mac 的黑色模板图在深色任务栏上看不见）；托盘图标不收拖进来的文件，拖到屏幕边的投放块
  tray = new Tray(WIN ? nativeImage.createFromPath(path.join(here, 'assets', 'icon-1024.png')).resize({ width: 32, height: 32, quality: 'best' }) : nativeImage.createFromPath(path.join(here, 'assets', 'trayTemplate.png')));
  tray.setToolTip(WIN ? 'GGIF：点开面板；把 GIF 或视频拖到屏幕边的投放块、或拖进面板就开始压缩' : 'GGIF：把 GIF 或视频拖到这里就开始压缩');
  // 双击图标 = ⌃⌥R（没在录就开始选区域；准备好了就开录；在录就停）。作者：「能否做双击通知栏图标打开录屏的功能」。
  // 第一下照旧马上开面板（单击不变慢），0.3 秒内的第二下不再开关面板，交给 double-click
  let lastTrayClick = 0;
  tray.on('double-click', () => {
    lastTrayClick = Date.now();
    pop.hide();
    if (!CAN_RECORD) return showMain(); // Windows 一期没有录屏：双击托盘图标开完整界面（Windows 上的老习惯）
    recorder?.toggle();
  });
  tray.on('click', () => {
    const now = Date.now();
    if (now - lastTrayClick < 300) return;
    lastTrayClick = now;
    if (pop.isVisible() && bubble) return showPopover(); // 小条开着：换成完整列表
    if (pop.isVisible()) pop.hide();
    else showPopover();
  });
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: '打开完整界面', click: () => showMain() },
    ...(WIN && prefs.dropBlockOn ? [{ label: '投放块回到默认位置', click: () => resetDropBlock() }] : []), // W11b
    { type: 'separator' },
    { label: '退出 GGIF', click: () => app.quit() },
  ])));
  // 两段式拖入（作者，照 Gifox）：拖着文件经过图标约 0.2 秒，面板展开（不抢焦点、暂不导入），
  // 继续拖进面板顶部的投放区松手才导入；拖拽取消就把面板收回去，不产生任务。直接松手在图标上也照样导入。
  tray.on('drag-enter', () => trayDragEnter());
  tray.on('drag-leave', () => trayDragLeave());
  tray.on('drag-end', () => trayDragEnd());
  tray.on('drop-files', async (_e, files) => {
    clearTimeout(hoverTimer);
    droppedInPanel = true;
    showPopover();
    const r = await enqueueFiles(files);
    if (r.firstNew) setTimeout(() => pop.webContents.send('tray-highlight', r.firstNew), 300);
    else if (!r.added && !r.rejected.length) pop.webContents.send('tray-toast', { text: r.folders ? '文件夹里没找到 GIF 或视频（只看第一层）' : '没有可以压的 GIF 或视频', err: true });
  });
}
let hoverTimer = null;
let openedByHover = false;
let droppedInPanel = false;
/** 两段式拖入（作者，照 Gifox）：拖着文件经过托盘图标停 ms（Mac 0.2 秒；Windows 0.4 秒，先让提示小窗露一下），面板展开（不抢焦点、暂不导入），
 *  继续拖进面板松手才导入；拖拽取消就把面板收回去，不产生任务。Mac 由托盘的 drag-enter / drag-leave / drag-end 叫，Windows 由小助手报的 enter / leave / up 叫（W11e）。 */
function trayDragEnter(ms = 200) {
  clearTimeout(hoverTimer);
  if (outDragging()) return; // 自己往外拖的经过图标：不叫面板张嘴（10-23）
  hoverTimer = setTimeout(() => {
    hideTrayHint();
    if (bubble) {
      exitBubble();
      placePopover();
    }
    openedByHover = !pop.isVisible();
    droppedInPanel = false;
    if (openedByHover) showPopover({ inactive: true });
    pop.webContents.send('tray-drag-hover', true);
  }, ms);
}
function trayDragLeave() {
  clearTimeout(hoverTimer);
}
function trayDragEnd() {
  clearTimeout(hoverTimer);
  // 拖拽结束：没在面板里松手（取消了），而且面板是这次拖拽打开的，就收回去（Windows 上「固定」开着就留着）
  setTimeout(() => {
    pop.webContents.send('tray-drag-hover', false);
    if (openedByHover && !droppedInPanel && !pop.isFocused() && !(WIN && prefs.panelPinned)) pop.hide();
    openedByHover = false;
  }, 400);
}

/** 双击行 / 编辑：原文件还在（大小和修改时间对得上）就从原文件编辑；找不到才用最近的结果，并提示画质会再损失。带上次的档位和参数。 */
async function editGroup(id) {
  if (!lib.findGroup(id)) return;
  await refreshFiles(); // 原素材、结果被改名、挪走的先找回（作者）
  const g = lib.findGroup(id);
  if (!g) return;
  const last = g.versions.filter((v) => v.state === 'done').sort((a, b) => b.createdAt - a.createdAt)[0];
  let file = g.source;
  let sourceMissing = false;
  try {
    const st = await stat(g.source);
    if (g.sourceSize !== undefined && (st.size !== g.sourceSize || Math.abs(st.mtimeMs - g.sourceMtime) > 1)) sourceMissing = true;
  } catch {
    sourceMissing = true;
  }
  if (sourceMissing) {
    if (!last?.file || !existsSync(last.file)) {
      dialog.showMessageBox({ type: 'warning', message: '原素材和压缩结果都找不到了', detail: g.source });
      return;
    }
    file = last.file;
  }
  // 因为太长没压成的：进主界面时先帮着选好前 30 秒
  const tooLong = g.versions.some((v) => v.state === 'failed' && v.tooLong);
  const failed = g.versions.filter((v) => v.state === 'failed').sort((a, b) => b.createdAt - a.createdAt)[0];
  // 录屏的一段：打开整段录像、选好这一段，两头把手能拖到整段任何位置（作者「切片后还支持移动打标位置」）
  const r = rangeOf(g);
  const edit = r ? { ...(g.edit || {}), start: r.start, dur: r.dur, ...(r.ranges ? { ranges: r.ranges } : {}), mode: g.edit?.mode || 'auto' } : g.edit || null;
  // 主界面打标（10-19 深夜，TODO 2.74）：条上显示同一组的全部段（录屏就是这次录屏的全部段），这一段选好；原素材找不到时不带
  const marks = g.range && !sourceMissing ? (g.range.join ? joinMarksOf(g) : marksOf(g)) : null;
  showMain({ groupId: g.id, file, sourceMissing, name: g.name, preset: last?.preset || failed?.preset || trayPreset, mode: last?.mode || 'fast', edit, suggestDur: tooLong && !r ? 30 : null, range: g.range ? { n: g.range.n } : null, marks });
}

/** 一组段里还算数的那几行（压过又被切开、合并掉的标了 off，结果留在列表里，不再算这一组的段）。 */
function siblingsOf(source, set) {
  return lib.groups.filter((x) => x.range && !x.range.off && !x.range.join && x.source === source && (x.range.set ?? null) === (set ?? null));
}

/**
 * 拼起来的那一行（11.14 多选导出）点回主界面：还原成拼的几段，中间空着的补成没选的段，选好拼的那几段。
 * 另起一组（set 用这一行的编号、不算录屏）：在这里再切、单导一段，不会并进、也不会改动录屏那一组的段。
 */
function joinMarksOf(g) {
  const r2 = (x) => Math.round(x * 100) / 100;
  const parts = rangeOf(g).ranges.map((p) => ({ start: r2(p.start), end: r2(p.start + p.dur) }));
  const segs = [];
  const pick = [];
  for (const p of parts) {
    const prev = segs.at(-1);
    if (prev && p.start > prev.end + 0.05) segs.push({ gid: null, start: prev.end, end: p.start, done: false });
    pick.push(segs.length);
    segs.push({ gid: null, start: p.start, end: p.end, done: false });
  }
  return { set: `join-${g.id}`, rec: false, prefix: prefixOf(g), segs, pick };
}
const isRecGroup = (g) => g.range.rec ?? /^录屏/.test(g.name);
const prefixOf = (g) => g.range.prefix || g.name.split(' · 第')[0];

/** 编辑某一段时带给主界面的：同一组的全部段（按段号排），哪几段压过。 */
function marksOf(g) {
  const set = g.range.set ?? null;
  const segs = siblingsOf(g.source, set)
    .map((x) => {
      const r = rangeOf(x);
      return { gid: x.id, n: x.range.n, start: r.start, end: Math.round((r.start + r.dur) * 100) / 100, done: x.versions.some((v) => v.state === 'done') };
    })
    .sort((a, b) => a.n - b.n || a.start - b.start);
  return { set, rec: isRecGroup(g), prefix: prefixOf(g), segs };
}

/**
 * 录屏的段在主界面里切、删、改起止：同步回菜单栏那几行（TODO 2.74）。segs 按顺序是第 1、2…段。
 * 有 gid 的行：没压过的改起止和名字，压过的只改段号（结果是按原来的起止压的，等再导出时才改）；没 gid 的新段加成「待压缩」；
 * 这一组里不在 segs 里的行：没压过的去掉，压过的留着结果、标 off（不再算这一组的段）。返回每段的 gid。
 */
ipcMain.handle('marks-sync', async (_e, { file, set, prefix, segs }) => {
  const r2 = (x) => Math.round(x * 100) / 100;
  const sibs = siblingsOf(file, set);
  const keep = new Set();
  const out = segs.map((s, i) => {
    const n = i + 1;
    const g = s.gid ? lib.findGroup(s.gid) : null;
    if (g?.range && g.source === file) {
      keep.add(g.id);
      const used = g.versions.length > 0;
      const moved = !used && (g.range.start !== r2(s.start) || g.range.end !== r2(s.end));
      g.range = used ? { ...g.range, n } : { ...g.range, n, start: r2(s.start), end: r2(s.end) };
      if (!used) {
        if (g.edit?.dur) g.edit = { ...g.edit, start: g.range.start, dur: r2(g.range.end - g.range.start) };
        if (g.pending) g.pending.durationSec = r2(g.range.end - g.range.start);
      }
      g.name = segLabel(prefixOf(g), n, g.range.start, g.range.end);
      if (moved) {
        thumbs.delete(g.id);
        makeThumb(g);
      }
      return { gid: g.id };
    }
    const ng = lib.addRange(file, { n, start: r2(s.start), end: r2(s.end) }, { label: segLabel(prefix, n, s.start, s.end), session: set, rec: true, prefix });
    makeThumb(ng);
    keep.add(ng.id);
    return { gid: ng.id };
  });
  for (const x of sibs) {
    if (keep.has(x.id)) continue;
    if (x.versions.length) x.range = { ...x.range, off: true };
    else lib.removeGroup(x.id);
  }
  lib.changed();
  pushList();
  return out;
});

/**
 * 完整界面导出完：结果归入原素材那一组，成为这一档的当前版本；旧版本留着（进右键「历史版本」），不删不覆盖。
 * 然后展开菜单栏面板、高亮新版本，方便马上拖走（作者方案）。返回输出路径。
 */
async function recordExport({ groupId, output, source, preset, mode, edit, action, range }) {
  if (!output || !existsSync(output)) return output;
  // 记着的那一行已经从菜单栏移除了：当没有行号，段照样建自己的行（10-20 审查 M1：原来记到整个文件那一行，名字却带「_第N段」）
  if (groupId && !lib.findGroup(groupId)) groupId = null;
  if (!groupId && range) {
    // 主界面切的段第一次导出：建这一段的行（主界面打标，10-19 深夜）
    // 多选拼起来的（11.14）：建「拼起来」的一行，记下几段，不算这一组的段
    const prefix = range.prefix || path.basename(source);
    const label = range.join ? joinLabel(prefix, range.n, range.join) : segLabel(prefix, range.n, range.start, range.end);
    groupId = lib.addRange(source, { n: range.n, start: range.start, end: range.end, ...(range.join ? { join: range.join } : {}) }, { label, session: range.set, rec: Boolean(range.rec), prefix }).id;
  }
  const g0 = groupId ? lib.findGroup(groupId) : null;
  const src = g0 ? g0.source : source;
  const d = await describe(output);
  const { group, version } = lib.addDone(src, { preset: resolvePreset(preset).id, mode, action, isSource: path.resolve(output) === path.resolve(src), ...d }, groupId);
  if (edit) group.edit = edit;
  if (group.range?.join && edit?.ranges?.length >= 2) {
    // 拼起来的那一行又导了一次：几段、名字跟着这次的
    const join = edit.ranges.map((p) => ({ start: p.start, end: Math.round((p.start + p.dur) * 100) / 100 }));
    group.range = { ...group.range, n: range?.n || group.range.n, start: join[0].start, end: Math.max(...join.map((p) => p.end)), join };
    group.name = joinLabel(prefixOf(group), group.range.n, join);
  } else if (group.range && !group.range.join && edit?.dur) {
    // 一段在主界面拖了起止（或段号变了）：列表里的名字跟着变
    group.range = { ...group.range, n: range?.n || group.range.n, start: Math.round((edit.start || 0) * 100) / 100, end: Math.round(((edit.start || 0) + edit.dur) * 100) / 100 };
    group.name = segLabel(prefixOf(group), group.range.n, group.range.start, group.range.end);
  }
  if (group.sourceSize === undefined) {
    try {
      const st = statSync(src);
      Object.assign(group, { sourceSize: st.size, sourceMtime: st.mtimeMs, sourceDev: st.dev, sourceIno: st.ino });
    } catch {}
  }
  makeThumb(group);
  if (!process.env.GIFKIT_SHOT) highlight(version.id);
  if (groupId && debugAfterEdit) debugAfterEdit();
  lastRecordedGroup = group.id;
  return output;
}
let lastRecordedGroup = null; // 最近一次导出记到了哪一行（主界面要知道切的段归到了哪行）

/** 本工具生成的结果文件（只有这些允许从菜单栏删除；原素材永远不碰）。 */
function isOurs(file) {
  const base = path.basename(file);
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // 「_压缩_4.8M」里的「.」要转义（10-20 审查 A11）
  return Object.values(PRESETS).some((p) => new RegExp(`${esc(p.fileSuffix)}( \\(\\d+\\))?\\.gif$`, 'i').test(base));
}

/**
 * 这个版本的文件是不是工具压出来的（能删）：原样合规、直接当版本用的原文件不算；
 * 记了文件编号的（10-20 起），改了名、挪了地方也还是这个文件，照样算；以前没记编号的按名字（带「_压缩」）认。
 */
const isOurResult = (v) => v.state === 'done' && Boolean(v.file) && !v.isSource && (isOurs(v.file) || Boolean(v.ino));

async function trashVersion(v) {
  if (isOurResult(v) && existsSync(v.file)) await trashFile(v.file);
  lib.dropVersion(v.id);
}

/** 移到废纸篓。GIFKIT_FAKE_TRASH=<文件夹>：测试时挪到这个文件夹，不往用户的废纸篓里放东西。 */
async function trashFile(f) {
  const fake = process.env.GIFKIT_FAKE_TRASH;
  if (!fake) return shell.trashItem(f);
  await mkdir(fake, { recursive: true });
  await rename(f, path.join(fake, `${Date.now()}_${path.basename(f)}`));
}

/** 这几行里能移到废纸篓的文件：工具压出来的结果（名字带「_压缩」；原样合规、直接当版本用的原文件不算），连历史版本。 */
function trashableOf(ids) {
  const files = new Set();
  for (const id of ids) {
    const g = lib.findGroup(id);
    for (const v of g?.versions || []) if (isOurResult(v) && existsSync(v.file)) files.add(v.file);
  }
  return [...files];
}

/**
 * 把这几行的压缩结果移到废纸篓，这几行从列表去掉（原素材不动）。作者：「如何在列表直接删除…文件（进入回收站）」。
 * 不弹确认（和访达的 ⌘⌫ 一样，废纸篓里还在）；面板底下说一声删了几个。
 */
async function trashGroups(ids) {
  const files = trashableOf(ids);
  let moved = 0;
  for (const f of files) {
    try {
      await trashFile(f);
      moved++;
    } catch (e) {
      console.error('移到废纸篓失败：', f, e.message);
    }
  }
  lib.removeGroups(ids); // 这几行的文件进废纸篓了，不进「撤销」
  pushList();
  const rows = ids.length;
  let text = moved ? `已把 ${moved} 个压缩结果移到废纸篓${rows > 1 ? `，${rows} 行从列表去掉` : ''}（原素材没动）` : `${rows > 1 ? '这几行' : '这一行'}没有工具压出来的文件，只从列表去掉了（原素材没动）`;
  // 刚才「从列表移除 / 清空」的还能撤销：别把它一起作废（10-20 审查 A2），提示里接着给「撤销」，剩多久给多久
  const left = undoStash ? undoStash.until - Date.now() : 0;
  if (left > 500) text += `；刚才移除的 ${undoStash.groups.length} 行还能撤销`;
  pop?.webContents.send('tray-toast', { text, err: moved < files.length, ...(left > 500 ? { undo: true, ms: left } : {}) });
  return { moved, rows };
}

/** 录屏的整段录像（工具自己录的，在「下载/GGIF录屏」或改名前的「下载/GIF工具录屏」里）移到废纸篓：还没压的段（只有录像）一起去掉；压过的段留着结果。 */
async function trashRecording(g) {
  const src = g.source;
  if (!src || !existsSync(src) || !isOwnRecordingFile(src)) return;
  // 这次录屏还在排队、正在压的段先停掉（10-20 审查 A4：原来不停，录像进了废纸篓以后它们一个个失败）
  const segs = lib.groups.filter((y) => y.source === src && y.range);
  for (const y of segs) for (const v of [...y.versions]) if (ACTIVE_STATES.has(v.state)) lib.cancel(v.id);
  await trashFile(src);
  for (const x of segs) if (!x.versions.some((v) => v.state === 'done')) lib.removeGroup(x.id);
  pushList();
  pop?.webContents.send('tray-toast', { text: '整段录像移到废纸篓了；还没压的段一起去掉，压好的 GIF 留着' });
}
const isOwnRecordingFile = (f) => {
  // 换过「录像放在」：以前那个文件夹里录的也认（录像都叫「开录时刻/录屏.mp4」，10-22 试用反馈 9.6b）
  if (/(^|\/)\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\/录屏\.mp4$/.test(f)) return true;
  return [REC_ROOT(), REC_DEFAULT(), REC_ROOT_OLD()].some((root) => path.resolve(f).startsWith(path.resolve(root) + path.sep));
};

/** 从列表移除、清空列表：记下来，10 秒内能撤销（作者：清空列表没有确认、没有撤销）。文件都不动。 */
let undoStash = null; // { groups, timer, until }
function stashForUndo(groups, text) {
  clearTimeout(undoStash?.timer);
  undoStash = null;
  if (groups.length) {
    // 倒计时只作废自己这一份（10-20 审查 D3：旧的倒计时没停，会把后来的撤销提前作废，点「撤销」没反应）
    const stash = { groups, until: Date.now() + UNDO_MS };
    stash.timer = setTimeout(() => { if (undoStash === stash) undoStash = null; }, UNDO_MS);
    undoStash = stash;
  }
  pushList();
  if (groups.length) pop?.webContents.send('tray-toast', { text, undo: true, ms: UNDO_MS });
}
const UNDO_MS = 10000;
ipcMain.handle('tray-undo', () => undoLast());
function undoLast() {
  if (!undoStash) return 0;
  clearTimeout(undoStash.timer);
  const n = lib.restore(undoStash.groups);
  undoStash = null;
  for (const g of lib.groups) makeThumb(g);
  pushList();
  pop?.webContents.send('tray-toast', { text: `放回来了 ${n} 行` });
  return n;
}

/**
 * 调试（GIFKIT_DEBUG_LISTFS=1，配 GIFKIT_TRAY_DROP 拖进 甲乙丙丁戊 五个、GIFKIT_FAKE_TRASH 和 GIFKIT_TRASH_DIR 指到同一个假废纸篓）：
 * 压完后在硬盘上把甲的结果改名、乙的挪到「别处」、丙的删掉、丁的挪进假废纸篓、戊的原素材挪走，打开面板看列表；
 * 再把甲移到废纸篓、清空再撤销，每步打印列表。GIFKIT_DEBUG_LISTFS=reload：启动、重查文件后打印列表就退出（看关着时改名的能不能找回）。
 */
function listDump() {
  return JSON.stringify(lib.list().map((g) => `${g.name}［${g.chips.map((c) => (c.file ? `${path.basename(path.dirname(c.file))}/${path.basename(c.file)}` : c.state)).join('、') || '没有版本'}］`));
}
async function debugListFs() {
  try {
    await debugListFsSteps();
  } catch (e) {
    console.log('列表测试出错：', e.stack || e.message);
  } finally {
    await lib.save();
    setTimeout(() => app.quit(), 500);
  }
}
async function debugListFsSteps() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { renameSync, rmSync, mkdirSync, readdirSync } = await import('node:fs');
  const trash = process.env.GIFKIT_FAKE_TRASH;
  const g = (n) => lib.groups.find((x) => x.name.startsWith(n));
  const out = (n) => g(n)?.versions.find((v) => v.state === 'done')?.file;
  console.log('压完：', listDump());
  const dir = path.dirname(g('甲').source);
  mkdirSync(path.join(dir, '别处'), { recursive: true });
  mkdirSync(trash, { recursive: true });
  renameSync(out('甲'), path.join(dir, '甲_改名给同事.gif'));
  renameSync(out('乙'), path.join(dir, '别处', path.basename(out('乙'))));
  rmSync(out('丙'));
  renameSync(out('丁'), path.join(trash, path.basename(out('丁'))));
  renameSync(g('戊').source, path.join(dir, '别处', '戊_原片改名.mov'));
  showPopover();
  await sleep(1500);
  console.log('甲改名、乙挪走、丙删掉、丁进废纸篓、戊原片挪走以后（打开面板）：', listDump(), '；戊的原素材现在：', path.relative(dir, g('戊').source));
  if (g('甲')) await trashGroups([g('甲').id]);
  console.log('甲移到废纸篓以后：', listDump(), '；假废纸篓里：', JSON.stringify(readdirSync(trash).map((f) => f.replace(/^\d+_/, ''))));
  if (g('乙') && g('戊')) {
    // 10-20 审查 A2：移除乙（能撤销）→ 把戊移到废纸篓 → 撤销，乙应该回来
    stashForUndo(lib.removeGroups([g('乙').id]), '');
    await trashGroups([g('戊').id]);
    console.log('移除乙、再把戊移到废纸篓以后：', listDump(), '；还能撤销：', Boolean(undoStash));
    undoLast();
    console.log('再撤销以后（乙应该回来）：', listDump());
  }
  const gone = lib.clear();
  stashForUndo(gone, '');
  console.log('清空以后：', listDump());
  undoLast();
  console.log('撤销以后：', listDump());
}
ipcMain.handle('tray-remove', (_e, ids) => {
  const gone = lib.removeGroups(ids);
  stashForUndo(gone, `已从列表移除 ${gone.length} 行（文件都没动）`);
  return gone.length;
});
ipcMain.handle('tray-trash', (_e, ids) => trashGroups(ids));

function listForUi() {
  return lib.list().map((g) => ({ ...g, thumb: thumbs.get(g.id) || null }));
}

let pushTimer = null;
function pushList() {
  clearTimeout(pushTimer);
  pushTimer = null;
  pop?.webContents.send('tray-groups', listForUi());
}
lib.on('idle', () => checkBatches());
lib.on('change', () => {
  // 进度事件很密，合并成每 150 毫秒最多推一次
  if (pushTimer) return;
  pushTimer = setTimeout(pushList, 150);
});
lib.on('finished', (g, v) => {
  if (v.file) remember(v.file);
  oplog?.log('压缩', { done: '完成', failed: '没做成', error: '没做成', cancelled: '取消' }[v.state] || v.state, {
    素材: g.id, 段: g.range?.n, 档位: v.preset, 动作: v.action, 结果: v.width ? `${v.width}×${v.height} ${v.frames}帧 ${(v.bytes / 1e6).toFixed(2)}MB` : undefined,
    合规: v.state === 'done' ? satisfies(v, v.preset) : undefined, 用时秒: v.startedAt && v.finishedAt ? +((v.finishedAt - v.startedAt) / 1000).toFixed(1) : undefined,
    太长: v.tooLong || undefined, 原因: v.error || undefined,
  });
  if (batches.length) setTimeout(checkBatches, 0);
  if (bubble) setTimeout(() => maybeHideBubble(), 0);
  if (inBatch(v.id) || pop?.isVisible() || !Notification.isSupported() || v.state === 'cancelled') return;
  const short = resolvePreset(v.preset).limit / 1e6;
  const n = v.state === 'done'
    ? notify('done', { title: v.isSource ? '已经符合要求' : '压缩好了', body: `${path.basename(v.file)} · ${(v.bytes / 1e6).toFixed(2)} MB（${short.toFixed(1)}MB 档）` })
    : notify('error', { title: v.tooLong ? '太长了，剪短再压' : '没做成', body: `${g.name}${v.error ? `：${friendlyError(v.error)}` : ''}` });
  if (!n) return;
  n.on('click', () => { // 点通知：打开菜单栏面板，失败的那块闪一下（10-22 试用反馈）
    showPopover();
    if (v.state === 'failed') setTimeout(() => pop?.webContents.send('tray-highlight', v.id), 300);
  });
  n.show();
});

ipcMain.handle('tray-state', () => ({
  presets: PRESET_IDS.map((id) => ({ id, name: PRESETS[id].name, limit: PRESETS[id].limit })),
  preset: trayPreset,
  dual: trayDual,
  recMark,
  pin: Boolean(prefs.panelPinned), // Windows版 W11a
  groups: listForUi(),
  rec: { state: recorder?.state || 'idle', session: lastRecSession, hotkey: hkText('rec'), markKey: hkText('mark'), fitSec: lastRecSession?.fitSec || AUTO_FIT_SEC },
}));
/** 打标开关（11.12）：菜单栏顶上、录制胶囊点的都走这里；存设置，另外两处跟着变 */
function setRecMark(on) {
  recMark = Boolean(on);
  recorder?.refreshMarking();
  saveSettings();
  broadcastPrefs();
  oplog?.log('设置', 'recMark', { 改成: recMark });
}
ipcMain.handle('tray-set-rec-mark', (_e, on) => setRecMark(on));
ipcMain.handle('tray-set-pin', (_e, on) => {
  prefs.panelPinned = Boolean(on);
  saveSettings();
  oplog?.log('面板', '固定', { 开: prefs.panelPinned });
  return prefs.panelPinned;
});
/** 录制帧率（11.13）：录制胶囊上点的走这里（设置页走 settings-set）；存设置，设置页跟着变 */
function setRecFps(v) {
  recFps = normRecFps(v);
  recorder?.emitState();
  saveSettings();
  broadcastPrefs();
  oplog?.log('设置', 'recFps', { 改成: recFps });
}
ipcMain.handle('tray-set-preset', (_e, id) => {
  trayPreset = resolvePreset(id).id;
  saveSettings();
});
ipcMain.handle('tray-set-dual', (_e, on) => {
  trayDual = Boolean(on);
  saveSettings();
});

// 菜单栏选的档位和「两种都要」存下来，重启后保持（双击 GIF 也按它压）
const settingsFile = () => path.join(path.dirname(lib.file), 'settings.json');
function saveSettings() {
  writeFile(settingsFile(), JSON.stringify({ preset: trayPreset, dual: trayDual, recAuto, recMark, recFps, timelineOpen, ...prefs })).catch(() => {});
}
async function loadSettings() {
  try {
    const st = JSON.parse(await readFile(settingsFile(), 'utf8'));
    trayPreset = resolvePreset(st.preset).id;
    trayDual = Boolean(st.dual);
    recAuto = Boolean(st.recAuto);
    recMark = Boolean(st.recMark);
    recFps = normRecFps(st.recFps);
    timelineOpen = Boolean(st.timelineOpen);
    prefs = normalizePrefs(st, { presetIds: PRESET_IDS });
  } catch {}
}

// ---------- 设置那层（10-22 设置卷；作者选两列卡片、说明悬停浮出）：主界面读、改，改完通知主界面和菜单栏 ----------
/** 开机启动现在的状态。开发版（electron .）不能设：会把 Electron 本身加进登录项 */
function loginState() {
  if (process.defaultApp) return { on: false, canSet: false, note: '开发版不能设，装好的 GGIF 里才能设' };
  try {
    const s = app.getLoginItemSettings();
    // macOS 13 起走新版登录项：status 可能是 enabled / not-registered / requires-approval（要用户在系统设置里允许）/ not-found
    return { on: Boolean(s.openAtLogin), canSet: true, status: s.status || null, note: s.status === 'requires-approval' ? '要在「系统设置 → 通用 → 登录项」里允许 GGIF' : '' };
  } catch (err) {
    return { on: false, canSet: false, note: `读不到（${err.message}）` };
  }
}
function uiPrefs() {
  return {
    ...prefs, recAuto, recMark, recFps, login: loginState(), version: app.getVersion(),
    hotkeyText: { rec: hkText('rec'), mark: hkText('mark') }, hotkeyDefaults: { ...Hotkeys.DEFAULTS },
    outDirName: prefs.outDir ? path.basename(prefs.outDir) : '', outDirText: prefs.outDir ? prefs.outDir.replace(os.homedir(), '~') : '', outDirOk: !prefs.outDir || isDir(prefs.outDir),
    recDirName: path.basename(REC_ROOT()), recDirText: REC_ROOT().replace(os.homedir(), '~'), recDirOk: !prefs.recDir || isDir(prefs.recDir), // 录像放在（试用反馈 9.6b）
  };
}
function broadcastPrefs() {
  const p = uiPrefs();
  for (const w of [win, pop]) if (w && !w.isDestroyed()) w.webContents.send('settings-changed', p);
}
/** 换快捷键：校验 → 开始 / 停止马上换（新的注册不上就留旧的）；切一刀录制中才占着，录制中就马上换。出错返回原因 */
function setHotkeys(v) {
  const next = { ...prefs.hotkeys, ...(v || {}) };
  for (const w of ['rec', 'mark']) {
    const err = Hotkeys.check(next[w], next[w === 'rec' ? 'mark' : 'rec']);
    if (err) return err;
    next[w] = Hotkeys.normalize(next[w]);
  }
  const old = prefs.hotkeys;
  if (next.rec !== old.rec && recorder) {
    globalShortcut.unregister(old.rec);
    if (!globalShortcut.register(next.rec, () => recorder.toggle())) {
      recorder.hotkeyOk.rec = globalShortcut.register(old.rec, () => recorder.toggle());
      return `${Hotkeys.toText(next.rec)} 注册不上，还用原来的 ${Hotkeys.toText(old.rec)}`;
    }
    recorder.hotkeyOk.rec = true;
  }
  prefs.hotkeys = next;
  if (next.mark !== old.mark) recorder?.refreshMarkKey();
  return '';
}
function setLogin(on) {
  if (process.defaultApp) return '开发版不能设开机启动，装好的 GGIF 里才能设';
  try {
    app.setLoginItemSettings({ openAtLogin: on });
  } catch (err) {
    return `设不上：${err.message}`;
  }
  const s = loginState();
  if (s.on !== on && s.status !== 'requires-approval') return on ? '没加进登录项（本机签名的包可能登记不上）' : '没从登录项里去掉';
  return '';
}
const PREF_BOOLS = ['openMainOnStart', 'notifyDone', 'fill', 'rememberPreset', 'rememberTimeline'];
/** 设置那层正在录新快捷键：先放掉全局的「开始 / 停止」（不然按到它会直接开始录屏），录完、关窗再占回来 */
function holdRecKey(on) {
  if (!recorder) return;
  if (!on) {
    if (!globalShortcut.isRegistered(prefs.hotkeys.rec)) recorder.hotkeyOk.rec = globalShortcut.register(prefs.hotkeys.rec, () => recorder.toggle());
  } else if (globalShortcut.isRegistered(prefs.hotkeys.rec)) globalShortcut.unregister(prefs.hotkeys.rec);
}
ipcMain.handle('hotkey-capture', (_e, on) => holdRecKey(Boolean(on)));
/** 设置里「打开」操作日志：在访达里打开日志文件夹（第二批） */
ipcMain.handle('open-log-dir', async () => {
  const d = path.join(path.dirname(lib.file), 'logs');
  await mkdir(d, { recursive: true });
  return shell.openPath(d);
});
ipcMain.handle('settings-get', () => uiPrefs());
/** 设置里「录像放在」点文件夹名：换一个文件夹（能新建），从下次录屏起放进去；选回默认的就存成「默认」（10-22 试用反馈 9.6b） */
ipcMain.handle('pick-rec-dir', async () => {
  const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
    title: '录像放进哪个文件夹', buttonLabel: '放这里', properties: ['openDirectory', 'createDirectory'], defaultPath: recRootNow(),
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, error: '', prefs: uiPrefs() };
  const d = r.filePaths[0];
  remember(d);
  prefs.recDir = path.resolve(d) === path.resolve(REC_DEFAULT()) ? null : d;
  allowOwnRecordings(d); // 自己录的片段不受视频 100MB 导入上限
  oplog?.log('设置', 'recDir', { 改成: prefs.recDir ? '指定文件夹' : '默认' });
  saveSettings();
  broadcastPrefs();
  return { ok: true, error: '', prefs: uiPrefs() };
});
/** 设置里「录像放在」的「打开」：在访达里打开（默认的还没建就建上；选的那个不在了就打开默认的） */
ipcMain.handle('open-rec-dir', async () => {
  const d = recRootNow();
  await mkdir(d, { recursive: true });
  return shell.openPath(d);
});
/** 设置里点「指定文件夹…」：选一个文件夹（能新建），结果都放进去 */
ipcMain.handle('pick-out-dir', async () => {
  const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
    title: '结果都放进哪个文件夹', buttonLabel: '放这里', properties: ['openDirectory', 'createDirectory'], defaultPath: prefs.outDir || app.getPath('downloads'),
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, error: '', prefs: uiPrefs() };
  remember(r.filePaths[0]);
  const error = setOutDir(r.filePaths[0]);
  oplog?.log('设置', 'outDir', { 改成: '指定文件夹', 出错: error || undefined });
  saveSettings();
  broadcastPrefs();
  return { ok: !error, error, prefs: uiPrefs() };
});
ipcMain.handle('settings-set', (_e, patch) => {
  let error = '';
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'hotkeys') error = setHotkeys(v);
    else if (k === 'login') error = setLogin(Boolean(v));
    else if (k === 'recAuto') {
      recAuto = Boolean(v);
      recorder?.emitState(); // 录屏小胶囊上的「录完自动压」跟着变
    } else if (k === 'recMark') {
      recMark = Boolean(v);
      recorder?.refreshMarking(); // 录屏小胶囊上的「打标」跟着变；录制中马上占上 / 放掉切一刀的键
    } else if (k === 'recFps') {
      recFps = normRecFps(v);
      recorder?.emitState(); // 录屏小胶囊上的帧率跟着变（录制中不变，开录时已定）
    } else if (k === 'dropBlockOn') {
      prefs.dropBlockOn = Boolean(v);
      applyDropBlock(); // Windows：屏幕边的投放块开 / 关
    } else if (PREF_BOOLS.includes(k)) prefs[k] = Boolean(v);
    else if (k === 'settingsTab') prefs.settingsTab = v === 'help' ? 'help' : 'set';
    else if (k === 'outDir') error = setOutDir(v);
    else if (k === 'oplog') {
      if (!v) oplog?.log('设置', '关掉操作日志');
      prefs.oplog = Boolean(v);
      oplog?.setEnabled(prefs.oplog);
    }
    if (k !== 'oplog' || v) oplog?.log('设置', k, { 改成: k === 'outDir' ? (prefs.outDir ? '指定文件夹' : '原文件旁边') : v, 出错: error || undefined });
    if (error) break;
  }
  saveSettings();
  broadcastPrefs();
  return { ok: !error, error, prefs: uiPrefs() };
});

// ---------- Windows 屏幕边的投放块（作者选 B） ----------
// 平时只露一小截（34×64）、半透明，贴在主屏右边；文件拖过来变大（210×120）、亮起来，松手就压（和拖到 Mac 菜单栏图标一样进列表）；
// 按住能上下挪（记住位置）；点一下开 / 关托盘面板。面板开着时让开；全屏的程序在前台时藏起来（Windows 小助手报，没有小助手就不藏）。
let dropWin = null;
let dropHover = false;
let dropFull = false;
let dropMove = null;
const DROP_IDLE = { w: 34, h: 64 };
const DROP_HOVER = { w: 210, h: 120 };
const dropArea = () => screen.getPrimaryDisplay().workArea;
function placeDropBlock() {
  if (!dropWin || dropWin.isDestroyed()) return;
  const a = dropArea();
  const s = dropHover ? DROP_HOVER : DROP_IDLE;
  const top = a.y + Math.round((prefs.dropBlockY ?? 0.5) * (a.height - DROP_IDLE.h)); // 小块的上沿
  const y = Math.min(Math.max(top + Math.round(DROP_IDLE.h / 2 - s.h / 2), a.y), a.y + a.height - s.h);
  dropWin.setBounds({ x: a.x + a.width - s.w, y, width: s.w, height: s.h });
}
function dropLabel() {
  const ids = trayDual ? PRESET_IDS : [trayPreset];
  return `${ids.map((id) => `${(PRESETS[id].limit / 1e6).toFixed(1)}MB`).join(' + ')} · ${trayDual ? '两种都要' : PRESETS[trayPreset].name.split(' · ').pop()}`;
}
const dropWanted = () => Boolean(dropWin && !dropWin.isDestroyed() && !dropFull && !(pop && pop.isVisible()));
function showDropBlock() {
  if (!dropWanted()) return;
  placeDropBlock(); // 每次露出来先把位置、大小摆正（W11b：长条了也能自己好）
  if (!dropWin.isVisible()) dropWin.showInactive();
}
/** 拖着挪到 y（贴右边）。用带大小的 setBounds：Windows 缩放不是 100% 时只 setPosition 会越挪越高（作者碰到长条，W11b） */
function dropMoveTo(y) {
  const ar = dropArea();
  const yy = Math.min(Math.max(Math.round(y), ar.y), ar.y + ar.height - DROP_IDLE.h);
  dropWin.setBounds({ x: ar.x + ar.width - DROP_IDLE.w, y: yy, width: DROP_IDLE.w, height: DROP_IDLE.h });
  return yy;
}
/** 托盘右键「投放块回到默认位置」：位置清掉、大小摆正，关着的重新开（W11b） */
function resetDropBlock() {
  prefs.dropBlockY = null;
  saveSettings();
  if (!dropWin || dropWin.isDestroyed()) applyDropBlock();
  else { dropHover = false; placeDropBlock(); showDropBlock(); }
}
function hideDropBlock() {
  if (dropWin && !dropWin.isDestroyed() && dropWin.isVisible() && !dropHover) dropWin.hide();
}
function applyDropBlock() {
  if (!WIN || !prefs.dropBlockOn) {
    if (dropWin && !dropWin.isDestroyed()) dropWin.destroy();
    dropWin = null;
    return;
  }
  if (dropWin && !dropWin.isDestroyed()) return;
  dropWin = new BrowserWindow({
    width: DROP_IDLE.w, height: DROP_IDLE.h, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, type: 'toolbar',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  dropWin.loadFile(path.join(here, 'renderer', 'dropblock.html'), PAGE_OPTS);
  dropWin.webContents.once('did-finish-load', () => {
    if (!dropWin || dropWin.isDestroyed()) return;
    dropWin.webContents.send('drop-block-label', dropLabel());
    placeDropBlock();
    showDropBlock();
  });
}
ipcMain.on('drop-block', async (_e, a) => {
  if (!a) return;
  if (a.act !== 'drop' && (!dropWin || dropWin.isDestroyed())) return; // 托盘提示小窗上松手也走这里（W11e），那时投放块多半关着
  if (a.act === 'hover') {
    if (a.on) dropWin.webContents.send('drop-block-label', dropLabel());
    dropHover = Boolean(a.on);
    placeDropBlock();
  } else if (a.act === 'drop') {
    hideTrayHint();
    dropHover = false;
    placeDropBlock();
    const files = (Array.isArray(a.paths) ? a.paths : []).filter((f) => typeof f === 'string' && f);
    if (!files.length) return;
    oplog?.log('投放块', '拖入', { 个数: files.length });
    showPopover();
    const r = await enqueueFiles(files);
    if (r.firstNew) setTimeout(() => pop.webContents.send('tray-highlight', r.firstNew), 300);
    else if (!r.added && !r.rejected.length) pop.webContents.send('tray-toast', { text: r.folders ? '文件夹里没找到 GIF 或视频（只看第一层）' : '没有可以压的 GIF 或视频', err: true });
  } else if (a.act === 'move' && Number.isFinite(a.screenY)) {
    const ar = dropArea();
    if (a.phase === 'start') dropMove = { y0: a.screenY, top: dropWin.getBounds().y };
    else if (dropMove) {
      const y = dropMoveTo(dropMove.top + (a.screenY - dropMove.y0));
      if (a.phase === 'end') {
        prefs.dropBlockY = Math.min(1, Math.max(0, (y - ar.y) / Math.max(1, ar.height - DROP_IDLE.h)));
        dropMove = null;
        saveSettings();
        placeDropBlock();
      }
    }
  } else if (a.act === 'click') {
    if (pop.isVisible()) pop.hide();
    else showPopover();
  }
});

// Windows 小助手（native/win/ggif-helper.c，云端拿 MSVC 编）watch 模式：① 每秒问一次「前台是不是全屏程序」（投放块要藏）；
// ② 拖文件到托盘的 GGIF 图标上（W11e，作者：「改成拖到托盘弹面板」，像聊天软件的做法）：Windows 不告诉托盘图标有东西拖过来，小助手每 0.05 秒看左键和光标，
// 在图标外按下、拖进图标范围报 enter，拖出去报 leave，进过图标后松手报 up；图标范围由这边换成实际像素发给它（rect x y 宽 高）。
// GGIF 退出（父进程没了）它自己就退。装好的包在 resources/，开发时在 native/bin/。
let helper = null;
let helperRect = '';
let helperTimer = null;
const WIN_TRAY_HOVER_MS = 400; // Windows 拖到托盘图标上停多久弹面板（Mac 0.2 秒；Windows 先让提示小窗露一下）
function winHelperPath() {
  const c = [path.join(process.resourcesPath || '', 'ggif-helper.exe'), path.join(here, 'native', 'bin', 'ggif-helper.exe')];
  return c.find((f) => existsSync(f)) || null;
}
/** 托盘图标的范围换成实际像素发给小助手（图标在 ^ 里藏着时范围是 0，小助手就不判断）；没变不发 */
function sendTrayRect() {
  if (!helper || !tray) return;
  let r = { x: 0, y: 0, width: 0, height: 0 };
  try {
    const b = tray.getBounds();
    if (b.width > 0 && b.height > 0) r = screen.dipToScreenRect(null, b);
  } catch {}
  const line = `rect ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)}`;
  if (line === helperRect) return;
  helperRect = line;
  try {
    helper.stdin.write(`${line}\n`);
  } catch {}
}
function onHelperEvent(j) {
  if (typeof j.fullscreen === 'boolean') {
    dropFull = j.fullscreen;
    if (dropFull) hideDropBlock();
    else showDropBlock();
  }
  if (j.tray === 'enter') {
    showTrayHint();
    trayDragEnter(WIN_TRAY_HOVER_MS);
  } else if (j.tray === 'leave') {
    trayDragLeave();
    hideTrayHint();
  } else if (j.tray === 'up') {
    hideTrayHint();
    trayDragEnd();
  }
}
function startHelper() {
  if (!WIN || helper) return;
  const h = winHelperPath();
  if (!h) {
    oplog?.log('小助手', '没找到 Windows 小助手：拖到托盘图标不会弹面板，全屏时投放块不会藏');
    return;
  }
  helper = spawn(h, ['watch', String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  helper.stdin.on('error', () => {});
  let buf = '';
  helper.stdout.on('data', (b) => {
    buf += b;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      try {
        onHelperEvent(JSON.parse(line));
      } catch {}
    }
  });
  helper.on('exit', () => {
    helper = null;
    helperRect = '';
  });
  sendTrayRect();
  clearInterval(helperTimer);
  helperTimer = setInterval(sendTrayRect, 3000); // 托盘图标会挪（别的图标增减、任务栏换边）：隔 3 秒看一次，变了才发
}
function stopHelper() {
  clearInterval(helperTimer);
  if (helper) helper.kill();
  helper = null;
}

// ---------- Windows 托盘提示小窗（W11e，作者：提示条做成聊天软件拖文件时的那种小提示窗）----------
// 文件一拖到托盘的 GGIF 图标上，图标正上方先冒这个小窗（像聊天软件的「文件拖到这…」）；停一下面板弹出来、嘴张开，它就收起；在它上面松手也能压。
let hintWin = null;
const HINT = { w: 236, h: 44 };
function makeTrayHint() {
  if (!WIN || (hintWin && !hintWin.isDestroyed())) return;
  hintWin = new BrowserWindow({
    width: HINT.w, height: HINT.h, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, type: 'toolbar',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  hintWin.loadFile(path.join(here, 'renderer', 'trayhint.html'), PAGE_OPTS);
}
function showTrayHint() {
  if (!WIN || !tray || (pop && pop.isVisible())) return; // 面板本来开着：直接张嘴，不用提示
  makeTrayHint();
  const b = tray.getBounds();
  if (!b.width) return;
  const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const a = d.workArea;
  const below = b.y < d.bounds.y + d.bounds.height / 2; // 任务栏在上面：小窗放图标下面
  const x = Math.min(Math.max(Math.round(b.x + b.width / 2 - HINT.w / 2), a.x + 4), a.x + a.width - HINT.w - 4);
  const y = below ? a.y + 6 : a.y + a.height - HINT.h - 6;
  hintWin.setBounds({ x, y, width: HINT.w, height: HINT.h });
  hintWin.showInactive();
}
function hideTrayHint() {
  if (hintWin && !hintWin.isDestroyed() && hintWin.isVisible()) hintWin.hide();
}
/** Windows 启动参数里要打开的文件（双击、拖到程序图标上、「打开方式」）：绝对路径、是 GIF 或视频、文件在 */
function argvFiles(argv) {
  return (argv || []).slice(1).filter((x) => typeof x === 'string' && !x.startsWith('-') && path.isAbsolute(x) && MEDIA_EXT.has(path.extname(x).toLowerCase()) && existsSync(x));
}

/**
 * 双击 GIF（本工具设成默认打开方式后）或拖到程序图标上：在后台按菜单栏当前的档位压，结果放在原文件旁边，完成发系统通知、进菜单栏列表。
 * 不弹窗口（作者：「在Finder中双击GIF，自动执行默认公众号压缩方案…完成后通过macOS原生通知提示」）。
 */
app.on('open-file', (e, file) => {
  e.preventDefault();
  // 访达里选中几个一起打开，系统一个一个发、前后差不到 1.5 秒：算同一次双击（小条里没压成的挡着自动收起，只看最近这一次的，D9）
  const fresh = Date.now() - lastOpenFileAt > 1500;
  lastOpenFileAt = Date.now();
  if (!app.isReady() || !pop) {
    openedWithFiles = true;
    pendingOpen.push(file);
    return;
  }
  openByDoubleClick([file], { fresh });
});

// ---------- 双击 GIF 的小条（作者：像下载列表，每次只弹这次的那几张） ----------
// 每次双击都在菜单栏图标下弹一个小条，不抢焦点（访达还在前台，可以接着双击）；连着双击往里加一行，最多显示 3 行。
// 都压完停 4 秒自动收；鼠标在上面、点进去了、正在拖、有没压成的，都不自动收。点图标或「全部」换成完整列表。
// 完整列表本来就开着时不弹小条，只在完整列表里高亮新行。小条开着时不另发系统通知（单个完成的通知本来就只在面板没开时发）。
let bubble = null; // { groups: [素材 id，新的在前], versions: [版本 id], timer }
const BUBBLE_HIDE_MS = 4000;

/** fresh：这是新的一次双击（不是和上一个一起打开的）。 */
async function openByDoubleClick(files, { fresh = true } = {}) {
  const fullListOpen = Boolean(pop?.isVisible() && !bubble); // 完整列表本来开着：照旧在完整列表里高亮，不换成小条
  parkForDoubleClick();
  for (const f of files) {
    const r = await enqueueFiles([f], { from: 'open' });
    const e = r.entries?.[0];
    if (!e) continue;
    if (fullListOpen) {
      if (!pop.isVisible()) {
        placePopover();
        pop.showInactive();
      }
      pushList();
      setTimeout(() => pop.webContents.send('tray-highlight', e.versionIds[0]), 200);
    } else {
      await showBubble(e.groupId, e.versionIds, { fresh });
      fresh = false; // 同一次里的后面几个
    }
  }
}

/**
 * 双击只走菜单栏（作者：「除了明确我要编辑时才弹出主界面，否则就应该只有图标就行了」）。
 * 双击时系统会把 GGIF 叫到前台，连主界面一起拉到最前、抢走焦点：主界面开着就先收起来（编辑内容不丢，
 * 点「完整界面」、双击列表里的行或程序坞图标再出来），再把 GGIF 从前台退下去，焦点还给原来的程序。小条不抢焦点地弹。
 */
let lastOpenFileAt = 0;
let parking = false;
function parkForDoubleClick() {
  if (WIN) return; // Windows：没有 app.hide()，双击打开时 GGIF 本来就不抢焦点（小条不抢焦点地弹）
  if (win && win.isVisible() && !win.isMinimized()) win.hide();
  parking = true;
  app.hide();
  setTimeout(() => {
    parking = false;
  }, 300);
}

/** 小条上还显示着的几行（最多 3 行）里，双击要的版本。 */
function bubbleVersions() {
  if (!bubble) return [];
  const shown = new Set(bubble.groups.slice(0, 3));
  return bubble.versions.map((id) => lib.findVersion(id)).filter((x) => x.version && shown.has(x.group.id)).map((x) => x.version);
}
function bubbleBusy() {
  return bubbleVersions().some((v) => ACTIVE_STATES.has(v.state));
}
/**
 * 没压成的挡着自动收起，只看最近这一次双击的（10-20 审查 D9：原来之前失败过一次，之后再双击别的、都压完了，小条也一直不收）。
 * 之前那次的失败已经给用户看过了；那一行在完整列表里照样标着「没做成」。
 */
function bubbleFailed() {
  return (bubble?.latest || []).some((id) => lib.findVersion(id).version?.state === 'failed');
}

function sizeBubble(h) {
  const hh = Math.max(64, Math.min(520, Math.ceil(h || 0)));
  if (WIN) {
    popSize = { w: 380, h: hh }; // W11g
    return placePopover();
  }
  pop.setSize(380, hh);
  placePopover();
}

async function showBubble(groupId, versionIds, { fresh = true } = {}) {
  await popReady;
  if (pop.isVisible() && !bubble) {
    // 完整列表开着：只高亮
    pushList();
    setTimeout(() => pop.webContents.send('tray-highlight', versionIds[0]), 200);
    return;
  }
  if (!bubble) bubble = { groups: [], versions: [], latest: [], timer: null };
  bubble.groups = [groupId, ...bubble.groups.filter((id) => id !== groupId)];
  bubble.versions.push(...versionIds);
  if (fresh) bubble.latest = []; // 新的一次双击（一次选中好几个双击算一次）
  bubble.latest.push(...versionIds);
  clearTimeout(bubble.timer);
  const h = await pop.webContents.executeJavaScript(`window.__compact(${JSON.stringify(bubble.groups)}, ${JSON.stringify(listForUi())})`);
  sizeBubble(h);
  if (!pop.isVisible()) pop.showInactive();
  maybeHideBubble();
}

/** 这次双击的都压完了、也都压成了，就过 4 秒收起（到时候鼠标在小条上、点进去了、正在拖，就再等等）。 */
function maybeHideBubble(ms = BUBBLE_HIDE_MS) {
  if (!bubble) return;
  clearTimeout(bubble.timer);
  if (bubbleBusy() || bubbleFailed()) return;
  bubble.timer = setTimeout(() => {
    if (!bubble || !pop.isVisible() || bubbleBusy() || bubbleFailed()) return;
    const c = screen.getCursorScreenPoint();
    const b = pop.getBounds();
    const inside = c.x >= b.x && c.x <= b.x + b.width && c.y >= b.y && c.y <= b.y + b.height;
    if (inside || dragging || pop.isFocused()) return maybeHideBubble(1500);
    pop.hide();
  }, ms);
}

/** 退出小条：恢复完整列表的样子和大小（收起、点图标、拖文件经过图标时）。 */
function exitBubble() {
  if (!bubble) return;
  clearTimeout(bubble.timer);
  bubble = null;
  pop.webContents.executeJavaScript('window.__compact(null)').catch(() => {});
  if (WIN) popSize = { w: 380, h: 520 }; // 下次摆的时候换回完整大小（W11g）
  else pop.setSize(380, 520);
}

ipcMain.on('tray-compact-height', (_e, h) => {
  if (bubble) sizeBubble(h);
});
ipcMain.handle('tray-show-all', () => showPopover());
ipcMain.handle('tray-bubble-close', () => pop.hide());
ipcMain.handle('tray-drop', async (_e, files) => {
  droppedInPanel = true;
  const r = await enqueueFiles(files);
  pop.focus(); // 松手后让面板拿到焦点，之后点别处它才会自己收起
  if (r.firstNew) setTimeout(() => pop.webContents.send('tray-highlight', r.firstNew), 300);
  return { added: r.added, rejected: r.rejected.length, folders: r.folders };
});

/**
 * ⌘V 粘贴导入（作者：「飞书的动图无法用拖拽，所以要做个粘贴导入」）。
 * Electron 44 的剪贴板是异步接口：read() 给出各条数据的类型，Mac 原生格式写成 `electron application/osclipboard;format="名字"`，
 * 名字常是旧式的（如「Apple PNG pasteboard type」），所以不按名字猜：每种数据都看一眼——
 * 文件网址 / 文件名列表 → 按原文件导入；内容以「GIF8」开头 → 完整动图；网页内容里嵌的 data:image/gif → 完整动图。
 * 只有静态图时明确提示、不导入（不能把第一帧当成动图）。不监听剪贴板，只在按 ⌘V 时读一次。
 */
const OS_FORMAT = /^electron application\/osclipboard;format="(.+)"$/;

function fileRefsFrom(text) {
  const out = [];
  const un = (x) => x.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  for (const m of text.matchAll(/<string>([^<]*)<\/string>/g)) out.push(un(m[1]));
  for (const m of text.matchAll(/file:\/\/[^\s"<>]+/g)) {
    try {
      out.push(fileURLToPath(m[0]));
    } catch {}
  }
  return out;
}

async function readClipboardMedia() {
  const items = await clipboard.read();
  const seen = []; // 类型名和大小（不含内容），读不到动图时记进日志方便排查
  let paths = [];
  let gif = null;
  let html = '';
  let hasImage = false;
  for (const it of items) {
    for (const t of it.types) {
      const fmt = t.match(OS_FORMAT)?.[1] || t;
      let blob;
      try {
        blob = await it.getType(t);
      } catch {
        continue;
      }
      if (!blob || typeof blob.size !== 'number') continue;
      seen.push(`${fmt}（${blob.size} 字节）`);
      if (/^image\//.test(t) || /png|tiff|jpeg|jpg/i.test(fmt)) hasImage = true;
      if (/file-url|NSFilenamesPboardType|uri-list|NSURLPboardType/i.test(fmt)) {
        paths.push(...fileRefsFrom(await blob.text()));
        continue;
      }
      if (t === 'text/html') {
        html = await blob.text();
        continue;
      }
      if (!gif && blob.size > 13 && blob.size < 300e6) {
        const head = Buffer.from(await blob.slice(0, 4).arrayBuffer()).toString('latin1');
        if (head === 'GIF8') gif = Buffer.from(await blob.arrayBuffer());
      }
    }
  }
  paths = [...new Set(paths)].filter((f) => MEDIA_EXT.has(path.extname(f).toLowerCase()) && existsSync(f));
  if (paths.length) return { paths };
  if (gif) return { gif };
  const m = html && html.match(/<img[^>]+src="data:image\/gif;base64,([^"]+)"/i);
  if (m) {
    const buf = Buffer.from(m[1], 'base64');
    if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return { gif: buf };
  }
  // 读不到：把类型名记下来（只有名字和大小）
  try {
    const log = path.join(path.dirname(lib.file), 'paste-types.log');
    await writeFile(log, `${new Date().toLocaleString('zh-CN')}\n${seen.join('\n')}\n网页内容里的图片地址开头：${[...html.matchAll(/<img[^>]+src="([^"]*)"/gi)].map((x) => (x[1].startsWith('data:') ? x[1].slice(0, 22) : x[1].split('/').slice(0, 3).join('/'))).join(' ')}\n\n`, { flag: 'a' });
  } catch {}
  // 飞书复制的图：剪贴板里只有第一帧静态图 + 一个要登录才能下载的飞书图片地址（10-18 实测 internal-api-drive-stream.feishu.cn）
  const feishu = /<img[^>]+src="https?:\/\/[^"/]*(feishu\.cn|larksuite\.com|feishucdn\.com)/i.test(html);
  return { none: true, hasImage, feishu };
}

ipcMain.handle('tray-paste', async () => {
  const r = await readClipboardMedia();
  if (r.paths) {
    const q = await enqueueFiles(r.paths, { from: 'paste' });
    if (!q.added) return { ok: false, reason: q.rejected.map((x) => `${x.name}：${x.reason}`).join('\n') || '没有可以压的 GIF 或视频。' };
    droppedInPanel = true;
    if (q.firstNew) setTimeout(() => pop.webContents.send('tray-highlight', q.firstNew), 300);
    return { ok: true, message: `已从剪贴板加入 ${q.added} 个文件，开始压缩` };
  }
  if (r.gif) {
    const dir = path.join(app.getPath('downloads'), 'GGIF粘贴');
    await mkdir(dir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const file = safeOutputPath(path.join(dir, `粘贴-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.gif`));
    await writeFile(file, r.gif);
    const frames = gifSummary(r.gif).frames;
    const q = await enqueueFiles([file], { from: 'paste' });
    if (!q.added) return { ok: false, reason: q.rejected.map((x) => x.reason).join('\n') };
    if (q.firstNew) setTimeout(() => pop.webContents.send('tray-highlight', q.firstNew), 300);
    return { ok: true, message: `已从剪贴板加入一张动图（${frames} 帧，${(r.gif.length / 1e6).toFixed(2)} MB），存在「下载/GGIF粘贴」，开始压缩` };
  }
  if (r.feishu) return { ok: false, reason: '这是从飞书复制的：剪贴板里只有第一帧静态图和一个要登录才能下载的飞书地址，读不到完整动图，没有导入。请在飞书里右键图片「下载」，再把下载的文件拖进来（或在访达里复制后按 ⌘V）。' };
  if (r.hasImage) return { ok: false, reason: '剪贴板里只有静态图（第一帧），读不到完整动图，没有导入。可以把动图另存为文件，再拖进来。' };
  return { ok: false, reason: '剪贴板里没有 GIF 或视频。' };
});
// 往外拖（菜单栏列表、主界面预览）的时候，菜单栏图标收到的拖拽是自己拖出去的，不叫面板张嘴（10-23 作者报：拖出来时嘴会张开）。
// 页面发「拖完了」就清掉，最多认 60 秒
let outDragAt = 0;
const outDragging = () => outDragAt && Date.now() - outDragAt < 60000;
ipcMain.on('drag-out-done', () => { outDragAt = 0; });
ipcMain.on('tray-drag', (e, all) => {
  // 真实文件拖拽（和从访达拖一样），拖到公众号图片库 / 正文就是上传这个文件
  const files = all.filter((f) => existsSync(f));
  if (files.length < all.length) {
    refreshFiles(); // 有的已经不在了：重查（改名、挪走的下次就找回了），这次先不拖它们
    pop.webContents.send('tray-toast', { text: files.length ? `有 ${all.length - files.length} 个文件已经不在了，这次只拖了 ${files.length} 个` : '这个文件已经不在了（删掉了，或者挪到了别处），列表刷新了，再拖一次试试', err: true });
    if (!files.length) return;
  }
  dragging = true;
  outDragAt = Date.now();
  const g = lib.groups.find((x) => x.versions.some((v) => v.file === files[0]));
  let icon = (g && dragIcons.get(g.id)) || nativeImage.createFromPath(path.join(here, 'assets', 'trayTemplate@2x.png'));
  icon = icon.resize({ width: 48 });
  e.sender.startDrag({ file: files[0], files, icon });
  setTimeout(() => {
    dragging = false;
  }, 500);
});
/** 主界面拖预览框（10-22 试用反馈 9.6d，作者选「A 跟着选中的用途」）：拖出去的是右边选中那档最近导出的 GIF；跟着鼠标的小图是页面画的（画面 + 档位和大小） */
ipcMain.on('main-drag', (e, { file, icon } = {}) => {
  if (!file || !existsSync(file)) {
    e.sender.send('main-drag-missing');
    return;
  }
  let img = null;
  try {
    if (icon) img = nativeImage.createFromBuffer(Buffer.from(String(icon).split(',')[1] || '', 'base64'), { scaleFactor: 2 });
  } catch {}
  if (!img || img.isEmpty()) img = nativeImage.createFromPath(path.join(here, 'assets', 'trayTemplate@2x.png')).resize({ width: 48 });
  remember(file);
  outDragAt = Date.now();
  e.sender.startDrag({ file, icon: img });
  oplog?.log('主界面', '拖走预览');
});
ipcMain.handle('tray-preview', async (_e, p) => {
  if (!p) return;
  if (!existsSync(p)) {
    const owner = lib.groups.flatMap((g) => g.versions).find((v) => v.file === p) || lib.groups.find((g) => g.source === p);
    await refreshFiles();
    const now = owner ? owner.file || owner.source : null;
    if (!now || !existsSync(now)) {
      pop.webContents.send('tray-toast', { text: '这个文件已经不在了（删掉了，或者挪到了别的硬盘），已从列表去掉', err: true });
      return;
    }
    p = now;
  }
  pop.previewFile(p);
});
ipcMain.handle('tray-edit', (_e, id) => editGroup(id));
ipcMain.handle('tray-open-main', () => showMain());
ipcMain.handle('tray-clear', () => {
  const gone = lib.clear();
  stashForUndo(gone, `已清空 ${gone.length} 行（文件都没动）`);
  return gone.length;
});
ipcMain.handle('tray-quit', () => app.quit());
/** 没做成的那一档重压一次：先排新的，再去掉失败的那个（反过来的话，只有这一个版本的行会先被整行去掉）。10-22 试用反馈 */
function retryVersion(versionId) {
  const { group: g, version: v } = lib.findVersion(versionId);
  if (!g || !v || v.state !== 'failed') return false;
  lib.requestGroup(g, v.preset, { mode: v.mode || 'fast', reuse: false });
  lib.dropVersion(v.id);
  oplog?.log('列表', '重试', { 素材: g.id, 段: g.range?.n, 档位: v.preset });
  return true;
}
ipcMain.handle('tray-retry', (_e, versionId) => retryVersion(Number(versionId)));

ipcMain.handle('tray-menu', (_e, { groupId, versionId, selected = [] }) => {
  const g = lib.findGroup(groupId);
  if (!g) return;
  const ids = selected.filter((id) => lib.findGroup(id));
  if (ids.length > 1 && ids.includes(groupId)) {
    // 选中的几行一起：只列能一起做的（作者：多选不弹操作条，「右键才出来操作选项」）
    const n = trashableOf(ids).length;
    // 做完就取消选中（作者：「每次多选只负责一次批量操作」）；菜单打开了又没选，选中照旧
    const once = (fn) => () => { fn(); pop?.webContents.send('tray-clear-sel'); };
    const items = [
      { label: `从列表移除这 ${ids.length} 行（文件不动）`, accelerator: 'Backspace', registerAccelerator: false, click: once(() => { const gone = lib.removeGroups(ids); stashForUndo(gone, `已从列表移除 ${gone.length} 行（文件都没动）`); }) },
      { label: n ? `把 ${n} 个压缩结果移到废纸篓（原素材不动）` : '这几行没有工具压出来的文件可以删', enabled: n > 0, accelerator: 'Command+Backspace', registerAccelerator: false, click: once(() => trashGroups(ids)) },
      { type: 'separator' },
      // 已经有这一档的行不重压（10-20 审查 M4：原来每行都重压一遍，多出「(1)」那份）；要重压某一行用那一行自己的右键
      ...PRESET_IDS.map((p) => {
        const mb = (PRESETS[p].limit / 1e6).toFixed(1);
        const need = ids.filter((id) => { const x = lib.findGroup(id); return x && !lib.doneFor(x, p); });
        const label = !need.length ? `这 ${ids.length} 行都有 ${mb}MB 的了` : need.length < ids.length ? `其中没有 ${mb}MB 的 ${need.length} 行各压一份（已有的不重压）` : `这 ${ids.length} 行各压一份 ${mb}MB`;
        return { label, enabled: need.length > 0, click: once(() => { for (const id of need) { const x = lib.findGroup(id); if (x) lib.requestGroup(x, p); } }) };
      }),
    ];
    Menu.buildFromTemplate(items).popup({ window: pop });
    return;
  }
  const fmt = (v) => `${(v.bytes / 1e6).toFixed(2)} MB · ${new Date(v.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  const items = [];
  const { version: v } = versionId ? lib.findVersion(versionId) : {};
  if (v) {
    const active = v.state === 'waiting' || v.state === 'running';
    if (active) items.push({ label: '取消', click: () => lib.cancel(v.id) });
    if (v.state === 'failed') items.push(v.tooLong ? { label: '打开完整界面剪短…', click: () => editGroup(g.id) } : { label: '重试', click: () => retryVersion(v.id) }, { type: 'separator' });
    if (v.file) {
      items.push(
        { label: '快速查看', click: () => pop.previewFile(v.file) },
        { label: '在访达中显示', click: () => shell.showItemInFolder(v.file) },
        { label: '复制文件路径', click: () => clipboard.writeText(v.file) },
      );
    }
    const hist = lib.historyOf(g.id, v.preset);
    if (hist.length) {
      items.push({
        label: `历史版本（${hist.length}）`,
        submenu: hist.map((h) => ({
          label: fmt(h),
          submenu: [
            { label: '快速查看', click: () => pop.previewFile(h.file) },
            { label: '在访达中显示', click: () => shell.showItemInFolder(h.file) },
            { label: '设为当前（列表里显示它、拖它）', click: () => lib.setCurrent(h.id) },
            ...(isOurResult(h) ? [{ label: '删除（移到废纸篓）', click: () => trashVersion(h) }] : []),
          ],
        })),
      });
    }
    items.push({ type: 'separator' });
    if (isOurResult(v)) items.push({ label: '删除这个版本（移到废纸篓）', click: () => trashVersion(v) });
    if (!active) items.push({ label: v.state === 'failed' ? '不要这一档了（去掉红块）' : '从列表移除这个版本（文件不动）', click: () => lib.dropVersion(v.id) });
    items.push({ type: 'separator' });
  }
  items.push({ label: '编辑…（打开完整界面）', click: () => editGroup(g.id) });
  for (const p of PRESET_IDS) {
    const has = lib.doneFor(g, p);
    items.push({ label: `${has ? '重新压一份' : '压一份'} ${(PRESETS[p].limit / 1e6).toFixed(1)}MB`, click: () => lib.requestGroup(g, p, { reuse: false }) });
  }
  if (existsSync(g.source)) items.push({ label: '在访达中显示原素材', click: () => shell.showItemInFolder(g.source) });
  items.push({ type: 'separator' });
  const n = trashableOf([g.id]).length;
  if (n) items.push({ label: `把压缩结果移到废纸篓（${n} 个，原素材不动）`, accelerator: 'Command+Backspace', registerAccelerator: false, click: () => trashGroups([g.id]) });
  if (g.range && existsSync(g.source) && isOwnRecordingFile(g.source)) items.push({ label: '把这次录屏的整段录像移到废纸篓（还没压的段一起去掉）', click: () => trashRecording(g) });
  items.push({ label: '从列表移除这个素材（文件不动）', accelerator: 'Backspace', registerAccelerator: false, click: () => { const gone = lib.removeGroups([g.id]); stashForUndo(gone, '已从列表移除 1 行（文件都没动）'); } });
  Menu.buildFromTemplate(items).popup({ window: pop });
});

// ---------- 录屏（录屏卷 3.1；作者批：苹果接口 + 系统选择窗口、不录鼠标、打了标只留打标的、整次没打标每 10 秒一片） ----------
let recorder = null;
let lastRecSession = null; // 最近一次录屏：{ id, dir, file, name, count, seconds, where, gifWhere }，菜单栏面板顶上那一条用
let recFellBack = false; // 这次录屏：设置里选的录像文件夹不在了，放回了默认的

/** 录屏小助手在哪：装好的包在 Contents/MacOS/，开发时在 native/bin/（app/scripts/build-recorder.mjs 编出来的）；GIFKIT_REC_HELPER 可以换成测试用的假小助手。 */
function recorderHelperPath() {
  if (process.env.GIFKIT_REC_HELPER) return process.env.GIFKIT_REC_HELPER;
  const cands = [path.join(process.resourcesPath || '', '..', 'MacOS', 'gifkit-recorder'), path.join(here, 'native', 'bin', 'gifkit-recorder')];
  return cands.find((p) => existsSync(p)) || cands.at(-1);
}

function setupRecorder() {
  if (!CAN_RECORD) return; // Windows 一期（压缩版）不做录屏：recorder 留空，用到它的地方都判断过
  const root = REC_ROOT();
  allowOwnRecordings(root); // 工具自己录的片段不受视频 100MB 导入上限（上限是给外来素材的；时长、长边照查）
  if (!process.env.GIFKIT_REC_DIR) allowOwnRecordings(REC_ROOT_OLD()); // 改名前录的
  if (prefs.recDir) allowOwnRecordings(REC_DEFAULT());
  recorder = new Recorder({
    helperPath: recorderHelperPath(),
    preload: path.join(here, 'preload.cjs'),
    rendererDir: path.join(here, 'renderer'),
    // 每次开录时取：设置里换过就用新的；选的文件夹不在了，这次放回默认的，录完提示一句（10-22 试用反馈 9.6b）
    clipsRoot: () => {
      const d = recRootNow();
      recFellBack = d !== REC_ROOT();
      if (recFellBack) oplog?.log('录屏', '录像文件夹不在了，这次放回默认的');
      allowOwnRecordings(d);
      return d;
    },
    run,
    ffmpeg: TOOLS.ffmpeg,
    getSettings: () => ({ autoCompress: recAuto, marking: recMark, fps: recFps, hotkeys: prefs.hotkeys, hotkeyText: { rec: hkText('rec'), mark: hkText('mark') }, recRegion: prefs.recRegion }),
    saveRegion: (r) => { prefs.recRegion = r; saveSettings(); }, // 开录时记下这次的框，下次直接用（10-22 试用反馈 9.6c）
    log: (...a) => console.log('[录屏]', ...a),
    ...(process.env.GIFKIT_REC_MAX_SEC ? { maxSec: Number(process.env.GIFKIT_REC_MAX_SEC) } : {}), // 调试：把 90 秒改短，测自动停
  });
  recorder.on('state', onRecState);
  // 开始录屏：主界面开着就先收起来（不关，内容不丢；录完不自动弹回）。作者：选区域、准备录制、录制后主界面都会抢到前面挡住要录的画面
  recorder.on('begin', () => {
    oplog?.log('录屏', '开始'); // 10-22 起选完屏幕直接出框，没有「选区域」这一步了
    if (win && win.isVisible()) win.hide();
  });
  recorder.on('session-done', onRecSessionDone);
  recorder.on('failed', (msg) => {
    oplog?.log('录屏', '没成', { 原因: msg });
    if (pop?.isVisible()) pop.webContents.send('tray-toast', { text: msg, err: true });
    else notify('error', { title: '录屏没成', body: msg })?.show();
  });
  recorder.on('set-auto', (on) => {
    recAuto = on;
    saveSettings();
    broadcastPrefs(); // 设置那层里的「录完自动压」跟着变
  });
  recorder.on('set-mark', (on) => setRecMark(on)); // 胶囊上的「打标」（11.12）
  recorder.on('set-fps', (n) => setRecFps(n)); // 胶囊上的录制帧率（11.13）
  recorder.hotkeyOk.rec = globalShortcut.register(prefs.hotkeys.rec, () => recorder.toggle());
  if (!recorder.hotkeyOk.rec) console.log(`[录屏] 快捷键 ${hkText('rec')} 注册不上，只能用按钮`);
  oplog?.log('快捷键', '注册', { 开始停止: prefs.hotkeys.rec, 注册上: recorder.hotkeyOk.rec, 切一刀: prefs.hotkeys.mark });
}

let lastRecTitle = '';
let lastRecLogged = '';
function onRecState(v) {
  if (v.state !== lastRecLogged) {
    // 操作日志：开录、停录（屏幕还是窗口、区域多大；窗口标题不记）
    if (v.state === 'recording') oplog?.log('录屏', '开录', { 录的: v.kind === 'window' ? '窗口' : '屏幕', 区域: v.region || undefined, 屏幕: v.display || undefined, 打标: recMark, 帧率: v.fps === HIFI_FPS ? '高保真' : v.fps, 切一刀的键: recMark ? prefs.hotkeys.mark : undefined, 注册上: recMark ? recorder?.hotkeyOk.mark : undefined });
    else if (v.state === 'stopping') oplog?.log('录屏', '停录', { 录了秒: Math.round(v.elapsed || 0), 切刀: v.cuts?.length || 0, 帧: v.frames ?? undefined, 丢帧: v.dropped ?? undefined });
    lastRecLogged = v.state;
  }
  // 菜单栏图标旁边显示录了多久（不用开面板也知道在录）
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const title = v.state === 'recording' ? ` ● ${clock(v.elapsed)}${v.cuts?.length ? ` 第${v.segment}段` : ''}` : v.state === 'stopping' ? ' 整理中…' : '';
  if (title !== lastRecTitle) {
    lastRecTitle = title;
    tray?.setTitle(title);
  }
  pop?.webContents.send('tray-rec-state', { state: v.state });
}

function onRecSessionDone(s) {
  oplog?.log('录屏', s.file && s.ranges.length ? '分好段' : '没录到画面', { 段数: s.ranges?.length || 0, 时长秒: s.seconds ? +Number(s.seconds).toFixed(1) : undefined, 切刀: s.cuts, 说明: s.message || undefined });
  if (!s.file || !s.ranges.length) {
    const text = s.message || '这次没录到画面（录得太短，或者录屏被打断了）';
    if (pop?.isVisible()) pop.webContents.send('tray-toast', { text, err: true });
    else notify('error', { title: '录屏结束', body: text })?.show(); // 只在没录到画面时发；录成了是弹出菜单栏面板，不发通知
    return;
  }
  // 每段一行（倒着加，第 1 段排在最上面），整段录像只有一份，每段只记起止
  for (const r of [...s.ranges].reverse()) makeThumb(lib.addRange(s.file, r, { label: r.label, session: s.id, rec: true, prefix: recPrefix(s.id) }));
  // where：录像放在哪（给人看的）；gifWhere：GIF 不和录像放一起（设置了「结果放哪」）时放在哪
  lastRecSession = { id: s.id, dir: s.dir, file: s.file, name: path.basename(s.dir), count: s.ranges.length, seconds: s.seconds, cuts: s.cuts, fps: s.fps, fitSec: fitSecOf(s.fps), where: placeText(path.dirname(s.dir)), gifWhere: resultDirFor(s.file) !== path.dirname(s.file) ? placeText(resultDirFor(s.file)) : '' };
  pushList();
  // 停录后把面板亮出来（不抢焦点），顶上一条「全部压缩」；开了「录完自动压」就直接压
  if (quitting) return; // 退出前停的录屏：段进列表、存盘就行，不弹面板、不自动压（压到一半退出，段就丢了）
  if (!pop.isVisible()) showPopover({ inactive: true });
  pop.webContents.send('tray-rec-session', lastRecSession);
  if (s.message) pop.webContents.send('tray-toast', { text: s.message });
  else if (recFellBack) pop.webContents.send('tray-toast', { text: `设置里选的录像文件夹不在了，这次放进了 ${placeText(path.dirname(s.dir))}`, long: true });
  recFellBack = false;
  if (recAuto) compressRecSession(s.id);
}

/** 「全部压缩」：这次录屏还没压的段，按菜单栏当前档位（含两种都要）排进队列，一批跑完给汇总。 */
async function compressRecSession(id) {
  // 超过 fit 秒的段一定压不进（11.12：打标关着时整段一份，常常一分多钟），不排队、留成「待压缩」，免得白跑一遍再报「太长」。
  // fit：高保真 37.5 秒；录制时选了帧率的（11.13，录像里记着）是 300 ÷ 帧率
  const pend = lib.pendingOf(id);
  let fps = lastRecSession?.id === id ? lastRecSession.fps : null;
  if (fps == null && pend[0]?.source) fps = (await probe(pend[0].source).catch(() => null))?.lockFps || null;
  const fit = fitSecOf(fps);
  const groups = pend.filter((g) => !g.range || g.range.end - g.range.start <= fit + 0.01)
    .sort((a, b) => (a.range?.n || 0) - (b.range?.n || 0)); // 第 1 段先压（10-20 审查 B11：原来多翻了一次，最后一段先压）
  if (!groups.length) return { added: 0, rejected: 0 };
  const order = trayDual ? PRESET_IDS : [trayPreset];
  const entries = [];
  for (const g of groups) {
    const got = order.map((p, k) => lib.requestGroup(g, p, { skipIfSatisfied: k > 0 }));
    entries.push({ file: g.source, groupId: g.id, primary: got[0].version.id, reused: Boolean(got[0].reused), versionIds: got.filter((r) => r.version).map((r) => r.version.id) });
  }
  trackBatch(entries, { from: 'rec' });
  pushList();
  return { added: entries.length, rejected: 0 };
}

ipcMain.on('rec-action', (_e, a) => recorder?.action(a));
ipcMain.handle('tray-rec-toggle', () => {
  if (recorder?.state === 'idle') pop?.hide(); // 开始选区域：面板先收起来，免得挡着
  return recorder?.toggle();
});
ipcMain.handle('tray-rec-compress', (_e, id) => compressRecSession(id));
ipcMain.handle('rec-start', () => (recorder?.state === 'idle' ? recorder.toggle() : undefined)); // 主界面标题行的「录屏」

/**
 * 调试（GIFKIT_REC_TEST=cuts|slices|auto，配 GIFKIT_REC_HELPER=假小助手）：自己走一遍选区域 → 开录 → 切两刀 / 不切 / 等自动停 → 停录，
 * 各截一张图，打印分段；GIFKIT_REC_TEST_COMPRESS=1 再「全部压缩」；最后在主界面打开第 2 段（或第 1 段）截图，看整段录像、这段选好没有。
 */
async function runRecTest(mode) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (pred, ms = 15000) => {
    for (let i = 0; i < ms / 100 && !pred(); i++) await sleep(100);
    if (!pred()) throw new Error(`等了 ${ms} 毫秒，录屏状态还是 ${recorder.state}`);
  };
  const out = process.env.GIFKIT_REC_SHOTS || '/tmp/gk/rec';
  const shot = async (w, name) => {
    if (w && !w.isDestroyed()) await writeFile(path.join(out, name), (await w.webContents.capturePage()).toPNG());
  };
  let testWin = null;
  try {
    await mkdir(out, { recursive: true });
    if (!/fake-recorder/.test(recorder.helperPath)) {
      // 真小助手：要用户在系统选择窗口里点屏幕；先放一个会动的测试画面在要录的那块，录的只是它（不录屏幕上别的东西）
      testWin = new BrowserWindow({ x: 120, y: 140, width: 960, height: 540, frame: false, show: false, resizable: false });
      await testWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<body style="margin:0;background:#202830;overflow:hidden"><canvas id=c width=960 height=540></canvas><script>const x=c.getContext("2d");function f(t){x.fillStyle="#202830";x.fillRect(0,0,960,540);x.fillStyle="hsl("+(t/20%360)+",80%,55%)";x.fillRect(t/4%960,330,120,160);x.fillStyle="#fff";x.font="bold 120px Menlo";x.fillText(String(Math.floor(t)).padStart(7,"0"),120,250);requestAnimationFrame(f)}requestAnimationFrame(f)</script></body>')}`);
      testWin.showInactive();
      console.log('请在系统选择窗口里点「整个屏幕」（最多等 5 分钟）');
    }
    if (process.env.GIFKIT_REC_TEST_MAIN === '1') {
      // 主界面开着时开始录屏：应该先收起来，不挡要录的画面（作者）
      showMain();
      await sleep(1500);
      console.log('开始录屏前主界面：', JSON.stringify({ 显示: Boolean(win?.isVisible()) }));
    }
    recorder.toggle();
    await until(() => recorder.state === 'region' || recorder.state === 'armed', 300000);
    console.log('按 ⌃⌥R 以后：', JSON.stringify({ 状态: recorder.state, 框: recorder.region, 设置里记的: prefs.recRegion })); // 10-22 起选了屏幕直接是 armed、用上次的框
    if (process.env.GIFKIT_REC_TEST_MAIN === '1') console.log('开始录屏后主界面：', JSON.stringify({ 显示: Boolean(win?.isVisible()), 还在: Boolean(win && !win.isDestroyed()) }));
    if (recorder.state === 'region') {
      await sleep(900);
      const rw = recorder.win.region.webContents;
      await rw.executeJavaScript('window.__debugSelect({ x: 120, y: 140, w: 900, h: 540 })');
      await sleep(300);
      // 真实鼠标拖框的右边：900 → 960（作者：「只能重新划区域改变大小，不能拖动边框改变」）
      rw.sendInputEvent({ type: 'mouseMove', x: 1020, y: 400 });
      await sleep(60);
      rw.sendInputEvent({ type: 'mouseDown', x: 1020, y: 400, button: 'left', clickCount: 1 });
      for (const x of [1040, 1060, 1080]) {
        await sleep(40);
        rw.sendInputEvent({ type: 'mouseMove', x, y: 400, button: 'left' });
      }
      await sleep(40);
      rw.sendInputEvent({ type: 'mouseUp', x: 1080, y: 400, button: 'left', clickCount: 1 });
      await sleep(200);
      console.log('选区域层拖右边以后：', await rw.executeJavaScript('JSON.stringify(sel)'));
      await shot(recorder.win.region, '测_区域层.png');
      recorder.toggle(); // 相当于拖好框后按 ⌃⌥R（和回车一样确定这一块）
      await until(() => recorder.state === 'armed');
    }
    await sleep(900);
    await shot(recorder.win.bar, '测_准备好.png');
    await shot(recorder.win.outline, '测_录制框_准备好.png');
    if (recorder.picked?.kind === 'display' && process.env.GIFKIT_REC_TEST_DRAG !== '0') {
      // 准备好以后直接拖录制框的右边 +80（作者：「确认选框后，是不能拖动边框改变了吗」）
      const ow = recorder.win.outline;
      const ob = ow.getBounds();
      const before = { ...recorder.region };
      const at = (x, y) => ({ x, y, globalX: ob.x + x, globalY: ob.y + y });
      const y0 = Math.round(ob.height / 2);
      ow.webContents.sendInputEvent({ type: 'mouseMove', ...at(ob.width - 6, y0) });
      await sleep(120);
      console.log('鼠标到右边框线上：', JSON.stringify(await ow.webContents.executeJavaScript('window.__frameState()')));
      ow.webContents.sendInputEvent({ type: 'mouseDown', ...at(ob.width - 6, y0), button: 'left', clickCount: 1 });
      for (const k of [1, 2, 3, 4]) {
        await sleep(40);
        ow.webContents.sendInputEvent({ type: 'mouseMove', x: ob.width - 6, y: y0, globalX: ob.x + ob.width - 6 + k * 20, globalY: ob.y + y0, button: 'left' });
      }
      await sleep(40);
      ow.webContents.sendInputEvent({ type: 'mouseUp', x: ob.width - 6, y: y0, globalX: ob.x + ob.width - 6 + 80, globalY: ob.y + y0, button: 'left', clickCount: 1 });
      await sleep(300);
      console.log('拖录制框右边以后：', JSON.stringify({ 之前: before, 之后: recorder.region, 框: ow.getBounds(), 胶囊: recorder.win.bar?.getBounds() }));
      await shot(recorder.win.outline, '测_录制框_拖大以后.png');
    }
    if (recorder.picked?.kind === 'display' && process.env.GIFKIT_REC_TEST_DRAG !== '0') {
      // 10-22 试用反馈：按住胶囊左头（把手、空白处）拖 (+70, +40)，整个框跟着走
      const bw = recorder.win.bar;
      const bb = bw.getBounds();
      const before = { ...recorder.region };
      const p0 = { x: 14, y: Math.round(bb.height / 2) };
      const ev = (type, dx, dy, extra = {}) => bw.webContents.sendInputEvent({ type, x: p0.x, y: p0.y, globalX: bb.x + p0.x + dx, globalY: bb.y + p0.y + dy, button: 'left', clickCount: 1, ...extra });
      ev('mouseMove', 0, 0);
      await sleep(80);
      ev('mouseDown', 0, 0);
      for (const k of [1, 2, 3, 4]) {
        await sleep(40);
        ev('mouseMove', Math.round(k * 17.5), k * 10, { modifiers: ['leftButtonDown'] });
      }
      await sleep(40);
      ev('mouseUp', 70, 40);
      await sleep(300);
      console.log('拖胶囊以后：', JSON.stringify({ 之前: before, 之后: recorder.region, 挪了: { x: recorder.region.x - before.x, y: recorder.region.y - before.y }, 框: recorder.win.outline.getBounds(), 胶囊: bw.getBounds() }));
      await shot(recorder.win.bar, '测_拖胶囊以后.png');
    }
    console.log('控制条（准备好）：', JSON.stringify(recorder.win.bar?.getBounds()), '有没有「拖一块」层：', Boolean(recorder.win.region && !recorder.win.region.isDestroyed()));
    recorder.toggle(); // 相当于按 ⌃⌥R
    await until(() => recorder.state === 'recording');
    if (mode === 'cuts') {
      await sleep(2500);
      await recorder.mark(); // 相当于按 ⌥空格 切一刀
      await sleep(120);
      await shot(recorder.win.bar, '测_切第一刀.png'); // 竖线正在往上弹
      await sleep(2400);
      await recorder.mark();
      await sleep(1500);
      await shot(recorder.win.bar, '测_切了两刀.png');
      await shot(recorder.win.outline, '测_录制框_切了两刀.png');
      console.log('录制框、胶囊的位置：', JSON.stringify({ 框: recorder.win.outline?.getBounds(), 胶囊: recorder.win.bar?.getBounds() }));
      console.log('切了两刀时菜单栏图标旁的字：', JSON.stringify(lastRecTitle));
      await sleep(600);
      await recorder.stop();
    } else if (mode === 'quit') {
      // 录到一半退出（10-20 审查 B1）：切一刀后直接退出 App；下次启动用 GIFKIT_DEBUG_LISTFS=reload 看这次录的两段在不在列表里
      await sleep(2500);
      await recorder.mark();
      await sleep(1500);
      console.log('录到一半退出：', JSON.stringify({ 状态: recorder.state, 切了: recorder.session?.cuts?.length ?? null, 临时文件夹: recorder.session?.tmp || null }));
      app.quit();
      return;
    } else if (mode === 'auto') {
      // 上限改短了（GIFKIT_REC_MAX_SEC）：不按停，等它自己停；快到头时截一张看尾巴变红
      await sleep(Math.max(0, (recorder.maxSec - 2) * 1000));
      await shot(recorder.win.bar, '测_快到头.png');
      await shot(recorder.win.outline, '测_录制框_快到头.png');
      await until(() => recorder.state === 'idle', 20000);
    } else {
      await sleep(7000);
      await shot(recorder.win.bar, '测_录制中.png');
      await recorder.stop();
    }
    await sleep(1500);
    pushList();
    await sleep(800);
    await writeFile(path.join(out, '测_菜单栏.png'), (await pop.webContents.capturePage()).toPNG());
    const segs = lib.pendingOf(lastRecSession?.id).map((g) => ({ 名字: g.name, 起: g.range?.start, 止: g.range?.end }));
    console.log('录屏测试结果：', JSON.stringify({ 模式: mode, 这次: lastRecSession, 分段: segs, 自动停提示: recorder.message || '' }));
    if (process.env.GIFKIT_REC_TEST_COMPRESS === '1') {
      console.log('全部压缩：', JSON.stringify(await compressRecSession(lastRecSession.id)));
      // 等压完：看列表里还有没有排队、在压的。开着「录完自动压」时这会儿可能已经压完了，原来等「空闲」通知会一直等不到（10-23 踩过）
      await until(() => !lib.groups.some((g) => g.versions.some((v) => v.state === 'waiting' || v.state === 'running')), 90000);
      await sleep(1200);
      await writeFile(path.join(out, '测_压完.png'), (await pop.webContents.capturePage()).toPNG());
      // 10-23：录屏压完，面板顶上不该有「刚录的几段」那条（除非还有待压缩的）、也不弹「这批压完了」
      console.log('压完后面板顶上：', JSON.stringify(await pop.webContents.executeJavaScript(`({ 录屏那条: !document.getElementById('recSession').classList.contains('hidden'), 提示: document.getElementById('toast')?.classList.contains('show') ? document.getElementById('toast').textContent : '' })`)));
      console.log('压完：', JSON.stringify(lib.groups.filter((g) => g.range).map((g) => ({ 名字: g.name, 版本: g.versions.map((v) => ({ 档: v.preset, 状态: v.state, 帧: v.frames, 秒: v.durationSec, 文件: v.file && path.basename(v.file) })) }))));
    }
    // 在主界面打开一段：整段录像、这段选好
    const g = lib.groups.find((x) => x.range?.n === 2) || lib.groups.find((x) => x.range);
    if (g) {
      await editGroup(g.id);
      await sleep(3500);
      const st = await win.webContents.executeJavaScript('({ 文件: S.file && S.file.split("/").slice(-2).join("/"), 整段: S.duration, 选段: [S.start, S.end], 说明: document.getElementById("editNote").textContent })');
      console.log('主界面打开一段：', JSON.stringify({ 段: g.name, ...st }));
      await writeFile(path.join(out, '测_主界面打开一段.png'), (await win.webContents.capturePage()).toPNG());
      const rows = () => lib.groups.filter((x) => x.range && x.source === g.source).map((x) => ({ 名字: x.name, 起: x.range.start, 止: x.range.end, 待压缩: Boolean(x.pending), 不算了: Boolean(x.range.off) }));
      const bar = () => win.webContents.executeJavaScript('JSON.stringify({ 段: S.segs.map((s) => [s.start, s.end, s.gid]), 选中: S.sel + 1, 提示: document.getElementById("markHint").textContent })');
      console.log('主界面条上：', await bar());
      if (process.env.GIFKIT_REC_TEST_MARKS === '1') {
        // 主界面打标（TODO 2.74）：在选中那段中间切一刀 → 菜单栏多一行；删掉这一刀 → 那行去掉；改第 1 段的起止 → 那行名字跟着变
        await win.webContents.executeJavaScript('(() => { const s = S.segs[S.sel]; $("video").currentTime = (s.start + s.end) / 2; pausePreview(); })()');
        await sleep(400);
        await win.webContents.executeJavaScript('cutHere()');
        await sleep(900);
        console.log('切一刀以后：', await bar(), JSON.stringify(rows()));
        await writeFile(path.join(out, '测_主界面切一刀.png'), (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript('mergeAt(S.segs.length > 2 ? 2 : 1)');
        await sleep(900);
        console.log('删掉这一刀以后：', await bar(), JSON.stringify(rows()));
        await win.webContents.executeJavaScript('selectSeg(0); setTrim(S.start + 0.4, S.end - 0.2)');
        await sleep(900);
        console.log('改第 1 段起止以后：', await bar(), JSON.stringify(rows()));
      }
    }
  } catch (e) {
    console.log('录屏测试出错：', e.stack || e.message);
  }
  testWin?.destroy();
  setTimeout(() => app.quit(), 300);
}

// ---------- 完整界面 ----------
ipcMain.handle('info', async () => ({
  presets: Object.values(PRESETS).map(({ id, name, limit, hint, maxFrames }) => ({ id, name, limit, hint, maxFrames })),
  // 主界面记住上次的档位和速度（设置里能关，10-22）；从菜单栏「编辑」进来照旧用那一行的
  defaultPreset: (prefs.rememberPreset && prefs.mainPreset) || DEFAULT_PRESET,
  defaultSpeed: (prefs.rememberPreset && prefs.mainSpeed) || 'fast',
  skipRatio: SKIP_RATIO,
  fitRatio: FIT_RATIO,
  floor: QUALITY_FLOOR,
  missing: missingTools(),
  mediaExt: [...MEDIA_EXT], // 主界面拖进来、选进来的文件按它认（和菜单栏同一份）
  debugOpen: process.env.GIFKIT_OPEN || null,
  debugExport: process.env.GIFKIT_EXPORT === '1',
  debugBatch: process.env.GIFKIT_BATCH ? process.env.GIFKIT_BATCH.split('|') : null, // 当作在主界面拖进这几个（交给菜单栏批量压）
  debugHelp: process.env.GIFKIT_HELP || null, // 1：打开设置那层截设置页；help：截帮助页（10-22 设置卷）
  debugCustom: process.env.GIFKIT_DEBUG_CUSTOM === '1',
  debugPanel: process.env.GIFKIT_PANEL === '1', // 截图时展开体积下拉面板
  debugClear: process.env.GIFKIT_CLEAR === '1', // 截图前点一下「移除」
  debugEditPreset: process.env.GIFKIT_TRAY_EDIT_PRESET || null,
  debugPreview: process.env.GIFKIT_DEBUG_PREVIEW === '1', // 自己点画面、点时间轴，打印播放状态
  debugKeys: process.env.GIFKIT_DEBUG_KEYS === '1', // 自己按空格、回车，打印播放和裁画面框的状态
  debugMarks: process.env.GIFKIT_DEBUG_MARKS || null, // 1：自己切两刀、选段、展开、删刀、撤销，每步打印、截图；export：切两刀后导出几段、再选一段导出
  timelineOpen: prefs.rememberTimeline ? timelineOpen : false, // 设置里关了「记住时间轴」就每次收起（10-22）
  prefs: uiPrefs(),
}));

ipcMain.handle('set-pref', (_e, p) => {
  if (p && 'timelineOpen' in p) timelineOpen = Boolean(p.timelineOpen);
  if (p && PRESET_IDS.includes(p.mainPreset)) prefs.mainPreset = p.mainPreset; // 主界面上次选的档位、速度（10-22 设置卷）
  if (p && SPEED_IDS.includes(p.mainSpeed)) prefs.mainSpeed = p.mainSpeed;
  saveSettings();
});

ipcMain.handle('cancel', async () => {
  running?.abort();
  return Boolean(running);
});

/** 选文件：可以多选、也可以选文件夹（多个或文件夹就交给菜单栏批量压）。 */
ipcMain.handle('pick-file', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: '视频或 GIF', extensions: [...MEDIA_EXT].map((x) => x.slice(1)) }],
  });
  if (r.canceled) return null;
  const anyDir = r.filePaths.some((f) => {
    try {
      return statSync(f).isDirectory();
    } catch {
      return false;
    }
  });
  return { paths: r.filePaths, anyDir };
});

ipcMain.handle('probe', async (_e, file) => {
  remember(file);
  const info = await probe(file);
  oplog?.log('素材', '主界面打开', mediaFacts(info, file, existsSync(file) ? statSync(file).size : 0));
  // 主界面打开来剪、打标的视频不受 100MB 体积上限（作者选「主界面打开不限体积（推荐）」），也不受 5 分钟时长上限（作者「可以改进」）；长边、GIF 的上限照查
  const limit = checkInputLimits(info, (await stat(file)).size, file, { ignoreBytes: true, ignoreSeconds: true });
  return { info, color: colorPlan(info), url: pathToFileURL(file).href, limit };
});

let estAc = null; // 正在算的预估
const proxyCache = new Map(); // 预估的代理体积：键 → { bytes, n, w, h, ms }，最多记 40 条
ipcMain.handle('estimate', async (_e, a) => {
  const info = await probe(a.file);
  const color = colorPlan(info, a.color);
  const preset = resolvePreset(a.preset);
  // 选段在这一档超过 300 帧：公众号放不下，也不值得去解码（85 秒的录像会解出约 1.5GB 临时帧），直接让用户先剪短
  // 多选拼起来的（11.14）：起点是第一段的开头、时长是几段之和，和 convertFile 算法一样（预估的实测比率才对得上）
  const parts = joinRanges(a.ranges);
  const start = parts ? parts[0].start : a.start || 0;
  const dur = parts ? joinedDur(parts) : a.dur;
  const expect = Math.round(dur * a.fps);
  if (expect > preset.maxFrames) return { tooLong: true, frames: expect, maxDur: Math.floor((preset.maxFrames / a.fps) * 10) / 10, fps: a.fps };
  // 10-31 负载优化：一条 ffmpeg 从原片直出代理 GIF、只数字节（原来每次把原始帧写进缓存，改一次起止写几百 MB、留到换文件或退出）；
  // 代理体积按「文件、起止、裁剪、色彩、宽、帧率」记住，换档位不重算；新的来了就取消还没算完的旧的（界面本来就丢掉旧结果）
  const pkey = JSON.stringify([path.resolve(a.file), start, dur, a.crop || null, color.filter || '', a.width, a.fps, ...(parts ? [parts] : [])]);
  let px = proxyCache.get(pkey);
  if (!px) {
    estAc?.abort();
    const ac = new AbortController();
    estAc = ac;
    try {
      px = await proxyFromSource({ file: a.file, info, color, start, dur, ranges: parts || undefined, width: a.width, fps: a.fps, crop: a.crop || undefined }, { signal: ac.signal });
    } finally {
      if (estAc === ac) estAc = null;
    }
    if (!px.n) throw new Error('一帧都没取到：起止时间超出了片长？');
    proxyCache.set(pkey, px);
    if (proxyCache.size > 40) proxyCache.delete(proxyCache.keys().next().value);
  }
  const fillOn = a.fill !== false;
  const limit = preset.limit - (fillOn ? 29 * Math.max(0, preset.minFrames - px.n) : 0);
  // key 和 convertFile 里的写法一致，导出时测到的实测比率能用来校正之后的预估
  const est = estimateFromProxy(px.bytes, { limit, key: `${path.resolve(a.file)}|${start}|${dur}|null|${color.convert}${parts ? `|${JSON.stringify(parts)}` : ''}`, ms: px.ms });
  return { ...est, frames: px.n, width: px.w, height: px.h, limit, ratio: est.estimate / limit, color };
});

/**
 * 自定义模式的「实时体积」：按当前参数真编一次（作者：「我都手动了，肯定不在乎是否快速高效和性能开销了，只在乎我能不能调对」）。
 * 新的一次来了就把上一次还没编完的作废。结果留着，导出时参数没变就直接用（lastLive），不再重编。
 */
let liveAc = null;
let lastLive = null; // { key, file, result }
ipcMain.handle('live-encode', async (_e, a) => {
  liveAc?.abort();
  const ac = new AbortController();
  liveAc = ac;
  const dir = await workFor(a.file, 'live');
  const out = path.join(dir, `live_${Date.now()}.gif`);
  const t0 = Date.now();
  try {
    const r = await convertFile(a.file, out, {
      preset: a.preset, mode: 'fast', start: a.start, dur: a.dur, ranges: a.ranges, crop: a.crop || undefined, fill: a.fill, color: a.color,
      manual: a.manual, overwrite: true, signal: ac.signal, ignoreByteLimit: true, ignoreDurationLimit: true,
    });
    if (ac.signal.aborted) return { cancelled: true };
    const ms = Date.now() - t0;
    if (r.output && existsSync(r.output)) {
      if (lastLive?.file && lastLive.file !== r.output) rm(lastLive.file, { force: true });
      lastLive = { key: a.liveKey, file: r.output, result: r };
      const d = await describe(r.output);
      return { ok: r.ok, bytes: d.bytes, width: d.width, height: d.height, frames: d.frames, durationSec: d.durationSec, ms, notes: r.manual?.notes || [] };
    }
    // 画质固定、装不下时引擎不出文件，但量过体积：报出来让用户知道超了多少
    const over = Math.max(0, ...(r.tried || []).map((t) => t.bytes || 0));
    return { ok: false, ms, reason: r.reason || '没编出来', overBytes: over || null, notes: r.manual?.notes || [] };
  } catch (err) {
    if (ac.signal.aborted || /已取消/.test(String(err.message))) return { cancelled: true };
    return { ok: false, reason: String(err.message || err) };
  } finally {
    if (liveAc === ac) liveAc = null;
  }
});

/** 主界面导出：前后各记一行操作日志（第二批） */
async function loggedConvert(e, a) {
  const t0 = Date.now();
  remember(a.file);
  oplog?.log('导出', '开始', { 档位: a.preset, 模式: a.mode, 段: a.range?.n, 拼几段: a.ranges?.length || undefined, 起秒: a.start, 长秒: a.dur ? +a.dur.toFixed(2) : undefined, 裁画面: Boolean(a.crop) || undefined, 宽: a.width, 帧率: a.fps, 自定义改了: a.manual ? Object.keys(a.manual) : undefined, 放进: activeOutDir() ? '指定文件夹' : '原文件旁边' });
  try {
    const r = await convertJob(e, a);
    if (r?.output) remember(r.output);
    oplog?.log('导出', r?.ok ? '完成' : '没做成', { 动作: r?.action, 体积MB: r?.bytes ? +(r.bytes / 1e6).toFixed(2) : undefined, 用时秒: +((Date.now() - t0) / 1000).toFixed(1), 原因: r?.ok ? undefined : r?.reason || r?.detail });
    return r;
  } catch (err) {
    oplog?.log('导出', '出错', { 原因: err.message, 用时秒: +((Date.now() - t0) / 1000).toFixed(1) });
    throw err;
  }
}
ipcMain.handle('convert', async (e, a) => {
  const debugClose = Number(process.env.GIFKIT_DEBUG_CLOSE_MS) || 0;
  if (!debugClose) return loggedConvert(e, a);
  // 调试：导出开始后过一会儿关掉主界面，看导出还做不做得完、进不进菜单栏，打印结果后退出
  setTimeout(() => win?.close(), debugClose);
  try {
    const r = await convertJob(e, a);
    console.log('关窗测试：', JSON.stringify({ ok: r.ok, output: r.output || null, reason: r.reason || null }));
    return r;
  } catch (err) {
    console.log('关窗测试：出错', String(err.message || err));
    throw err;
  } finally {
    setTimeout(() => app.quit(), 1500);
  }
});

async function convertJob(e, a) {
  // 导出途中关了主界面：窗口没了就不再发进度，导出照常做完、进菜单栏（10-19 晚查出：往关掉的窗口发进度会抛错，这次导出就失败了）
  const onProgress = (p) => {
    if (!e.sender.isDestroyed()) e.sender.send('progress', p);
  };
  // 自定义：参数和刚才实时真编的一样，就直接用那个结果
  const rg = a.groupId ? lib.findGroup(a.groupId) : null;
  const segN = a.range?.n || (rg?.range && rg.source === a.file ? rg.range.n : null);
  const outDir = resultDirFor(a.file); // 原文件旁边，或设置里指定的文件夹（10-22 第二批）
  const outBase = `${resultBase(a.file, outDir)}${segN ? `_第${segN}段` : ''}`;
  const rec = async (output, action) => {
    lastRecordedGroup = null;
    const o = await recordExport({ groupId: a.groupId, output, source: a.file, preset: a.preset, mode: a.mode, edit: a.edit, action, range: a.range });
    // 体积带回去：导出成功时主界面标题行写「已导出 9.80 MB」（作者：不再弹结果面板）
    return { output: o, groupId: lastRecordedGroup, bytes: o && existsSync(o) ? statSync(o).size : null };
  };
  if (a.liveKey && lastLive?.key === a.liveKey && existsSync(lastLive.file)) {
    const base = path.join(outDir, `${outBase}${resolvePreset(a.preset).fileSuffix}.gif`);
    const out = safeOutputPath(base);
    await copyFile(lastLive.file, out);
    const { output, groupId, bytes } = await rec(out, '压缩');
    return { ...lastLive.result, output, groupId, bytes, reused: true };
  }
  const ac = new AbortController();
  running = ac;
  try {
    const info0 = await probe(a.file);
    const trimmed = a.ranges?.length > 1 || (a.start || 0) > 0.005 || (a.dur && info0.duration && a.dur < info0.duration - 0.05) || a.crop;
    if (info0.kind === 'gif' && !trimmed) {
      // GIF 没裁剪：按批量的规则，合规的不动，只是帧数不够的只凑帧，超标的才重压缩
      const r = await batch([a.file], outDir, { preset: a.preset, mode: a.mode, fill: a.fill, keepSuffix: true, manual: a.manual, onProgress, signal: ac.signal, ignoreByteLimit: true, ignoreDurationLimit: true });
      const it = r.items[0];
      if (ac.signal.aborted) throw new Error('已取消');
      const got = it.ok ? await rec(it.output, it.action) : { output: it.output, groupId: null, bytes: null };
      return { gif: true, ok: it.ok, action: it.action, detail: it.detail, output: got.output, groupId: got.groupId, bytes: got.bytes, hint: r.hint, chosen: it.result?.chosen };
    }
    const base = path.join(outDir, `${outBase}${resolvePreset(a.preset).fileSuffix}.gif`);
    const out = safeOutputPath(base);
    const r = await convertFile(a.file, out, {
      preset: a.preset, mode: a.mode, start: a.start, dur: a.dur, ranges: a.ranges, width: a.width, fps: a.fps, prefer: a.prefer, fine: a.fine,
      fill: a.fill, color: a.color, manual: a.manual, crop: a.crop || undefined, overwrite: true, signal: ac.signal,
      onProgress, ignoreByteLimit: true, ignoreDurationLimit: true, // 主界面打开来剪的不受视频 100MB（作者选）、5 分钟（作者「可以改进」）；超过 300 帧的在解码前就跳过
    });
    if (r.ok) Object.assign(r, await rec(r.output, '压缩'));
    return r;
  } finally {
    if (running === ac) running = null;
  }
}

ipcMain.handle('check-gif', async (_e, a) => checkGif(a.file, resolvePreset(a.preset)));

/**
 * 裁剪用的轻量预览（作者：编辑阶段只碰低分辨率预览，导出才处理原片；拖动时不重新编码）。
 * GIF 转一个低分辨率临时视频（<img> 没法定位到某一秒），放在取帧缓存目录里，换文件就删。
 */
ipcMain.handle('gif-preview', async (_e, file) => {
  const dir = await workFor(file, 'preview');
  const out = path.join(dir, 'preview.mp4');
  if (!existsSync(out)) {
    // 宽度取偶数：yuv420p 要求宽高都是偶数，奇数宽（比如 499）的 GIF 原来直接失败（10-19 晚查出）。
    // 先写临时名、成功再改名：失败时会留下 0 字节文件，同一次运行里再打开这张图就拿到坏文件、预览黑屏
    const part = path.join(dir, 'preview.part.mp4');
    const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', file,
      '-vf', "scale='trunc(min(960,iw)/2)*2':-2:flags=bilinear,format=yuv420p", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-an', part]);
    if (r.code !== 0 || !existsSync(part) || statSync(part).size === 0) {
      await rm(part, { force: true });
      throw new Error(`生成预览失败：${r.stderr.slice(-200)}`);
    }
    await rename(part, out);
  }
  return pathToFileURL(out).href;
});

/** 时间轴缩略图：固定取 n 张，每张在对应时刻直接定位取一帧（不解码整个文件），只放内存。 */
ipcMain.handle('thumbs', async (_e, { file, n = 12, height = 72 }) => {
  const info = await probe(file);
  const dur = info.duration || 0;
  if (!dur) return [];
  const times = Array.from({ length: n }, (_, i) => Math.min(dur - 0.05, ((i + 0.5) * dur) / n));
  const grab = async (t) => {
    const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', t.toFixed(3), '-i', file,
      '-frames:v', '1', '-vf', `scale=-2:${height}`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', '-']);
    return r.code === 0 && r.stdoutBuffer?.length ? `data:image/jpeg;base64,${r.stdoutBuffer.toString('base64')}` : null;
  };
  // 定位只出「这一刻以后」开始的帧：时刻落在最后一帧开始之后就一帧都取不到（短 GIF 最后一张常是空的，10-19 晚看到），往前挪半秒再取一次
  const one = async (t) => (await grab(t)) || (t > 0.05 ? grab(Math.max(0, t - 0.5)) : null);
  const out = [];
  for (let i = 0; i < times.length; i += 4) out.push(...(await Promise.all(times.slice(i, i + 4).map(one))));
  return times.map((t, i) => ({ t, src: out[i] }));
});

ipcMain.handle('reveal', async (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('open-folder', async (_e, p) => shell.openPath(p));

// ---------- 批量：主界面交给菜单栏这条队列 ----------
/** 主界面拖进多个或文件夹（「导入」多选也一样）：按主界面当前的用途排进菜单栏队列，面板不抢焦点地展开（作者：批量页并进菜单栏）。 */
ipcMain.handle('handoff-batch', async (_e, { paths, preset }) => {
  const r = await enqueueFiles(paths, { preset, from: 'main' });
  if (r.added) {
    if (!pop.isVisible()) showPopover({ inactive: true });
    pushList();
  }
  const where = r.files.length ? whereText(r.files) : null;
  return { added: r.added, rejected: r.rejected.length, folders: r.folders, where: where && { text: where.text, dir: where.dir } };
});

ipcMain.on('debug-log', (_e, m) => console.log(m));
/**
 * 调试（GIFKIT_DEBUG_POPFOCUS=1，配 GIFKIT_OPEN，不要 GIFKIT_SHOT）：查「导出后菜单栏列表闪一下没打开」（作者）。
 * 主界面拿着焦点时连着导出两次（第二次前先点回主界面），每 0.1 秒记一次菜单栏面板显示没、谁拿着焦点，只打印变化。
 */
async function debugPopFocus() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = () => JSON.stringify({ 面板显示: pop.isVisible(), 面板焦点: pop.isFocused(), 主界面焦点: Boolean(win?.isFocused()) });
  const watch = async (tag, ms) => {
    let last = '';
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = st();
      if (s !== last) console.log(`${tag} +${Date.now() - t0}ms：${s}`);
      last = s;
      await sleep(100);
    }
  };
  // 按毫秒记面板、主界面的事件（显示、拿到焦点、失焦、收起），看是谁把面板收回去的
  let t0 = Date.now();
  const ev = (who, name) => console.log(`  ${who} ${name} +${Date.now() - t0}ms`);
  for (const n of ['show', 'focus', 'blur', 'hide']) pop.on(n, () => ev('面板', n));
  for (const n of ['focus', 'blur']) win.on(n, () => ev('主界面', n));
  const hl = highlightHook;
  highlightHook = (id) => { ev('导出完', `highlight(${id})`); hl?.(id); };
  for (let k = 1; k <= 2; k++) {
    // 像用户点回主界面再点「导出」：先给主界面焦点，等导出做完，再静等 2 秒不碰任何窗口
    win.show();
    win.focus();
    await sleep(600);
    t0 = Date.now();
    console.log(`第 ${k} 次导出前：${st()}`);
    await win.webContents.executeJavaScript('doExport()').catch(() => {});
    console.log(`第 ${k} 次导出做完 +${Date.now() - t0}ms：${st()}，主界面说明面板开着：${await win.webContents.executeJavaScript("!document.getElementById('sizePanel').classList.contains('hidden')")}`);
    await watch(`第 ${k} 次导出做完以后`, 2000);
    console.log(`第 ${k} 次导出 2 秒后：${st()}`);
  }
  await sleep(800);
  app.quit();
}
/**
 * 调试（Windows版 W8 云端冒烟）：GIFKIT_SMOKE_DIR=<文件夹>，配 GIFKIT_TRAY_DROP（启动后当作拖进来）：队列跑完后给面板、主界面、设置、
 * 投放块（平时 / 拖过来）各截一张，扫一遍页面文字和提示里有没有 Mac 的说法，列表和结果写进 smoke.json，然后退出。
 */
async function smokeShots(why = '') {
  const dir = process.env.GIFKIT_SMOKE_DIR;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 每一步限时：给没在画的窗口截图、页面卡住时会一直等（Windows版 W8 云端第三轮 4 分钟没退）
  const limit = (p, what, ms = 20000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} 超过 ${ms} 毫秒`)), ms))]);
  const step = (t) => { console.log('[冒烟]', t); out.steps.push(t); };
  const MAC_WORDS = ['⌘', '⌥', '⌃', '⇧', '⌫', '访达', '废纸篓', '菜单栏', '程序坞'];
  const out = { version: app.getVersion(), platform: process.platform, why, steps: [], shots: [], macWords: {} };
  const scan = async (wc, name) => {
    const t = await limit(wc.executeJavaScript(`(() => { const a = [document.body.innerText]; for (const el of document.querySelectorAll('[data-tip],[title],[placeholder]')) a.push(el.getAttribute('data-tip') || '', el.getAttribute('title') || '', el.getAttribute('placeholder') || ''); return a.join('\\n'); })()`), `扫字 ${name}`);
    out.macWords[name] = MAC_WORDS.filter((w) => t.includes(w));
  };
  const shot = async (wc, name) => {
    step(`截 ${name}`);
    await writeFile(path.join(dir, `${name}.png`), (await limit(wc.capturePage(), `截 ${name}`)).toPNG());
    out.shots.push(name);
  };
  try {
    await mkdir(dir, { recursive: true });
    step('开始');
    out.list = lib.list().map((g) => ({ name: g.name, chips: g.chips.map((c) => ({ state: c.state, bytes: c.bytes, file: c.file ? path.basename(c.file) : '', error: c.error || '' })) }));
    showPopover();
    pushList();
    await sleep(1200);
    out.popVisible = pop.isVisible();
    await shot(pop.webContents, '面板');
    await scan(pop.webContents, '面板');
    showMain();
    await sleep(3500);
    out.mainVisible = Boolean(win && win.isVisible());
    await shot(win.webContents, '主界面');
    await scan(win.webContents, '主界面');
    await limit(win.webContents.executeJavaScript(`openSettings('set')`), '打开设置');
    await sleep(1500);
    await shot(win.webContents, '设置');
    await scan(win.webContents, '设置');
    // W11a：固定开着时点别的窗口面板不收；关着照旧收（先测关着的，看云端失焦到底生不生效）
    out.pin = {};
    prefs.panelPinned = false;
    showPopover();
    await sleep(600);
    win.focus();
    await sleep(900);
    out.pin.unpinnedHides = !pop.isVisible();
    prefs.panelPinned = true;
    showPopover();
    await sleep(600);
    win.focus();
    await sleep(900);
    out.pin.pinnedStaysVisible = pop.isVisible();
    prefs.panelPinned = false;
    step(`固定：关着时失焦收了 ${out.pin.unpinnedHides}，开着时还在 ${out.pin.pinnedStaysVisible}`);
    // W11e：拖进托盘图标（小助手报的 enter / up 直接喂进来，云端没法真拖文件）：先冒提示小窗，0.4 秒后面板弹出、嘴张开、提示收起；没在面板里松手就收回去
    pop.hide();
    await sleep(600);
    out.trayDrag = {};
    onHelperEvent({ tray: 'enter' });
    await sleep(200);
    out.trayDrag.hintShown = Boolean(hintWin && !hintWin.isDestroyed() && hintWin.isVisible());
    if (out.trayDrag.hintShown) await shot(hintWin.webContents, '托盘提示');
    await sleep(600);
    out.trayDrag.panelOpened = pop.isVisible();
    out.trayDrag.hintHidden = !(hintWin && !hintWin.isDestroyed() && hintWin.isVisible());
    out.trayDrag.mouthOpen = await limit(pop.webContents.executeJavaScript(`document.body.classList.contains('dragging')`), '看嘴');
    await shot(pop.webContents, '面板_张嘴');
    onHelperEvent({ tray: 'up' });
    await sleep(900);
    out.trayDrag.closedAfterCancel = !pop.isVisible();
    out.trayDrag.mouthClosed = !(await limit(pop.webContents.executeJavaScript(`document.body.classList.contains('dragging')`), '看嘴'));
    step(`拖进托盘：提示 ${out.trayDrag.hintShown}，面板 ${out.trayDrag.panelOpened}，嘴 ${out.trayDrag.mouthOpen}，提示收起 ${out.trayDrag.hintHidden}，取消后收 ${out.trayDrag.closedAfterCancel}`);
    // W11g：双击打开的小条，窗口要按内容收小（他截图里下面一大块空白）
    await openByDoubleClick([process.env.GIFKIT_TRAY_DROP]);
    await sleep(2500);
    out.bubble = { visible: pop.isVisible(), bounds: pop.getBounds(), resizeFix: popResizeFix };
    await shot(pop.webContents, '小条');
    step(`双击小条：${out.bubble.bounds.width}×${out.bubble.bounds.height}，临时开可调大小 ${popResizeFix}`);
    pop.hide();
    await sleep(500);
    // 投放块 11-08 起默认关（作者选 A）：冒烟里打开来测它（后备）
    prefs.dropBlockOn = true;
    applyDropBlock();
    await sleep(1800);
    if (dropWin && !dropWin.isDestroyed()) {
      pop.hide();
      await sleep(600);
      out.dropBlock = { visibleBefore: dropWin.isVisible(), dropFull, bounds: dropWin.getBounds(), workArea: dropArea() };
      if (!dropWin.isVisible()) { step('投放块没显示（全屏状态 ' + dropFull + '），冒烟时强制显示再截'); dropWin.showInactive(); await sleep(600); }
      out.dropBlock.visible = dropWin.isVisible();
      await shot(dropWin.webContents, '投放块_平时');
      dropHover = true;
      placeDropBlock();
      await limit(dropWin.webContents.executeJavaScript(`document.getElementById('blk').className = 'hover'`), '投放块换样子');
      await sleep(600);
      await shot(dropWin.webContents, '投放块_拖过来');
      dropHover = false;
      placeDropBlock();
      // W11b：拖着挪 300 次大小不该变（作者的长条）；对照：只用 setPosition 挪 300 次，看会不会越挪越高（只记数）
      const b0 = dropWin.getBounds();
      for (let i = 0; i < 300; i++) dropMoveTo(b0.y + (i % 40));
      out.dropDrag = { scale: screen.getPrimaryDisplay().scaleFactor, start: b0, afterSetBounds: dropWin.getBounds() };
      placeDropBlock();
      const b1 = dropWin.getBounds();
      for (let i = 0; i < 300; i++) dropWin.setPosition(b1.x, b1.y + (i % 40));
      out.dropDrag.afterSetPosition = dropWin.getBounds();
      placeDropBlock();
      out.dropDrag.afterReset = dropWin.getBounds();
      step(`投放块挪 300 次（缩放 ${out.dropDrag.scale}）：新写法 ${out.dropDrag.afterSetBounds.width}×${out.dropDrag.afterSetBounds.height}，只 setPosition ${out.dropDrag.afterSetPosition.width}×${out.dropDrag.afterSetPosition.height}`);
    }
    out.fullWatch = Boolean(helper);
    out.dropFull = dropFull;
  } catch (e) {
    out.error = String(e.stack || e);
  }
  await writeFile(path.join(dir, 'smoke.json'), JSON.stringify(out, null, 1));
  app.quit();
}

/** 调试：主界面截一张图放在 GIFKIT_SHOT 同一个文件夹，不退出（打标测试一步一张）。 */
ipcMain.handle('debug-snap', async (_e, name) => {
  const shot = process.env.GIFKIT_SHOT;
  if (!shot || !win) return false;
  await writeFile(path.join(path.dirname(shot), `${String(name).replace(/[\\/]/g, '_')}.png`), (await win.webContents.capturePage()).toPNG());
  return true;
});
ipcMain.handle('debug-shot', async () => {
  const shot = process.env.GIFKIT_SHOT;
  if (!shot) return false;
  if (process.env.GIFKIT_DEBUG_MARKS) console.log('菜单栏列表：', JSON.stringify(lib.groups.map((g) => ({ 名字: g.name, 段: g.range || null, 待压缩: Boolean(g.pending), 版本: g.versions.map((v) => v.file && path.basename(v.file)) }))));
  // 调试：顺带量一下布局（页面能不能上下滚、时间轴底边在不在窗口里），截图看不出来的靠这几个数
  try {
    const m = await win.webContents.executeJavaScript(`(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); return { pageH: document.documentElement.scrollHeight, winH: innerHeight, dropH: Math.round(r('drop').height), trimBottom: Math.round(r('trim').bottom) }; })()`);
    console.log('布局：', JSON.stringify(m));
  } catch {}
  const img = await win.webContents.capturePage();
  await writeFile(shot, img.toPNG());
  setTimeout(() => app.quit(), 200);
  return true;
});

// 调试（10-20 界面重设计出示意图用）：GIFKIT_THEME_DIR=<文件夹> + GIFKIT_THEME=<A|B|C>，每个页面加载完把那个方案的覆盖样式
// （方案X-主界面.css / 方案X-菜单栏.css / 方案X-录屏.css）接在原样式后面，截图看套上以后的样子。平时不设，不影响。
if (process.env.GIFKIT_THEME_DIR && process.env.GIFKIT_THEME) {
  const part = (url) => (/index\.html/.test(url) ? '主界面' : /tray\.html/.test(url) ? '菜单栏' : /(region|recframe|recbar)\.html/.test(url) ? '录屏' : null);
  app.on('web-contents-created', (_e, wc) => {
    wc.on('did-finish-load', async () => {
      const p = part(wc.getURL());
      const f = p && path.join(process.env.GIFKIT_THEME_DIR, `方案${process.env.GIFKIT_THEME}-${p}.css`);
      // 在页面末尾加一个 <link>，排在原样式后面（insertCSS 注入的优先级比页面自己的样式低，同样的选择器盖不过，10-20 踩过）
      if (f && existsSync(f)) {
        const ok = await wc.executeJavaScript(`new Promise((r) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(pathToFileURL(f).href)}; l.onload = () => r(true); l.onerror = () => r(false); document.head.appendChild(l); })`).catch((err) => err.message);
        if (ok !== true) console.log('套样式出错：', p, ok);
      }
    });
  });
}

function cleanStaleTemp() {
  const dirs = staleTempDirs(os.tmpdir()).filter((p) => p !== workDir);
  for (const p of dirs) rm(p, { recursive: true, force: true }).catch(() => {});
  if (dirs.length) oplog?.log('启动', '清掉以前留下的临时目录', { 个数: dirs.length });
}

app.whenReady().then(async () => {
  readyAt = Date.now();
  workDir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-app-'));
  writeFileSync(path.join(workDir, 'owner.pid'), String(process.pid)); // 启动时清残留用：记着是谁的，还活着就不动
  setTimeout(() => cleanStaleTemp(), 5000); // 清以前没删掉的临时目录（不挡启动）
  // 历史记录：只存结果信息（GIFKIT_HISTORY 调试时可以指到别处，免得弄脏真的历史）
  lib.file = process.env.GIFKIT_HISTORY || path.join(app.getPath('userData'), 'history.json');
  await lib.load();
  await loadSettings();
  // 操作日志（第二批）：数据文件夹里的 logs，只留 7 天；碰到过的文件夹先记下来，写的时候换掉
  oplog = new OpLog({ dir: path.join(path.dirname(lib.file), 'logs'), enabled: prefs.oplog });
  oplog.prune();
  remember(app.getPath('downloads'), REC_ROOT(), REC_DEFAULT(), path.dirname(lib.file), ...(prefs.outDir ? [prefs.outDir] : []));
  oplog.log('启动', '', { 版本: app.getVersion(), 系统: process.getSystemVersion?.() || os.release(), 芯片: process.arch, 装好的包: !process.defaultApp });
  if (process.env.GIFKIT_DEBUG_LISTFS === 'live') {
    // 用现成的历史记录（文件都在）：开着的时候在硬盘上改名、挪走、删掉，再打开面板看
    setTimeout(debugListFs, 3000); // 面板这时还没建，等它建好、加载完
  }
  if (process.env.GIFKIT_DEBUG_LISTFS === 'reload') {
    await refreshFiles();
    console.log('重启后列表：', listDump());
    app.quit();
    return;
  }
  refreshFiles(); // 上次关掉以后被改名、挪走的找回，删掉的去掉
  for (const g of lib.groups) makeThumb(g);
  if (WIN) {
    // Windows：双击文件、拖到程序图标上打开的文件在启动参数里；以后再打开的走 second-instance
    const files = argvFiles(process.argv);
    if (files.length) {
      openedWithFiles = true;
      pendingOpen.push(...files);
    }
    app.on('second-instance', (_e, argv) => {
      const more = argvFiles(argv);
      if (more.length) openByDoubleClick(more);
      else showPopover();
    });
  }
  createTray();
  createPopover();
  setupRecorder();
  applyDropBlock();
  if (WIN) {
    startHelper(); // 拖进托盘图标、全屏检测（W11e）
    makeTrayHint(); // 提示小窗先建好藏着，拖过来时马上能露
    for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => { placeDropBlock(); sendTrayRect(); });
  }
  if (process.env.GIFKIT_DEBUG_HOTKEYS) {
    // 调试（10-22 设置卷）：GIFKIT_DEBUG_HOTKEYS=<开始停止>|<切一刀>，按设置那层同一套办法改两个快捷键，打印新的注册上没有、旧的放没放掉，
    // 再试一个不该过的（⌘C），最后改回来、不存盘，退出
    app.dock?.hide();
    const [rec, mark] = process.env.GIFKIT_DEBUG_HOTKEYS.split('|');
    const before = { ...prefs.hotkeys };
    const reg = (a) => globalShortcut.isRegistered(a);
    console.log('改之前：', JSON.stringify({ 开始停止: before.rec, 注册着: reg(before.rec), 切一刀: before.mark }));
    const err = setHotkeys({ rec, mark });
    console.log('改成后：', JSON.stringify({ 出错: err, 新的注册着: reg(Hotkeys.normalize(rec)), 旧的还注册着: reg(before.rec), 设置: prefs.hotkeys, 显示: [hkText('rec'), hkText('mark')], 菜单栏拿到的: [hkText('rec'), hkText('mark')] }));
    console.log('改成 ⌘C：', JSON.stringify({ 出错: setHotkeys({ mark: 'Command+C' }), 设置没变: prefs.hotkeys.mark }));
    console.log('两个设成一样：', JSON.stringify({ 出错: setHotkeys({ mark: prefs.hotkeys.rec }) }));
    setHotkeys(before);
    console.log('改回来：', JSON.stringify({ 注册着: reg(before.rec), 设置: prefs.hotkeys }));
    app.quit();
    return;
  }
  if (process.env.GIFKIT_REC_TEST) {
    app.dock?.hide();
    await popReady;
    runRecTest(process.env.GIFKIT_REC_TEST);
    return;
  }
  if (process.env.GIFKIT_PASTE_TEST === '1') {
    // 调试：只读一次剪贴板，打印结果（不导入、不改剪贴板）后退出
    const r = await readClipboardMedia();
    console.log('剪贴板读取结果：', JSON.stringify({ paths: r.paths, gifBytes: r.gif?.length, none: r.none, hasImage: r.hasImage, feishu: r.feishu }));
    app.quit();
    return;
  }
  if (process.env.GIFKIT_OPEN_TEST) {
    // 调试：当作在访达里接连双击这几个文件（间隔 0.6 秒），给小条截两张图（压的时候、压完），再看 4 秒后有没有自己收起
    app.dock?.hide();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shot = process.env.GIFKIT_TRAY_SHOT || '/tmp/gk/bubble.png';
    const state = () => JSON.stringify({ 显示: pop.isVisible(), 大小: pop.getSize(), 小条行数: bubble?.groups.length ?? 0, 焦点在小条: pop.isFocused() });
    await popReady;
    if (process.env.GIFKIT_OPEN_TEST_MAIN === '1') {
      // 先像平时那样开着主界面，再双击（看主界面会不会被收起、小条还在不在屏幕上）
      showMain();
      await sleep(1500);
    }
    const winsOnScreen = () => {
      try {
        return execFileSync('osascript', ['-l', 'JavaScript', '/tmp/gk/d59/win3.js', String(process.pid)], { encoding: 'utf8' }).trim();
      } catch (err) {
        return `查不了：${err.message}`;
      }
    };
    if (process.env.GIFKIT_OPEN_TEST_MAIN === '1') console.log('双击前：', winsOnScreen(), JSON.stringify({ 主界面显示: Boolean(win?.isVisible()) }));
    const gap = Number(process.env.GIFKIT_OPEN_TEST_GAP) || 600; // 双击之间隔多久（不到 1.5 秒算同一次双击）
    for (const f of process.env.GIFKIT_OPEN_TEST.split('|')) {
      const fresh = Date.now() - lastOpenFileAt > 1500;
      lastOpenFileAt = Date.now();
      await openByDoubleClick([f], { fresh });
      await sleep(gap);
    }
    console.log('双击后：', winsOnScreen(), JSON.stringify({ 主界面显示: Boolean(win?.isVisible()) }));
    await sleep(500);
    await writeFile(shot.replace(/\.png$/, '_压的时候.png'), (await pop.webContents.capturePage()).toPNG());
    console.log('压的时候：', state());
    for (let i = 0; i < 120 && bubbleBusy(); i++) await sleep(500);
    await sleep(600);
    await writeFile(shot.replace(/\.png$/, '_压完.png'), (await pop.webContents.capturePage()).toPNG());
    console.log('压完：', state());
    await sleep(BUBBLE_HIDE_MS + 1500);
    console.log('压完 5.5 秒后：', state());
    if (process.env.GIFKIT_OPEN_TEST_CLICK) {
      // 再点一下小条上的按钮（cAll「全部」/ cClose「收起」），看换没换成完整列表、收没收起
      await pop.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(process.env.GIFKIT_OPEN_TEST_CLICK)}).click()`);
      await sleep(800);
      console.log('点了以后：', state());
      await writeFile(shot.replace(/\.png$/, '_点了以后.png'), (await pop.webContents.capturePage()).toPNG());
    }
    app.quit();
    return;
  }
  const trayDrop = process.env.GIFKIT_TRAY_DROP;
  if (trayDrop) {
    app.dock?.hide();
    if (process.env.GIFKIT_TRAY_DUAL === '1') trayDual = true;
    if (process.env.GIFKIT_TRAY_PRESET) trayPreset = resolvePreset(process.env.GIFKIT_TRAY_PRESET).id;
    pop.webContents.once('did-finish-load', async () => {
      showPopover(); // 和真实拖入一样先展开面板（拒绝提示才会出在面板里）
      await enqueueFiles(trayDrop.split('|'));
      lib.pump(); // 全部复用、没有新任务时也要发出「跑完」，后面的调试步骤才会继续
    });
    if (process.env.GIFKIT_DEBUG_LISTFS === '1') lib.once('idle', () => setTimeout(debugListFs, 500));
    if (process.env.GIFKIT_SMOKE_DIR) {
      // Windows版 W8 云端冒烟：队列跑完截图；150 秒还没跑完也照样截（记下各个结果卡在哪），免得一直挂着
      let started = false;
      const go = (why) => { if (started) return; started = true; console.log('[冒烟] 开始截图：' + why); smokeShots(why); };
      lib.once('idle', () => setTimeout(() => go('队列跑完'), 800));
      setTimeout(() => go('队列 150 秒还没跑完'), 150000);
    }
    if (process.env.GIFKIT_TRAY_SHOT) {
      const shoot = () => setTimeout(async () => {
        showPopover();
        pushList();
        await new Promise((r) => setTimeout(r, 900));
        if (process.env.GIFKIT_SHOT_DROPZONE) await pop.webContents.executeJavaScript("document.body.classList.add('dragging','hot')");
        await new Promise((r) => setTimeout(r, 200));
        await writeFile(process.env.GIFKIT_TRAY_SHOT, (await pop.webContents.capturePage()).toPNG());
        app.quit();
      }, 800);
      if (process.env.GIFKIT_TRAY_EDIT) {
        // 调试编辑流程：队列跑完后「编辑」指定名字的素材，完整界面导出回写后再截图
        lib.once('idle', () => {
          const g = lib.groups.find((x) => x.name === process.env.GIFKIT_TRAY_EDIT);
          if (g) editGroup(g.id);
        });
        debugAfterEdit = shoot;
      } else lib.once('idle', shoot);
    }
  } else {
    // 被双击文件启动时，「打开文件」事件一般在启动完成前就到了；稍等一下再决定开不开完整界面
    setTimeout(() => {
      if (pendingOpen.length) openByDoubleClick(pendingOpen.splice(0));
      if (process.env.GIFKIT_DEBUG_POPFOCUS === '1') setTimeout(debugPopFocus, 9000);
      if (openedWithFiles) app.dock?.hide();
      // 作者选「启动时打开完整界面」默认关（更轻量）：只在菜单栏，点「完整界面」「编辑」或再点一下程序图标才开；开机自启那次不管开关都不弹
      else if (DEBUG_MAIN || (prefs.openMainOnStart && !openedAtLogin())) createWindow();
      else app.dock?.hide();
      oplog?.log('启动', '开不开主界面', { 主界面: Boolean(win), 开机自启: openedAtLogin(), 双击文件启动: openedWithFiles, 设置里开着: prefs.openMainOnStart });
      if (process.env.GIFKIT_DEBUG_STARTUP === '1') {
        // 调试：启动后看建没建主界面窗口（配 GIFKIT_HISTORY 指到临时文件夹，里面放一份 settings.json）
        setTimeout(() => { console.log('启动后：', JSON.stringify({ 主界面: Boolean(win), 开机自启: openedAtLogin(), 启动时打开完整界面: prefs.openMainOnStart })); app.quit(); }, 1500);
      }
    }, 300);
  }
});
// 关掉所有窗口也不退出：菜单栏图标还在（退出用图标右键菜单或小面板里的「退出」）
app.on('window-all-closed', () => {});
// 操作日志：主进程没接住的报错（monitor 只旁听，不改原来的处理）；各页面控制台里的报错（第二批）
process.on('uncaughtExceptionMonitor', (err) => oplog?.log('报错', '主进程没接住', { 信息: err?.message, 位置: String(err?.stack || '').split('\n').slice(1, 3).map((x) => x.trim()).join(' | ') }));
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (e, ...args) => {
    const level = e?.level ?? args[0];
    if (level !== 'error' && level !== 3) return;
    let page = '';
    try {
      page = path.basename(new URL(wc.getURL()).pathname);
    } catch {}
    oplog?.log('报错', page || '页面', { 信息: String(e?.message ?? args[1] ?? '').slice(0, 300), 行: e?.lineNumber ?? args[2] });
  });
});
// 带主界面调试开关启动时照样开主界面（截图脚本、调试要用）
const DEBUG_MAIN = ['GIFKIT_OPEN', 'GIFKIT_SHOT', 'GIFKIT_BATCH', 'GIFKIT_HELP', 'GIFKIT_PANEL', 'GIFKIT_CLEAR', 'GIFKIT_DEBUG_MARKS', 'GIFKIT_DEBUG_KEYS', 'GIFKIT_DEBUG_PREVIEW', 'GIFKIT_DEBUG_CUSTOM', 'GIFKIT_DEBUG_POPFOCUS', 'GIFKIT_DEBUG_CLOSE_MS'].some((k) => process.env[k]);
/** 是不是开机自启：新版登录项不一定报 wasOpenedAtLogin，刚开机两分钟内启动的也算（未核实，10-22） */
function openedAtLogin() {
  try {
    if (app.getLoginItemSettings().wasOpenedAtLogin) return true;
  } catch {}
  return os.uptime() < 120;
}
app.on('activate', () => {
  // 点程序坞图标才开主界面；双击 GIF 时系统也可能发这个，前后 2 秒内的不算；刚启动那一下也不算（启动时开不开主界面按设置）
  setTimeout(() => {
    if (Date.now() - lastOpenFileAt < 2000 || Date.now() - readyAt < 2000) return;
    showMain();
  }, 300);
});
// 退出前（10-20 审查 B1）：正在录屏的先停录、拼好整段、进列表再退（原来只叫小助手退出，这次录的全丢、临时分段也不清）。
// 只在真有录屏要收尾时才拦下这次退出（拦下会让这一次系统关机、注销被取消，所以平时不拦）。
let quitting = false;
app.on('before-quit', (e) => {
  if (!recorder || !['starting', 'recording', 'stopping'].includes(recorder.state)) return;
  e.preventDefault();
  if (quitting) return;
  quitting = true;
  recorder.finishForQuit().catch((err) => console.error('退出前停录屏出错：', err.message)).finally(() => app.quit());
});
app.on('will-quit', () => {
  oplog?.log('退出');
  globalShortcut.unregisterAll();
  recorder?.quit();
  stopHelper();
  lib.flushSync(); // 平时停 0.5 秒才存，退出前那一下的改动会丢（10-20 审查 M3）
  // 同步删完再退（10-31：原来异步删、不等就退了，10-29 那次留下 1.19 GB 原始帧）
  if (workDir) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (e) {
      console.error('退出前删缓存失败：', e.message);
    }
  }
});
