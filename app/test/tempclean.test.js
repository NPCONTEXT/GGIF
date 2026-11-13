// 启动时清以前留下的临时目录（tempclean.js，10-31 负载优化）：只挑 GGIF 自己起名的、确实没人在用的。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { staleTempDirs } from '../tempclean.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'gifkit-cleantest-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('挑残留：死了的、太旧的才挑；活着的、刚建的、录屏分块、别人的目录都不动', () => {
  const now = Date.now();
  const mk = (name, hoursAgo, pid) => {
    const p = path.join(root, name);
    mkdirSync(p);
    if (pid !== undefined) writeFileSync(path.join(p, 'owner.pid'), String(pid));
    const t = (now - hoursAgo * 3600e3) / 1000;
    utimesSync(p, t, t);
    return p;
  };
  const alive = (pid) => pid === 111;
  const want = [
    mk('gifkit-app-Dead01', 0.1, 222), // 记的进程不在了
    mk('gifkit-app-OldNo1', 2), // 0.5.0 以前的（没记进程），超过 1 小时
    mk('gifkit-q-Old001', 7), // 压缩工作目录，超过 6 小时
    mk('gifkit-m-Old002', 30),
    mk('gifkit-re-Old003', 7),
    mk('gifkit-score-Old004', 7),
    mk('gifkit-Old005', 7), // 极限档的工作目录
  ];
  mk('gifkit-app-Live01', 48, 111); // 进程还活着：再旧也不动
  mk('gifkit-app-NewNo1', 0.5); // 没记进程、刚建的
  mk('gifkit-q-New001', 1); // 可能正在压
  mk('gifkit-rec-Old006', 48); // 录屏分块：异常退出时是录像的唯一一份
  mk('gifkit-rectest-Abc123', 48); // 测试脚本的
  mk('别的程序', 48);
  writeFileSync(path.join(root, 'gifkit-app-File01'), 'x'); // 同名的文件不是目录
  assert.deepEqual(staleTempDirs(root, { now, alive }).sort(), want.sort());
});

test('目录读不了就当没有', () => {
  assert.deepEqual(staleTempDirs(path.join(root, '不存在')), []);
});
