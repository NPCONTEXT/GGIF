// 设置卷第二批（10-22）：操作日志 oplog.js 的脱敏、按天分文件、只留 7 天、写满 5MB 停写；更新日志的版本号和 package.json 一致；
// prefs.js 里第二批加的两项（结果放哪、操作日志）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { OpLog, remember, scrub, KEEP_DAYS, MAX_BYTES } from '../oplog.js';
import { normalizePrefs } from '../prefs.js';

const require = createRequire(import.meta.url);

test('脱敏：碰到过的路径（带空格也行）、文件名、家目录、用户名都换掉', () => {
  const src = path.join(os.homedir(), 'Documents', '游戏 PV 素材', '新角色 演示.mp4');
  remember(src);
  const s = scrub(`读不了：${src}（ffmpeg 退出 1）`);
  assert.ok(!s.includes('游戏 PV 素材') && !s.includes('新角色 演示.mp4') && !s.includes(os.homedir()), s);
  assert.match(s, /<路径>/);
  assert.ok(!scrub('输出在 /Users/someone/Desktop/a.gif').includes('someone'));
  assert.equal(scrub('结果 abc_压缩.gif 太大'), '结果 <文件> 太大');
  const user = os.userInfo().username;
  assert.ok(!scrub(`用户 ${user} 的文件`).includes(user));
  assert.equal(scrub(42), 42);
});

test('按天分文件、字段里的字符串也脱敏、值是 undefined 的不写；关掉就不写', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-oplog-'));
  try {
    let now = new Date(2026, 9, 22, 3, 21, 5, 123);
    const log = new OpLog({ dir, now: () => now });
    log.log('压缩', '完成', { 素材: 3, 原因: undefined, 结果: '/Users/x/Downloads/录屏.mp4 压好了' });
    now = new Date(2026, 9, 23, 0, 0, 1);
    log.log('启动');
    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, ['GGIF-2026-10-22.log', 'GGIF-2026-10-23.log']);
    const day1 = await readFile(path.join(dir, names[0]), 'utf8');
    assert.match(day1, /^03:21:05\.123 \[压缩\] 完成 \{"素材":3,"结果":"<路径> 压好了"\}\n$/);
    log.setEnabled(false);
    log.log('设置', '不该写');
    assert.ok(!(await readFile(path.join(dir, names[1]), 'utf8')).includes('不该写'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`只留最近 ${KEEP_DAYS} 天（今天算一天），别的名字的文件不动；超过 5MB 写一句就停`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifkit-oplog-'));
  try {
    for (const n of ['GGIF-2026-10-15.log', 'GGIF-2026-10-16.log', 'GGIF-2026-10-22.log', '别的.log']) await writeFile(path.join(dir, n), 'x\n');
    const log = new OpLog({ dir, now: () => new Date(2026, 9, 22, 12) });
    log.prune();
    assert.deepEqual((await readdir(dir)).sort(), ['GGIF-2026-10-16.log', 'GGIF-2026-10-22.log', '别的.log']);
    await writeFile(log.fileFor(), 'y'.repeat(MAX_BYTES + 10));
    log.log('压缩', '第一条');
    log.log('压缩', '第二条');
    const tail = (await readFile(log.fileFor(), 'utf8')).slice(MAX_BYTES + 10);
    assert.match(tail, /超过 5MB，后面的不记了/);
    assert.ok(!tail.includes('第一条') && !tail.includes('第二条'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('更新日志：第一条的版本号和 app/package.json 一致，新的在上、每版都有内容', async () => {
  const CL = require('../renderer/changelog.cjs');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(CL[0].version, pkg.version);
  assert.equal(pkg.version, '0.6.0'); // 第一批 0.2.1、第二批 0.3.0（作者批「分两批」）；10-23 缩略图能拖 0.3.1、修往外拖时张嘴 0.3.2、录屏压完不弹那两条 0.3.3、正式安装包 0.4.0；11-01 打标开关和负载优化 0.5.0、录制帧率和动图整除降帧 0.5.1；11-06 多选导出 0.5.2；11-08 Windows 版一期 0.6.0
  for (const v of CL) assert.ok(v.items.length > 0 && v.date, v.version);
  const nums = CL.map((v) => v.version.split('.').map(Number));
  for (let i = 1; i < nums.length; i++) assert.ok(nums[i - 1].join('.') !== nums[i].join('.') && (nums[i - 1][0] > nums[i][0] || nums[i - 1][1] > nums[i][1] || nums[i - 1][2] > nums[i][2]));
});

test('第二批的两项：结果放哪（只认绝对路径，空的当原文件旁边）、操作日志（默认开）', () => {
  assert.equal(normalizePrefs({}).outDir, null);
  assert.equal(normalizePrefs({}).oplog, true);
  assert.equal(normalizePrefs({ outDir: '/Users/x/Desktop/公众号素材' }).outDir, '/Users/x/Desktop/公众号素材');
  assert.equal(normalizePrefs({ outDir: 'relative/dir' }).outDir, null);
  assert.equal(normalizePrefs({ outDir: 42 }).outDir, null);
  assert.equal(normalizePrefs({ oplog: false }).oplog, false);
});

test('录像放在（10-22 试用反馈 9.6b）：默认 null（= 下载/GGIF录屏），只认绝对路径', () => {
  assert.equal(normalizePrefs({}).recDir, null);
  assert.equal(normalizePrefs({ recDir: '/Volumes/素材盘/录屏' }).recDir, '/Volumes/素材盘/录屏');
  assert.equal(normalizePrefs({ recDir: 'Downloads/录屏' }).recDir, null);
  assert.equal(normalizePrefs({ recDir: 1 }).recDir, null);
});
