#!/usr/bin/env node
// 把本工具手工打成本机可运行的「GGIF.app」（10-22 前叫 GIF工具.app）（Electron 官方「手工打包」做法，不下载、不安装任何东西）。
//
// 用法（在仓库根目录）：node app/scripts/pack.mjs [--out <xxx.app>] [--electron <Electron.app>] [--encoders <目录>] [--dmg] [--no-install] [--no-sign] [--arch arm64|x64]
//   --arch x64 出 Intel 芯片版（10-23 起，日常更新维护卷「Intel 版」）：只出 dmg（GIF工具/发布.nosync/GGIF-<版本>-Intel.dmg），不装本机；
//   Electron 用 GIF工具/工具.nosync/electron-x64/v<和开发用的同一版本>/Electron.app（官方 darwin-x64 包，下载后按 SHASUMS256.txt 核对过），
//   编码器用 成品-x64/（build-encoders.mjs --arch x64），录屏小助手现编 Intel 版。不带 --arch 时和以前一模一样。
//   默认直接装到 /Applications/GGIF.app（10-23 作者定：留 /Applications 那份，就是从 dmg 拖进「应用程序」的位置；
//   以前装 ~/Applications/GGIF.app，两处各一份同标识的 App，升级会对不上、设默认打开方式时可能挑错）；已存在会先删掉旧包再装。GGIF（或改名前的 GIF工具）正在运行时拒绝打包（先退出再来）。
//   Electron.app 默认取本仓库 app/node_modules/electron/dist/，没有就取同级主副本「代码.nosync」里的那份（只读复制）。
//   --no-sign 不重签（只用来测试不重签能不能跑）。
//   --dmg 另出给别的 Mac 装的 GIF工具/发布.nosync/GGIF-<版本>-arm64.dmg（GGIF.app、「应用程序」快捷方式、「第一次打开看这里.txt」），出完自己挂上检查一遍。
//   --no-install 不装到 /Applications，只出 dmg（GGIF 开着也能跑；要和 --dmg 一起用）。
//   --encoders 随包的 ffmpeg、ffprobe、gifsicle 从哪取，默认 GIF工具/工具.nosync/编码器/成品（app/scripts/build-encoders.mjs 从源码编的）。
//
// 包的结构：
//   Contents/Resources/app/     app 目录下的 .js / .cjs、package.json、renderer/、assets/
//   Contents/Resources/engine/  package.json、src/、vendor/（gifski、lessgif.wasm、ffmpeg、ffprobe、gifsicle 及许可）
//   Contents/MacOS/gifkit-recorder  录屏小助手（native/recorder.swift，打包时用 swiftc 现编，单独签名）
//   这样 main.js 里「../engine/src」的相对路径不用改；引擎先找 vendor/ 里的程序（tools.js），装好的包不用本机 Homebrew。
// 打包时查包里每个程序：有对应芯片（arm64 / Intel 版 x86_64）、最低系统不高于 macOS 14、只连系统库和包里的东西，查不过就不出包（10-23 起；Homebrew 的程序最低要 macOS 26，别的 Mac 上跑不了）。
// 不改任何文件的默认打开方式。
import { execFileSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../../engine/src/tools.js';
import { buildRecorder } from './build-recorder.mjs';
import { ARCHS, MIN_MACOS, productDir } from './build-encoders.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(here, '..');
const REPO = path.resolve(APP_DIR, '..');
const ENGINE_DIR = path.join(REPO, 'engine');
const GIF_ROOT = path.resolve(REPO, '..'); // GIF工具/

const NAME = 'GGIF'; // 10-22 改名（原来叫 GIF工具；程序标识 BUNDLE_ID 不变，默认打开方式接着用）
const OLD_NAME = 'GIF工具';
const BUNDLE_ID = 'local.gifkit.app';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const ARCH = opt('--arch') || 'arm64';
const X64 = ARCH === 'x64';
const MACHO = ARCHS[ARCH]?.macho; // lipo / otool 里的芯片名
const OUT = path.resolve(opt('--out') || path.join('/Applications', `${NAME}.app`));
const SIGN = !argv.includes('--no-sign');
const DMG = argv.includes('--dmg');
const INSTALL = !X64 && !argv.includes('--no-install'); // Intel 版装不到这台 Apple 芯片的 Mac 上：只出 dmg
const ENCODERS = path.resolve(opt('--encoders') || productDir(ARCH));
const ENC_BINS = ['ffmpeg', 'ffprobe', 'gifsicle'];
const RELEASE_DIR = path.join(GIF_ROOT, '发布.nosync');
// 开发用的 Electron（Apple 芯片版）；Intel 版取同一版本的官方 x64 包
const DEV_ELECTRON = [path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'Electron.app'),
  path.join(GIF_ROOT, '代码.nosync', 'app', 'node_modules', 'electron', 'dist', 'Electron.app')].find((p) => existsSync(p));
const ELECTRON_VERSION = DEV_ELECTRON ? readFileSync(path.join(DEV_ELECTRON, '..', 'version'), 'utf8').trim() : '找不到开发用的 Electron';
const ELECTRON_SRC = path.resolve(
  opt('--electron')
    || (X64 ? path.join(GIF_ROOT, '工具.nosync', 'electron-x64', `v${ELECTRON_VERSION}`, 'Electron.app') : DEV_ELECTRON)
    || '找不到 Electron.app',
);

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function step(msg) {
  console.log(`· ${msg}`);
}
let stageToClean = null; // 拼包的临时目录（约 400MB）：中途失败也删掉
function fail(msg) {
  console.error(`打包失败：${msg}`);
  if (stageToClean) rmSync(stageToClean, { recursive: true, force: true });
  process.exit(1);
}

if (!MACHO) fail(`不认识的芯片：${ARCH}（只有 arm64、x64）`);
if (X64 && !DMG) fail('Intel 版只出 dmg（这台是 Apple 芯片的 Mac，不装本机）：加 --dmg');
if (!existsSync(path.join(ELECTRON_SRC, 'Contents', 'MacOS', 'Electron'))) {
  fail(X64 ? `Intel 版 Electron.app 不存在：${ELECTRON_SRC}（从 Electron 的 GitHub 发布页下 electron-v${ELECTRON_VERSION}-darwin-x64.zip，`
    + '按同一发布页的 SHASUMS256.txt 核对 sha256，用 ditto -x -k 解到这个目录）' : `Electron.app 不存在：${ELECTRON_SRC}`);
}
{
  const archs = sh('lipo', ['-archs', path.join(ELECTRON_SRC, 'Contents', 'MacOS', 'Electron')]).trim().split(/\s+/);
  if (!archs.includes(MACHO)) fail(`${ELECTRON_SRC} 是 ${archs.join(' ')} 的，不是 ${MACHO}`);
  const v = sh('plutil', ['-extract', 'CFBundleVersion', 'raw', path.join(ELECTRON_SRC, 'Contents', 'Info.plist')]).trim();
  if (X64 && v !== ELECTRON_VERSION) fail(`Intel 版 Electron 是 ${v}，和开发用的 ${ELECTRON_VERSION} 不一样`);
}
if (!OUT.endsWith('.app')) fail(`输出路径要以 .app 结尾：${OUT}`);
if (!INSTALL && !DMG) fail('--no-install 要和 --dmg 一起用（不然什么都不出）');
for (const n of ENC_BINS) {
  if (!existsSync(path.join(ENCODERS, n))) fail(`找不到随包的 ${n}（${ENCODERS}）：先跑 node app/scripts/build-encoders.mjs${X64 ? ' --arch x64' : ''}`);
}
// 正在运行的包不能直接覆盖（不替用户关程序）；改名前的「GIF工具.app」开着也一样（要挪进废纸篓）；只出 dmg 时不用查
for (const [p, n] of INSTALL ? [[path.join(path.dirname(OUT), `${OLD_NAME}.app`), OLD_NAME], [OUT, NAME]] : []) {
  try {
    execFileSync('pgrep', ['-f', `${p}/Contents/MacOS/`], { stdio: 'ignore' });
  } catch {
    continue; // 没在运行
  }
  fail(`${n} 正在运行：先在菜单栏图标右键「退出 ${n}」，再打包`);
}
for (const [k, p] of [['gifski', TOOLS.gifski], ['lessgif.wasm', TOOLS.lessgifWasm]]) {
  if (!p || !existsSync(p)) fail(`找不到 ${k}：${p}`);
}

const t0 = Date.now();
// 先在临时目录（iCloud 管不到的地方）拼好、签好，最后再复制到输出位置：
// 文稿目录归 iCloud 管，它会给 .app / .framework 目录补上 com.apple.FinderInfo，在那里签名会报
// 「resource fork, Finder information, or similar detritus not allowed」（10-18 实测）。
const STAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'gifkit-pack-'));
stageToClean = STAGE_DIR;
const STAGE = path.join(STAGE_DIR, `${NAME}.app`);
const C = path.join(STAGE, 'Contents');
const R = path.join(C, 'Resources');
const PLIST = path.join(C, 'Info.plist');

// ---------- 1. 复制 Electron.app ----------
step(`复制 Electron.app（ditto）：${ELECTRON_SRC}`);
sh('ditto', ['--noextattr', '--noqtn', ELECTRON_SRC, STAGE]);
rmSync(path.join(R, 'default_app.asar'), { force: true });

// ---------- 2. 程序和引擎 ----------
step('复制程序到 Contents/Resources/app/');
const appDst = path.join(R, 'app');
mkdirSync(appDst, { recursive: true });
// app 目录下的 .js / .cjs 全带上（以后加文件不用改这里；10-18 jobs.js 换成 library.js 时就漏过一次）
for (const f of readdirSync(APP_DIR).filter((x) => /\.c?js$/.test(x))) cpSync(path.join(APP_DIR, f), path.join(appDst, f));
cpSync(path.join(APP_DIR, 'renderer'), path.join(appDst, 'renderer'), { recursive: true });
// assets 里的 icon-1024.png 是图标母版，程序不用，不带
cpSync(path.join(APP_DIR, 'assets'), path.join(appDst, 'assets'), {
  recursive: true,
  filter: (src) => path.basename(src) !== 'icon-1024.png',
});
// package.json 加 productName，让 Electron 里的应用名（菜单「退出 xxx」等）显示 GGIF
const pkg = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
writeFileSync(path.join(appDst, 'package.json'), JSON.stringify({ ...pkg, productName: NAME }, null, 2) + '\n');

step('复制引擎到 Contents/Resources/engine/（不带 test）');
const engDst = path.join(R, 'engine');
mkdirSync(engDst, { recursive: true });
cpSync(path.join(ENGINE_DIR, 'package.json'), path.join(engDst, 'package.json'));
cpSync(path.join(ENGINE_DIR, 'src'), path.join(engDst, 'src'), { recursive: true });

step('随包附带 gifski、lessgif.wasm → engine/vendor/');
const vendor = path.join(engDst, 'vendor');
mkdirSync(path.join(vendor, 'licenses'), { recursive: true });
cpSync(TOOLS.gifski, path.join(vendor, 'gifski'));
chmodSync(path.join(vendor, 'gifski'), 0o755);
cpSync(TOOLS.lessgifWasm, path.join(vendor, 'lessgif.wasm'));
// 许可文件：lessgif 的两份许可；gifski（AGPL-3.0）的 README 里写了许可
const lessgifDir = path.dirname(TOOLS.lessgifWasm);
for (const f of ['LICENSE-MIT', 'LICENSE-APACHE']) {
  if (existsSync(path.join(lessgifDir, f))) cpSync(path.join(lessgifDir, f), path.join(vendor, 'licenses', `lessgif-${f}`));
}
const gifskiReadme = path.resolve(path.dirname(TOOLS.gifski), '..', 'README.md');
if (existsSync(gifskiReadme)) cpSync(gifskiReadme, path.join(vendor, 'licenses', 'gifski-README.md'));
cpSync(path.join(REPO, 'third_party', 'gifski-LICENSE'), path.join(vendor, 'licenses', 'gifski-LICENSE')); // 官方 1.34.0 发行包里的 LICENSE 原样
// Electron（MIT）和它带的 Chromium 等的许可清单：官方发行包里和 Electron.app 并排放着，一起带进包
for (const f of ['LICENSE', 'LICENSES.chromium.html']) {
  const p = path.join(ELECTRON_SRC, '..', f);
  if (!existsSync(p)) fail(`Electron 的许可文件不在：${p}`);
  cpSync(p, path.join(vendor, 'licenses', `electron-${f}`));
}

step(`随包附带 ffmpeg、ffprobe、gifsicle → engine/vendor/（${ENCODERS}）`);
for (const n of ENC_BINS) {
  cpSync(path.join(ENCODERS, n), path.join(vendor, n));
  chmodSync(path.join(vendor, n), 0o755);
}
// 许可证原文、源码地址和编译参数（ffmpeg 带 x264 是 GPL，gifsicle 是 GPL-2.0-only）
for (const f of readdirSync(path.join(ENCODERS, 'licenses'))) cpSync(path.join(ENCODERS, 'licenses', f), path.join(vendor, 'licenses', f));
cpSync(path.join(ENCODERS, '源码与编译参数.txt'), path.join(vendor, 'licenses', '源码与编译参数.txt'));

step(`编录屏小助手（swiftc，${ARCHS[ARCH].label}）→ Contents/MacOS/gifkit-recorder（录屏卷 3.1）`);
const recSrc = buildRecorder({ quiet: true, arch: ARCH });
const recDst = path.join(C, 'MacOS', 'gifkit-recorder');
cpSync(recSrc, recDst);
chmodSync(recDst, 0o755);

// ---------- 3. Info.plist ----------
step('改 Info.plist：名字、标识、版本、文件类型');
const plutil = (...args) => sh('plutil', args);
const setStr = (file, key, val) => plutil('-replace', key, '-string', val, file);
const hasKey = (file, key) => {
  try {
    plutil('-extract', key, 'raw', file);
    return true;
  } catch {
    return false;
  }
};
setStr(PLIST, 'CFBundleDisplayName', NAME);
setStr(PLIST, 'CFBundleName', NAME);
setStr(PLIST, 'CFBundleIdentifier', BUNDLE_ID);
setStr(PLIST, 'CFBundleShortVersionString', pkg.version);
setStr(PLIST, 'CFBundleVersion', pkg.version);
setStr(PLIST, 'LSMinimumSystemVersion', MIN_MACOS); // 录屏小助手和随包的编码器都按 14 编（Electron 自己写的 13.0）
// 原包对 default_app.asar 的完整性记录，删了 asar 也一起去掉
if (hasKey(PLIST, 'ElectronAsarIntegrity')) plutil('-remove', 'ElectronAsarIntegrity', PLIST);
// 登记能打开的文件类型（为「双击 GIF 用本工具压缩」做准备）；Alternate = 只出现在「打开方式」里，不抢默认
const docTypes = [
  { CFBundleTypeName: 'GIF 图片', CFBundleTypeRole: 'Editor', LSHandlerRank: 'Alternate', LSItemContentTypes: ['com.compuserve.gif'] },
  { CFBundleTypeName: '视频', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.movie'] },
];
if (hasKey(PLIST, 'CFBundleDocumentTypes')) plutil('-remove', 'CFBundleDocumentTypes', PLIST);
// 录屏走系统选择窗口，本来不用「屏幕录制」权限；万一系统要弹授权框，没有这一条会直接把程序关掉
setStr(PLIST, 'NSScreenCaptureUsageDescription', '录屏：只录你在系统选择窗口里选的屏幕或窗口，录好的片段存在「下载/GGIF录屏」');
plutil('-insert', 'CFBundleDocumentTypes', '-json', JSON.stringify(docTypes), PLIST);

// helper：名字里的 Electron 换成 GGIF，标识加后缀（可执行文件名不改，Electron 按它找 helper）
const FW = path.join(C, 'Frameworks');
for (const h of readdirSync(FW).filter((d) => /^Electron Helper.*\.app$/.test(d))) {
  const hp = path.join(FW, h, 'Contents', 'Info.plist');
  const kind = (h.match(/\((.+)\)/) || [])[1]; // GPU / Plugin / Renderer / 无
  const hname = h.replace(/\.app$/, '').replace(/^Electron/, NAME);
  setStr(hp, 'CFBundleName', hname);
  setStr(hp, 'CFBundleDisplayName', hname);
  setStr(hp, 'CFBundleIdentifier', `${BUNDLE_ID}.helper${kind ? `.${kind}` : ''}`);
}

// ---------- 4. 图标 ----------
const iconSrc = path.join(APP_DIR, 'assets', 'icon-1024.png');
if (existsSync(iconSrc)) {
  step('做图标（sips + iconutil）');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gifkit-icon-'));
  const set = path.join(tmp, 'icon.iconset');
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    sh('sips', ['-z', String(s), String(s), iconSrc, '--out', path.join(set, `icon_${s}x${s}.png`)]);
    sh('sips', ['-z', String(s * 2), String(s * 2), iconSrc, '--out', path.join(set, `icon_${s}x${s}@2x.png`)]);
  }
  sh('iconutil', ['-c', 'icns', '-o', path.join(R, 'electron.icns'), set]);
  rmSync(tmp, { recursive: true, force: true });
  setStr(PLIST, 'CFBundleIconFile', 'electron.icns');
} else {
  step(`没有图标母版 ${iconSrc}，沿用 Electron 默认图标`);
}

// ---------- 5. 查包里的程序 ----------
// 每个 Mach-O（程序、动态库）：要有这次的芯片（MACHO：arm64 或 x86_64）、最低系统不高于 MIN_MACOS、只连系统库和包里的东西（@rpath 等）；查不过就不出包。
// 10-23 起：以前 ffmpeg、gifsicle 借本机 Homebrew 的（最低要 macOS 26，还连着 Homebrew 的库），别的 Mac 上跑不了。
const MACHO_MAGIC = [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xcafebabf];
function machOFiles(dir) {
  const out = [];
  const buf = Buffer.alloc(4);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue; // 框架里 Versions/Current 这类链接，真文件另外会走到
    if (e.isDirectory()) {
      out.push(...machOFiles(p));
      continue;
    }
    if (!e.isFile()) continue;
    const fd = openSync(p, 'r');
    const n = readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    if (n === 4 && MACHO_MAGIC.includes(buf.readUInt32BE(0))) out.push(p);
  }
  return out;
}
const verGt = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
function auditMachO(root) {
  const files = machOFiles(root);
  const problems = [];
  // otool 把「名字(xxx)」当成静态库里的成员，「Electron Helper (GPU)」这类名字会被拆开、报找不到文件（10-23 踩到）：
  // 路径里有括号就先做个不带括号的链接再查
  const linkDir = mkdtempSync(path.join(os.tmpdir(), 'gifkit-otool-'));
  let k = 0;
  const forOtool = (f) => {
    if (!/[()]/.test(f)) return f;
    const l = path.join(linkDir, `f${k++}`);
    symlinkSync(f, l);
    return l;
  };
  try {
    for (const f of files) {
      const rel = path.relative(root, f);
      try {
        const archs = sh('lipo', ['-archs', f]).trim().split(/\s+/);
        if (!archs.includes(MACHO)) {
          problems.push(`${rel}：没有 ${MACHO}（${archs.join(' ')}）`);
          continue;
        }
        const g = forOtool(f);
        const l = sh('otool', ['-arch', MACHO, '-l', g]);
        const minos = (l.match(/LC_BUILD_VERSION[\s\S]*?minos (\S+)/) || l.match(/LC_VERSION_MIN_MACOSX[\s\S]*?version (\S+)/) || [])[1];
        if (!minos) problems.push(`${rel}：找不到最低系统版本`);
        else if (verGt(minos, MIN_MACOS)) problems.push(`${rel}：最低系统 ${minos}，高于 ${MIN_MACOS}`);
        const deps = sh('otool', ['-arch', MACHO, '-L', g]).split('\n').slice(1).map((x) => x.trim().split(' (compatibility')[0]).filter(Boolean);
        for (const d of deps) {
          if (!/^(\/usr\/lib\/|\/System\/Library\/|@rpath\/|@executable_path\/|@loader_path\/)/.test(d)) problems.push(`${rel}：连着 ${d}`);
        }
      } catch (e) {
        problems.push(`${rel}：查不了（${String(e.stderr || e.message).trim().split('\n')[0]}）`);
      }
    }
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
  return { count: files.length, problems };
}
step(`查包里的程序（${MACHO}、最低 macOS ${MIN_MACOS}、只连系统库）`);
const audit = auditMachO(STAGE);
if (audit.problems.length) fail(`包里有 ${audit.problems.length} 个程序在别的 Mac 上可能跑不了：\n  ${audit.problems.join('\n  ')}`);
step(`  ${audit.count} 个程序都过了`);

// ---------- 6. 本机签名 ----------
if (SIGN) {
  step('本机签名（ad-hoc）并验证');
  sh('xattr', ['-cr', STAGE]); // 清掉扩展属性，否则 codesign 报上面那个错
  sh('codesign', ['--force', '--sign', '-', recDst]); // 录屏小助手放在 Contents/MacOS 里，--deep 不一定会签它，先单独签
  sh('codesign', ['--force', '--deep', '--sign', '-', STAGE]);
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', STAGE], { stdio: ['ignore', 'pipe', 'pipe'] });
    // 放在 Resources 里的程序 --deep 不签（当资源封进包里），它们自己的签名（编好时签的）也要有效，不然 Apple 芯片上跑不起来
    for (const n of [...ENC_BINS, 'gifski']) execFileSync('codesign', ['--verify', path.join(vendor, n)], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    fail(`签名验证没通过：${String(e.stderr || e.message).trim()}`);
  }
} else {
  if (DMG) fail('--dmg 不能和 --no-sign 一起用（没签名的包在 Apple 芯片的 Mac 上打不开）');
  step('跳过签名（--no-sign）');
}

// ---------- 7. dmg（给别的 Mac 装） ----------
const FIRST_OPEN = `GGIF ${pkg.version}（给 ${ARCHS[ARCH].label}的 Mac，macOS ${MIN_MACOS.replace(/\.0$/, '')} 及以上）
${X64 ? '这是 Intel 芯片版；Apple 芯片（M1、M2 等）的 Mac 请用另一个安装包（文件名带 arm64）。\n' : ''}
【安装】把 GGIF 拖到「应用程序」文件夹上。

【第一次打开】GGIF 没有苹果的开发者签名，第一次打开会被系统拦下：
1. 到「应用程序」里双击 GGIF，弹出提示后点「完成」。
2. 打开「系统设置 → 隐私与安全性」，往下拉到「安全性」，点 GGIF 旁边的「仍要打开」。
3. 再弹出提示时点「仍要打开」，按提示输入这台 Mac 的登录密码。
以后就能直接打开了。打开后，屏幕右上角的菜单栏里会出现 GGIF 的图标。

【压缩时提示打不开 ffmpeg 或 gifsicle】打开「终端」，粘贴下面这行、回车，再退出 GGIF 重新打开：
xattr -dr com.apple.quarantine /Applications/GGIF.app

【录屏】录屏时在系统弹出的窗口里选要录的屏幕或窗口。
`;
let dmgPath = null;
if (DMG) {
  dmgPath = path.join(RELEASE_DIR, `${NAME}-${pkg.version}-${X64 ? 'Intel' : 'arm64'}.dmg`);
  step(`出 dmg：${dmgPath}`);
  const root = mkdtempSync(path.join(os.tmpdir(), 'gifkit-dmg-'));
  sh('ditto', [STAGE, path.join(root, `${NAME}.app`)]);
  symlinkSync('/Applications', path.join(root, '应用程序'));
  writeFileSync(path.join(root, '第一次打开看这里.txt'), `\uFEFF${FIRST_OPEN}`); // 带 BOM：预览、文本编辑认得出是 UTF-8
  mkdirSync(RELEASE_DIR, { recursive: true });
  rmSync(dmgPath, { force: true });
  sh('hdiutil', ['create', '-quiet', '-volname', `${NAME} ${pkg.version}${X64 ? ' Intel' : ''}`, '-srcfolder', root, '-fs', 'HFS+', '-format', 'ULFO', '-ov', dmgPath]);
  rmSync(root, { recursive: true, force: true });
  // 自检：校验、挂上看内容、里面的包签名有效、随包程序能执行
  sh('hdiutil', ['verify', '-quiet', dmgPath]);
  const mnt = mkdtempSync(path.join(os.tmpdir(), 'gifkit-dmgmnt-'));
  sh('hdiutil', ['attach', '-quiet', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmgPath]);
  try {
    const app = path.join(mnt, `${NAME}.app`);
    if (!existsSync(path.join(app, 'Contents', 'MacOS', 'Electron'))) fail('dmg 里没有 GGIF.app');
    const mainArchs = sh('lipo', ['-archs', path.join(app, 'Contents', 'MacOS', 'Electron')]).trim();
    if (!mainArchs.split(/\s+/).includes(MACHO)) fail(`dmg 里的 GGIF.app 是 ${mainArchs} 的，不是 ${MACHO}`);
    if (!lstatSync(path.join(mnt, '应用程序')).isSymbolicLink()) fail('dmg 里没有「应用程序」快捷方式');
    if (!existsSync(path.join(mnt, '第一次打开看这里.txt'))) fail('dmg 里没有「第一次打开看这里.txt」');
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      fail(`dmg 里的包签名验证没通过：${String(e.stderr || e.message).trim()}`);
    }
    for (const n of [...ENC_BINS, 'gifski']) {
      const p = path.join(app, 'Contents', 'Resources', 'engine', 'vendor', n);
      if (!existsSync(p) || !(statSync(p).mode & 0o111)) fail(`dmg 里的包缺 ${n} 或它不能执行`);
    }
  } finally {
    sh('hdiutil', ['detach', '-quiet', mnt]);
    rmSync(mnt, { recursive: true, force: true });
  }
  step(`  dmg 自检过了（${(statSync(dmgPath).size / 1e6).toFixed(1)} MB）`);
}

// ---------- 8. 装到本机 ----------
if (INSTALL) {
  // 改名前装的「GIF工具.app」挪进废纸篓（和新包是同一个程序标识，两份都在，设默认打开方式时可能挑到旧的那份；挪错了能从废纸篓放回）
  const OLD_OUT = path.join(path.dirname(OUT), `${OLD_NAME}.app`);
  if (!opt('--out') && existsSync(OLD_OUT)) {
    step(`改名前的旧包挪进废纸篓：${OLD_OUT}`);
    sh('/usr/bin/trash', [OLD_OUT]);
  }
  // 换 /Applications 里的包可能被系统的「App 管理」权限拦（没在这个位置试过换包，10-23）：拦了就停下说清楚，不绕
  try {
    if (existsSync(OUT)) {
      step(`删掉旧包 ${OUT}`);
      rmSync(OUT, { recursive: true, force: true });
    }
    mkdirSync(path.dirname(OUT), { recursive: true });
    step(`复制到 ${OUT}`);
    sh('ditto', [STAGE, OUT]);
  } catch (e) {
    fail(`换不了 ${OUT}（${String(e.stderr || e.message).trim().split('\n')[0]}）。可能是系统的「App 管理」权限拦了：`
      + '可以用 --dmg 出 dmg、自己把 GGIF 拖进「应用程序」替换；或者到「系统设置 → 隐私与安全性 → App 管理」给运行这个脚本的程序开权限');
  }
  if (SIGN) {
    // 到了文稿目录，iCloud 又会补 FinderInfo，严格验证（--strict）会因此不过；签名本身不受影响，这里用普通验证确认
    try {
      execFileSync('codesign', ['--verify', '--deep', OUT], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      fail(`复制到输出位置后签名验证没通过：${String(e.stderr || e.message).trim()}`);
    }
  }
}
rmSync(STAGE_DIR, { recursive: true, force: true });

// ---------- 结果 ----------
const took = `用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒${SIGN ? '，已本机签名' : '，未签名'}`;
if (INSTALL) {
  const du = sh('du', ['-sh', OUT]).split('\t')[0];
  console.log(`\n完成：${OUT}（${du}，${took}）`);
  console.log(`菜单栏模式试跑：GIFKIT_TRAY_DROP=<文件> "${path.join(OUT, 'Contents', 'MacOS', 'Electron')}"`);
} else {
  console.log(`\n完成（没装到本机，${took}）`);
}
if (dmgPath) console.log(`给${X64 ? ' Intel 芯片的' : '别的'} Mac 装：${dmgPath}`);
