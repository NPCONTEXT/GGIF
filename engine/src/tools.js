// 外部程序的位置和统一的调用方式。
// 位置可以用环境变量改：GIFKIT_FFMPEG、GIFKIT_FFPROBE、GIFKIT_GIFSICLE、GIFKIT_GIFSKI、GIFKIT_LESSGIF_WASM。
// 查找顺序：环境变量 → 引擎目录下的 vendor/（打包时复制进 .app，存在才用）→ 开发时的位置
// （gifski、lessgif.wasm 在 GIF工具/ 目录里；ffmpeg、ffprobe、gifsicle 在 PATH 和 Homebrew 目录里找）。
// 0.4.0 起 ffmpeg、ffprobe、gifsicle 也随包（app/scripts/build-encoders.mjs 从源码编），装好的包不再用本机 Homebrew 的。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_ROOT = path.resolve(here, '..');
const GIF_ROOT = path.resolve(ENGINE_ROOT, '..', '..'); // GIF工具/（开发时的目录结构）
const VENDOR = path.join(ENGINE_ROOT, 'vendor'); // 打包后随包附带的程序（app/scripts/pack.mjs 复制进去；开发目录里没有）
const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : ''; // Windows 上程序名带 .exe（Windows版卷 11-07）

/** 随包附带的那份存在就用它，否则用开发时的位置。 */
function vendorOr(name, devPath) {
  const p = path.join(VENDOR, name);
  return existsSync(p) ? p : devPath;
}

const EXTRA_PATH = WIN ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']; // Homebrew 那几个目录只在 Mac 上找

function which(name) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...EXTRA_PATH];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name + EXE);
    if (existsSync(p)) return p;
  }
  return null;
}

export const TOOLS = {
  ffmpeg: process.env.GIFKIT_FFMPEG || vendorOr('ffmpeg' + EXE, which('ffmpeg')),
  ffprobe: process.env.GIFKIT_FFPROBE || vendorOr('ffprobe' + EXE, which('ffprobe')),
  gifsicle: process.env.GIFKIT_GIFSICLE || vendorOr('gifsicle' + EXE, which('gifsicle')),
  gifski: process.env.GIFKIT_GIFSKI
    || vendorOr('gifski' + EXE, path.join(GIF_ROOT, '工具.nosync', 'gifski-1.34.0', WIN ? 'win' : 'mac', 'gifski' + EXE)),
  lessgifWasm: process.env.GIFKIT_LESSGIF_WASM
    || vendorOr('lessgif.wasm', path.join(GIF_ROOT, '第三方.nosync', 'lessgif-0.1.0', 'lessgif-wasm', 'lessgif.wasm')),
  node: process.env.GIFKIT_NODE || process.execPath,
};

// 在 Electron 里 process.execPath 是 Electron 本身；要它当 Node 跑子进程（lessgif），得带 ELECTRON_RUN_AS_NODE=1，
// 不然会再开一个 Electron 应用卡住（10-17 界面第一次导出时踩到）。
export const NODE_CHILD_ENV = process.versions.electron && !process.env.GIFKIT_NODE
  ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  : process.env;

// 删临时目录：Windows 上文件刚被别的程序占着（杀毒在扫、刚退出的 ffmpeg 还没放手）会删不掉，重试几次；Mac 上不出错就不会重试。
export const RM_RETRY = { maxRetries: 5, retryDelay: 200 };

/** 检查必需的程序都在；返回缺的名字列表。 */
export function missingTools(names = ['ffmpeg', 'ffprobe', 'gifsicle', 'lessgifWasm']) {
  return names.filter((n) => !TOOLS[n] || !existsSync(TOOLS[n]));
}

/**
 * 运行外部程序。不经过 shell，参数原样传（路径里有中文、空格都没问题）。
 * 返回 { code, stdout, stderr, ms }；超时或 signal 取消会杀掉进程并把 code 设为 -1（取消时 aborted 为 true）。
 * countStdout：标准输出只数字节、不存（预估时 ffmpeg 往管道写几十 MB 的 GIF，只要体积），字节数在 stdoutBytes。
 * keepChunks：标准输出按收到的块留着、不拼（快路子顺带留在内存里的原始帧，一两百 MB，拼一次就多占一倍），在 stdoutChunks。
 */
export function run(cmd, args, { timeoutMs = 20 * 60 * 1000, cwd, input, env, signal, countStdout = false, keepChunks = false } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    if (signal?.aborted) return resolve({ code: -1, stdout: '', stderr: '已取消', ms: 0, aborted: true });
    // windowsHide：Windows 上不带的话，从界面起命令行程序每次都会闪一个黑窗口（Mac 上不起作用）
    const p = spawn(cmd, args, { cwd, env: env || process.env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    const err = [];
    let killed = false;
    let aborted = false;
    const timer = setTimeout(() => {
      killed = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      p.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let outBytes = 0;
    p.stdout.on('data', (b) => {
      outBytes += b.length;
      if (!countStdout) out.push(b);
    });
    p.stderr.on('data', (b) => err.push(b));
    if (input) p.stdin.end(input);
    p.on('error', (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: -1, stdout: '', stderr: String(e), ms: performance.now() - t0 });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        code: killed || aborted ? -1 : code,
        stdout: keepChunks ? '' : Buffer.concat(out).toString('utf8'),
        stdoutBuffer: keepChunks ? null : Buffer.concat(out), // 原始字节（ffmpeg 往标准输出写图片时用）
        stdoutChunks: keepChunks ? out : null,
        stdoutBytes: outBytes,
        stderr: Buffer.concat(err).toString('utf8') + (killed ? `\n超时（${timeoutMs} 毫秒）被结束` : '') + (aborted ? '\n已取消' : ''),
        ms: performance.now() - t0,
        aborted,
      });
    });
  });
}

/** 跑 ffmpeg，失败时抛错（带最后几百字的错误信息）。 */
export async function ffmpeg(args, opts) {
  const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', ...args], opts);
  if (r.aborted) throw new Error('已取消');
  if (r.code !== 0) throw new Error(`ffmpeg 失败：${r.stderr.slice(-400)}`);
  return r;
}
