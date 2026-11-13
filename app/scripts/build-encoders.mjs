#!/usr/bin/env node
// 从官方源码编出随包附带的 ffmpeg、ffprobe、gifsicle：Apple 芯片（arm64）、最低 macOS 14、只连系统库（界面与打包卷 7.4，方案 §十）。
// 版本和本机 Homebrew 10-23 在用的一样（ffmpeg 9.0.1、x264 r3222、libvmaf 3.2.1、dav1d 1.5.4、gifsicle 1.97），
// 校验值抄自 Homebrew 配方（/opt/homebrew/Cellar/<名字>/<版本>/.brew/<名字>.rb）；本机还装着这些配方时，下载后再对一遍。
// ffmpeg 要带的外挂库只有三个：libvmaf（算 VMAF）、x264（GIF 预览视频）、dav1d（AV1 解码）；其余都是 ffmpeg 自带的。
//
// 用法（在仓库根目录）：node app/scripts/build-encoders.mjs [fetch|tools|build|all] [--arch arm64|x64]（默认 all、arm64）
//   fetch  下载源码包、核对 sha256（x264 用 git 取指定提交）
//   tools  建 Python 虚拟环境，装 meson、ninja、pkgconf（只装在这里，不动系统）
//   build  解开源码，编静态库和三个程序，放进 成品/
//   --arch x64  编 Intel 芯片版（10-23 起，日常更新维护卷「Intel 版」）：在这台 Apple 芯片的 Mac 上交叉编译（clang -arch x86_64），
//               x86 汇编要 nasm，fetch、tools 跟着下载、编好它（只放 编译工具/nasm/）；成品放 成品-x64/，中间件放 /tmp/gk/enc-x64。
//               不带 --arch 时和以前一模一样（Apple 芯片版的参数没动）。
// 留着的东西在 GIF工具/工具.nosync/编码器/（不进 git、不进 iCloud）：源码包/（含 x264 仓库）、编译工具/venv、成品/（ffmpeg、ffprobe、gifsicle、licenses/、源码与编译参数.txt）。
// 解开的源码、编译中间件、静态库放 /tmp/gk/enc（重启会清，重编约 3 分钟）：路径里有中文时，ffmpeg 的 configure 会把 pkg-config 给的头文件路径转义坏，
// 报「dav1d >= 1.0.0 not found using pkg-config」（10-23 踩到），所以这几样只能放纯英文路径。
// 编译时 PATH 只留系统目录和虚拟环境，pkg-config 只看 /tmp/gk/enc/prefix：不会把 Homebrew 的库或工具带进来（编完用 otool -L 再查）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..'); // 代码.nosync/
const GIF_ROOT = path.resolve(REPO, '..'); // GIF工具/
export const ENC_ROOT = path.join(GIF_ROOT, '工具.nosync', '编码器');
export const MIN_MACOS = '14.0';
// 芯片：arm64 = Apple 芯片（默认），x64 = Intel 芯片；macho 是 lipo / otool 里的叫法
export const ARCHS = { arm64: { macho: 'arm64', label: 'Apple 芯片' }, x64: { macho: 'x86_64', label: 'Intel 芯片' } };
export const productDir = (arch = 'arm64') => path.join(ENC_ROOT, arch === 'arm64' ? '成品' : `成品-${arch}`);
export const PRODUCT_DIR = productDir('arm64');
const WORKS = { arm64: '/tmp/gk/enc', x64: '/tmp/gk/enc-x64' }; // 只能是纯英文路径（见开头）；两种芯片分开放，互不覆盖
let ARCH = 'arm64';
let WORK = WORKS.arm64;
const D = {
  tar: path.join(ENC_ROOT, '源码包'),
  venv: path.join(ENC_ROOT, '编译工具', 'venv'),
  nasm: path.join(ENC_ROOT, '编译工具', 'nasm'), // 只有编 Intel 版才用（bin/nasm）
  out: PRODUCT_DIR,
  src: path.join(WORK, 'src'),
  build: path.join(WORK, 'build'),
  prefix: path.join(WORK, 'prefix'),
};
function useArch(a) {
  if (!ARCHS[a]) fail(`不认识的芯片：${a}（只有 arm64、x64）`);
  ARCH = a;
  WORK = WORKS[a];
  Object.assign(D, { out: productDir(a), src: path.join(WORK, 'src'), build: path.join(WORK, 'build'), prefix: path.join(WORK, 'prefix') });
}

const SOURCES = [
  { name: 'ffmpeg', version: '9.0.1', url: 'https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz',
    sha256: 'cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635', license: 'GPL-2.0-or-later（带 x264 编）' },
  { name: 'libvmaf', version: '3.2.1', url: 'https://github.com/Netflix/vmaf/archive/refs/tags/v3.2.1.tar.gz', file: 'libvmaf-3.2.1.tar.gz',
    sha256: '5df7386911bc15fd1ca783132528748d219768ae4fc5f8e0b61184f041648092', license: 'BSD-2-Clause-Patent' },
  { name: 'dav1d', version: '1.5.4', url: 'https://code.videolan.org/videolan/dav1d/-/archive/1.5.4/dav1d-1.5.4.tar.bz2',
    sha256: '2abfb0c89212e6e4733a54e0ae509ec00a5b845a6360946f918806e14aedb011', license: 'BSD-2-Clause' },
  { name: 'gifsicle', version: '1.97', url: 'https://www.lcdf.org/gifsicle/gifsicle-1.97.tar.gz',
    sha256: '17d98f305372e8c6c47c3fa7c75a9ebd9a8dea0b47c739d0b3be6c30a1c1da7a', license: 'GPL-2.0-only' },
];
const X264 = { name: 'x264', version: 'r3222', git: 'https://code.videolan.org/videolan/x264.git', branch: 'stable',
  commit: 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55', license: 'GPL-2.0-or-later' };
// nasm：只有编 Intel 版才要（x264、libvmaf、dav1d、ffmpeg 的 x86 汇编都靠它，没有就只能关掉汇编、压缩慢很多），只在编译时用、不随包；
// 校验值抄自本机 Homebrew 的配方记录（~/Library/Caches/Homebrew/api 里 10-15 的缓存）
const NASM = { name: 'nasm', version: '3.02', url: 'https://www.nasm.us/pub/nasm/releasebuilds/3.02/nasm-3.02.tar.xz',
  sha256: '87336eba53b4acfe917424ab5d500d2b0054d9f5148d35c2273ccf2cfb712f0d', license: 'BSD-2-Clause' };
const PY_TOOLS = [['meson', '1.12.1'], ['ninja', '1.13.2'], ['pkgconf', '3.0.7.post0']];
const PYTHON = '/opt/homebrew/bin/python3.13'; // 系统自带的 Python 3.9 装不了新版 meson（要 3.10+）

const srcDir = (s) => path.join(D.src, `${s.name}-${s.version}`);
const tarFile = (s) => path.join(D.tar, s.file || path.basename(new URL(s.url).pathname));
const X264_REPO = path.join(D.tar, `${X264.name}-${X264.version}`);

function step(msg) {
  console.log(`· ${msg}`);
}
function fail(msg) {
  console.error(`编码器编译失败：${msg}`);
  process.exit(1);
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
/** 只删 编码器/ 和 /tmp/gk/enc、/tmp/gk/enc-x64 里面的东西（防手滑删到别处） */
function rmInside(p) {
  const r = path.resolve(p);
  const roots = [ENC_ROOT, ...Object.values(WORKS)];
  if (!roots.some((root) => r.startsWith(root + path.sep))) fail(`拒绝删除 ${roots.join('、')} 以外的路径：${p}`);
  rmSync(r, { recursive: true, force: true });
}
const gitHead = (dir) => (existsSync(path.join(dir, '.git')) ? sh('git', ['-C', dir, 'rev-parse', 'HEAD']).trim() : '');
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
/** 本机 Homebrew 配方里记的源码 sha256（和脚本里抄的再对一遍；没装就返回 null） */
function brewSha(formula) {
  const cellar = path.join('/opt/homebrew/Cellar', formula);
  if (!existsSync(cellar)) return null;
  for (const v of readdirSync(cellar)) {
    const rb = path.join(cellar, v, '.brew', `${formula}.rb`);
    if (!existsSync(rb)) continue;
    const m = readFileSync(rb, 'utf8').match(/^\s*sha256 "([0-9a-f]{64})"/m);
    if (m) return m[1];
  }
  return null;
}

// ---------- fetch ----------
function fetchAll() {
  mkdirSync(D.tar, { recursive: true });
  for (const s of ARCH === 'x64' ? [...SOURCES, NASM] : SOURCES) {
    const brew = brewSha(s.name);
    if (brew && brew !== s.sha256) fail(`${s.name} 脚本里的 sha256 和本机 Homebrew 配方不一样（${brew}）`);
    const file = tarFile(s);
    if (!existsSync(file) || sha256(file) !== s.sha256) {
      step(`下载 ${s.name} ${s.version}：${s.url}`);
      const part = `${file}.part`;
      sh('curl', ['-fL', '--retry', '2', '--max-time', '600', '-sS', '-o', part, s.url], { stdio: ['ignore', 'inherit', 'inherit'] });
      const got = sha256(part);
      if (got !== s.sha256) {
        rmInside(part);
        fail(`${s.name} 校验值对不上：下到的是 ${got}，应该是 ${s.sha256}`);
      }
      renameSync(part, file);
    }
    const mb = (readFileSync(file).length / 1e6).toFixed(1);
    step(`${s.name} ${s.version} 校验通过（${mb} MB，sha256 ${s.sha256.slice(0, 12)}…${brew ? '，和本机 Homebrew 配方一致' : ''}）`);
  }
  // x264 只有 git 仓库：克隆 stable 分支（要完整历史，版本号 r3222 是按提交数算的），检出 Homebrew 用的那个提交
  if (gitHead(X264_REPO) !== X264.commit) {
    rmInside(X264_REPO);
    step(`取 x264（git，${X264.branch} 分支，提交 ${X264.commit.slice(0, 12)}）：${X264.git}`);
    sh('git', ['clone', '-q', '--branch', X264.branch, '--single-branch', X264.git, X264_REPO], { stdio: ['ignore', 'inherit', 'inherit'] });
    sh('git', ['-C', X264_REPO, '-c', 'advice.detachedHead=false', 'checkout', '-q', X264.commit]);
  }
  checkX264(X264_REPO);
}

function checkX264(dir) {
  if (gitHead(dir) !== X264.commit) fail(`x264 检出的提交不对：${gitHead(dir)}`);
  const n = sh('git', ['-C', dir, 'rev-list', '--count', 'HEAD']).trim();
  if (`r${n}` !== X264.version) fail(`x264 版本号算出来是 r${n}，和 Homebrew 的 ${X264.version} 不一样`);
  step(`x264 提交核对通过（${X264.commit.slice(0, 12)}，第 ${n} 个提交 → 版本 r${n}）`);
}

/** 把源码解到 /tmp/gk/enc/src（每次重新解，免得上次编过的残留） */
function extractAll() {
  for (const s of SOURCES) {
    const file = tarFile(s);
    if (!existsSync(file) || sha256(file) !== s.sha256) fail(`先跑 fetch：${file} 不在或校验值不对`);
    const dir = srcDir(s);
    rmInside(dir);
    mkdirSync(dir, { recursive: true });
    sh('tar', ['-xf', file, '-C', dir, '--strip-components', '1']);
  }
  const xdir = path.join(D.src, `${X264.name}-${X264.version}`);
  rmInside(xdir);
  sh('git', ['clone', '-q', '--no-hardlinks', X264_REPO, xdir]); // 本地克隆，不联网
  sh('git', ['-C', xdir, '-c', 'advice.detachedHead=false', 'checkout', '-q', X264.commit]);
  checkX264(xdir);
  step(`源码解到 ${D.src}`);
}

// ---------- tools ----------
function toolsSetup() {
  if (!existsSync(PYTHON)) fail(`找不到 ${PYTHON}`);
  const py = path.join(D.venv, 'bin', 'python3');
  if (!existsSync(py)) {
    step(`建 Python 虚拟环境：${D.venv}`);
    mkdirSync(path.dirname(D.venv), { recursive: true });
    sh(PYTHON, ['-m', 'venv', D.venv]);
  }
  // 版本钉死，pip 按 PyPI 记的 sha256 核对每个文件（--require-hashes）
  const lines = [];
  for (const [pkg, ver] of PY_TOOLS) {
    const j = JSON.parse(sh('curl', ['-fsSL', '--max-time', '60', `https://pypi.org/pypi/${pkg}/${ver}/json`]));
    const hashes = j.urls.map((u) => `--hash=sha256:${u.digests.sha256}`);
    if (!hashes.length) fail(`PyPI 上没有 ${pkg} ${ver} 的文件`);
    lines.push(`${pkg}==${ver} ${hashes.join(' ')}`);
  }
  const req = path.join(path.dirname(D.venv), 'requirements.txt');
  writeFileSync(req, lines.join('\n') + '\n');
  step(`装 ${PY_TOOLS.map(([p, v]) => `${p} ${v}`).join('、')}（按 sha256 核对）`);
  sh(py, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '--only-binary=:all:', '--require-hashes', '-r', req],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  const bin = path.join(D.venv, 'bin');
  for (const t of ['meson', 'ninja', 'pkgconf']) {
    const p = path.join(bin, t);
    if (!existsSync(p)) fail(`虚拟环境里没有 ${t}`);
    step(`${t} ${sh(p, ['--version']).trim().split('\n')[0]}`);
  }
  if (ARCH === 'x64') buildNasm();
}

/** 编 nasm（编 Intel 版时 x86 汇编用）：在本机按本机芯片编，只把 nasm 放进 编译工具/nasm/bin，不动系统；已经是这个版本就跳过 */
function buildNasm() {
  const bin = path.join(D.nasm, 'bin', 'nasm');
  const ver = () => sh(bin, ['-v']).trim();
  if (existsSync(bin) && ver().includes(`version ${NASM.version} `)) {
    step(`nasm 已经编好：${ver()}`);
    return;
  }
  const file = tarFile(NASM);
  if (!existsSync(file) || sha256(file) !== NASM.sha256) fail(`先跑 fetch --arch x64：${file} 不在或校验值不对`);
  const dir = path.join(D.src, `${NASM.name}-${NASM.version}`);
  rmInside(dir);
  mkdirSync(dir, { recursive: true });
  sh('tar', ['-xf', file, '-C', dir, '--strip-components', '1']);
  const env = buildEnv();
  runLogged('nasm', './configure', [], { cwd: dir, env });
  runLogged('nasm', 'make', ['-j', String(os.cpus().length), 'nasm'], { cwd: dir, env });
  mkdirSync(path.dirname(bin), { recursive: true });
  copyFileSync(path.join(dir, 'nasm'), bin);
  chmodSync(bin, 0o755);
  copyFileSync(path.join(dir, 'LICENSE'), path.join(D.nasm, 'LICENSE'));
  if (!ver().includes(`version ${NASM.version} `)) fail(`编好的 nasm 版本不对：${ver()}`);
  step(`nasm 编好：${ver()}`);
}

// ---------- build ----------
// 编译输出写进 编译/日志/<名字>.log，出错时打印最后 40 行。
function runLogged(name, cmd, args, { cwd, env }) {
  const log = path.join(D.build, '日志', `${name}.log`);
  mkdirSync(path.dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  writeSync(fd, `\n$ ${cmd} ${args.join(' ')}\n`);
  try {
    execFileSync(cmd, args, { cwd, env, stdio: ['ignore', fd, fd] });
  } catch {
    closeSync(fd);
    const tail = readFileSync(log, 'utf8').split('\n').slice(-40).join('\n');
    fail(`${name} 这一步出错（${cmd} ${args[0] || ''}），日志 ${log} 最后 40 行：\n${tail}`);
  }
  closeSync(fd);
}

/** 编译时的环境：PATH 只留虚拟环境和系统目录，pkg-config 只看 装好/，去掉会把别处头文件、库带进来的变量 */
function buildEnv() {
  const bin = path.join(D.venv, 'bin');
  const env = { ...process.env };
  for (const k of ['CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'PKG_CONFIG_PATH']) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('DYLD_') || k.startsWith('HOMEBREW_')) delete env[k];
  return {
    ...env,
    // 编 Intel 版时加上 nasm（x264、ffmpeg 的 configure 按名字在 PATH 里找它）
    PATH: [bin, ...(ARCH === 'x64' ? [path.join(D.nasm, 'bin')] : []), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    MACOSX_DEPLOYMENT_TARGET: MIN_MACOS,
    PKG_CONFIG: path.join(bin, 'pkgconf'),
    PKG_CONFIG_LIBDIR: path.join(D.prefix, 'lib', 'pkgconfig'),
  };
}

// 编译器参数：Intel 版加 -arch x86_64（交叉编译）；Apple 芯片版和 10-23 第一次编的一样
const flags = () => (ARCH === 'x64' ? `-arch x86_64 -mmacosx-version-min=${MIN_MACOS}` : `-mmacosx-version-min=${MIN_MACOS}`);
// ffmpeg 的编译参数（写进 源码与编译参数.txt）：只开要用的三个外挂库，系统框架照 Homebrew 开；不编 ffplay、联网、文档
function ffmpegArgs() {
  const F = flags();
  return [
    '--cc=clang', '--cxx=clang++', '--pkg-config-flags=--static',
    '--enable-static', '--disable-shared', '--enable-pthreads',
    '--enable-gpl', '--enable-libx264', '--enable-libvmaf', '--enable-libdav1d',
    '--enable-videotoolbox', '--enable-audiotoolbox',
    // Apple 芯片开 NEON 汇编；Intel 版是交叉编译，x86 汇编靠 nasm（configure 找到就开，编完 checkAsm 再查一遍）
    ...(ARCH === 'x64' ? ['--enable-cross-compile', '--arch=x86_64', '--target-os=darwin'] : ['--enable-neon']),
    '--disable-ffplay', '--disable-doc', '--disable-network', '--disable-sdl2',
    `--extra-cflags=${F}`, `--extra-ldflags=${F}`,
    '--extra-libs=-lc++', // libvmaf 里有 C++（svm.cpp），静态链接要带上系统的 libc++
    '--extra-version=ggif',
  ];
}

/** meson 交叉编译配置（Intel 版的 libvmaf、dav1d 用）：编译器带 -arch x86_64；本机有 Rosetta，编出来的测试程序能直接跑 */
function writeCrossFile() {
  const file = path.join(WORK, 'cross-x64.ini');
  const q = (s) => `'${s.replace(/'/g, "\\'")}'`;
  writeFileSync(file, [
    '[binaries]',
    "c = ['clang', '-arch', 'x86_64']",
    "cpp = ['clang++', '-arch', 'x86_64']",
    "objc = ['clang', '-arch', 'x86_64']",
    "ar = 'ar'",
    "strip = 'strip'",
    `nasm = ${q(path.join(D.nasm, 'bin', 'nasm'))}`,
    `pkg-config = ${q(path.join(D.venv, 'bin', 'pkgconf'))}`,
    '',
    '[properties]',
    'needs_exe_wrapper = false',
    '',
    '[host_machine]',
    "system = 'darwin'",
    "cpu_family = 'x86_64'",
    "cpu = 'x86_64'",
    "endian = 'little'",
    '',
  ].join('\n'));
  return file;
}

/** Intel 版：四个库的 x86 汇编都要开着（找不到 nasm 时有的会悄悄关掉汇编，压缩慢很多）；查各自编译目录里的 config.h */
function checkAsm(dirs) {
  const found = (dir, re) => {
    const hits = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'config.h' && re.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(dir);
    return hits.length > 0;
  };
  const want = [
    ['x264', dirs.x264, /#define HAVE_MMX 1/],
    ['libvmaf', dirs.libvmaf, /#define HAVE_ASM 1/],
    ['dav1d', dirs.dav1d, /#define HAVE_ASM 1/],
    ['ffmpeg', dirs.ffmpeg, /#define HAVE_X86ASM 1/],
  ];
  const off = want.filter(([, dir, re]) => !found(dir, re)).map(([n]) => n);
  if (off.length) fail(`这几个的 x86 汇编没开：${off.join('、')}（看 ${path.join(D.build, '日志')} 里有没有找到 nasm）`);
  step('x264、libvmaf、dav1d、ffmpeg 的 x86 汇编都开着');
}

function buildAll() {
  const bin = path.join(D.venv, 'bin');
  for (const t of ['meson', 'ninja', 'pkgconf']) if (!existsSync(path.join(bin, t))) fail(`先跑 tools：虚拟环境里缺 ${t}`);
  const xsrc = path.join(D.src, `${X264.name}-${X264.version}`);
  extractAll();
  rmInside(D.prefix);
  rmInside(D.build);
  mkdirSync(D.prefix, { recursive: true });
  mkdirSync(D.build, { recursive: true });
  const env = buildEnv();
  const P = D.prefix;
  const FLAGS = flags();
  const X64 = ARCH === 'x64';
  if (X64 && !existsSync(path.join(D.nasm, 'bin', 'nasm'))) fail('先跑 tools --arch x64：还没编 nasm');
  const HOST = X64 ? ['--host=x86_64-apple-darwin'] : []; // x264、gifsicle 的 configure 用：告诉它编给 Intel
  const CROSS = X64 ? [`--cross-file=${writeCrossFile()}`] : []; // libvmaf、dav1d 的 meson 用
  const jobs = String(os.cpus().length);
  const sub = (n) => {
    const d = path.join(D.build, n);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const meson = path.join(bin, 'meson');
  const mesonLib = (name, src, opts) => {
    const b = sub(name);
    runLogged(name, meson, ['setup', b, src, ...CROSS, `--prefix=${P}`, '--libdir=lib', '--buildtype=release', '--default-library=static',
      '--wrap-mode=nodownload', `-Dc_args=${FLAGS}`, `-Dcpp_args=${FLAGS}`, `-Dc_link_args=${FLAGS}`, `-Dcpp_link_args=${FLAGS}`, ...opts], { env });
    runLogged(name, meson, ['compile', '-C', b], { env });
    runLogged(name, meson, ['install', '-C', b], { env });
  };

  let t = Date.now();
  const done = (what) => {
    step(`${what}（${((Date.now() - t) / 1000).toFixed(0)} 秒）`);
    t = Date.now();
  };

  // x264：只要静态库（参数照 Homebrew，去掉命令行程序和动态库）
  const xb = sub('x264');
  runLogged('x264', path.join(xsrc, 'configure'), [`--prefix=${P}`, ...HOST, '--enable-static', '--enable-pic', '--disable-cli',
    '--disable-lsmash', '--disable-swscale', '--disable-ffms', `--extra-cflags=${FLAGS}`, `--extra-ldflags=${FLAGS}`], { cwd: xb, env });
  runLogged('x264', 'make', ['-j', jobs], { cwd: xb, env });
  runLogged('x264', 'make', ['install-lib-static'], { cwd: xb, env });
  done('x264 编好');

  // libvmaf：默认选项（和 Homebrew 一样：内置模型、不开 float），不编测试、文档、命令行工具
  mesonLib('libvmaf', path.join(srcDir(SOURCES[1]), 'libvmaf'), ['-Denable_tests=false', '-Denable_docs=false', '-Denable_tools=false']);
  done('libvmaf 编好');

  // dav1d：8 位和高位深都要（默认），不编命令行工具、测试
  mesonLib('dav1d', srcDir(SOURCES[2]), ['-Denable_tools=false', '-Denable_tests=false', '-Denable_examples=false', '-Denable_docs=false']);
  done('dav1d 编好');

  // ffmpeg：在 编译/ffmpeg 里另起目录编（不弄脏源码）
  const fb = sub('ffmpeg');
  runLogged('ffmpeg', path.join(srcDir(SOURCES[0]), 'configure'), [`--prefix=${P}`, `--pkg-config=${env.PKG_CONFIG}`, ...ffmpegArgs()], { cwd: fb, env });
  done('ffmpeg configure 过了');
  runLogged('ffmpeg', 'make', ['-j', jobs], { cwd: fb, env });
  done('ffmpeg 编好');

  // gifsicle：照 Homebrew（不编 gifview，它要 X11）
  const gb = sub('gifsicle');
  runLogged('gifsicle', path.join(srcDir(SOURCES[3]), 'configure'), ['--disable-dependency-tracking', '--disable-gifview', ...HOST,
    `CFLAGS=-O2 ${FLAGS}`, `LDFLAGS=${FLAGS}`], { cwd: gb, env });
  runLogged('gifsicle', 'make', ['-j', jobs], { cwd: gb, env });
  done('gifsicle 编好');

  if (X64) checkAsm({ x264: xb, libvmaf: path.join(D.build, 'libvmaf'), dav1d: path.join(D.build, 'dav1d'), ffmpeg: fb });

  // ---------- 成品 ----------
  rmInside(D.out);
  mkdirSync(path.join(D.out, 'licenses'), { recursive: true });
  for (const [from, name] of [[path.join(fb, 'ffmpeg'), 'ffmpeg'], [path.join(fb, 'ffprobe'), 'ffprobe'], [path.join(gb, 'src', 'gifsicle'), 'gifsicle']]) {
    const to = path.join(D.out, name);
    copyFileSync(from, to);
    chmodSync(to, 0o755);
    sh('strip', [to]);
    sh('codesign', ['--force', '--sign', '-', to]); // strip 以后重签（Apple 芯片上没有有效签名的程序跑不起来）
    const archs = sh('lipo', ['-archs', to]).trim();
    if (archs !== ARCHS[ARCH].macho) fail(`${name} 编出来的芯片是 ${archs}，应该是 ${ARCHS[ARCH].macho}`);
  }
  const lic = [
    ['ffmpeg', srcDir(SOURCES[0]), ['LICENSE.md', 'COPYING.GPLv2', 'COPYING.LGPLv2.1']],
    ['x264', xsrc, ['COPYING']],
    ['libvmaf', srcDir(SOURCES[1]), ['LICENSE']],
    ['dav1d', srcDir(SOURCES[2]), ['COPYING']],
    ['gifsicle', srcDir(SOURCES[3]), ['COPYING']],
  ];
  for (const [n, dir, files] of lic) {
    for (const f of files) {
      if (!existsSync(path.join(dir, f))) fail(`${n} 源码里没有许可文件 ${f}`);
      copyFileSync(path.join(dir, f), path.join(D.out, 'licenses', `${n}-${f}`));
    }
  }
  const info = [
    `GGIF 随包附带的 ffmpeg、ffprobe、gifsicle 是从下面这些官方源码编出来的（${ARCHS[ARCH].label}、最低 macOS 14、静态链接，只连系统库）。`,
    `编译脚本：GGIF 源码里的 app/scripts/build-encoders.mjs${X64 ? ' --arch x64（在 Apple 芯片的 Mac 上交叉编译）' : ''}；编于 ${new Date().toISOString().slice(0, 10)}。`,
    '',
    ...SOURCES.map((s) => `${s.name} ${s.version}（${s.license}）\n  源码：${s.url}\n  sha256：${s.sha256}`),
    `${X264.name} ${X264.version}（${X264.license}）\n  源码：${X264.git}（${X264.branch} 分支，提交 ${X264.commit}）`,
    ...(X64 ? [`${NASM.name} ${NASM.version}（${NASM.license}，只在编译时用来编 x86 汇编，不随包）\n  源码：${NASM.url}\n  sha256：${NASM.sha256}`] : []),
    '',
    `ffmpeg 编译参数：${ffmpegArgs().join(' ')}`,
    '许可证原文在同目录的 licenses/ 里。ffmpeg 带 x264 编，整体按 GPL-2.0-or-later 发布；gifsicle 是 GPL-2.0-only。',
    '',
  ].join('\n');
  writeFileSync(path.join(D.out, '源码与编译参数.txt'), info);
  step(`成品放进 ${D.out}`);
  for (const n of ['ffmpeg', 'ffprobe', 'gifsicle']) {
    const p = path.join(D.out, n);
    console.log(`  ${n}  ${(statSync(p).size / 1e6).toFixed(1)} MB  ${sh(p, n === 'gifsicle' ? ['--version'] : ['-hide_banner', '-version']).split('\n')[0]}`);
  }
}

// 打包脚本会 import 这里的 PRODUCT_DIR、productDir、ARCHS、MIN_MACOS：只有直接运行时才干活
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ai = args.indexOf('--arch');
  if (ai >= 0) {
    useArch(args[ai + 1]);
    args.splice(ai, 2);
  }
  const what = args[0] || 'all';
  const t0 = Date.now();
  if (!['fetch', 'tools', 'build', 'all'].includes(what) || args.length > 1) fail(`不认识的参数：${args.join(' ')}`);
  step(`芯片：${ARCHS[ARCH].label}（${ARCH}）；成品放 ${D.out}；中间件放 ${WORK}`);
  if (what === 'fetch' || what === 'all') fetchAll();
  if (what === 'tools' || what === 'all') toolsSetup();
  if (what === 'build' || what === 'all') buildAll();
  console.log(`\n完成（${what}，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
}
