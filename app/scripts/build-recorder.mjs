#!/usr/bin/env node
// 编录屏小助手：native/recorder.swift → native/bin/gifkit-recorder（只用本机命令行工具里的 swiftc，不装 Xcode、不下载东西）。
// 用法（在 app/ 或仓库根目录都行）：node app/scripts/build-recorder.mjs [--arch arm64|x64]。打包脚本 pack.mjs 会先调它。
// 最低系统 macOS 14（系统选择窗口 SCContentSharingPicker 从 14 开始有；选了哪块屏幕的信息要 15.2，低于它时界面按鼠标所在屏幕算）。
// --arch x64 编 Intel 芯片版（10-23 起，源码不用改），放 native/bin/gifkit-recorder-x64，不覆盖开发时用的 Apple 芯片版。
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..');
const SRC = path.join(APP, 'native', 'recorder.swift');
const OUT = path.join(APP, 'native', 'bin', 'gifkit-recorder');
const TARGET = { arm64: 'arm64', x64: 'x86_64' }; // swiftc -target 里的芯片名

export function buildRecorder({ quiet = false, arch = 'arm64' } = {}) {
  if (!TARGET[arch]) throw new Error(`不认识的芯片：${arch}（只有 arm64、x64）`);
  const out = arch === 'arm64' ? OUT : `${OUT}-${arch}`;
  mkdirSync(path.dirname(out), { recursive: true });
  const t0 = Date.now();
  execFileSync('swiftc', ['-O', '-swift-version', '5', '-target', `${TARGET[arch]}-apple-macos14.0`, SRC, '-o', out], { stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (!quiet) console.log(`录屏小助手编好了：${out}（${(statSync(out).size / 1024).toFixed(0)}KB，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--arch');
  buildRecorder({ arch: i > 0 ? process.argv[i + 1] : 'arm64' });
}
