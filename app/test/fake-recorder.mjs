// 假的录屏小助手（测试用）：和 native/recorder.swift 说一样的命令，但不录屏——
// 「选」直接报选了 1 号屏幕（GIFKIT_REC_FAKE_KIND=window 时报选了一个窗口）；
// 「录」按实际时间把 样本.nosync/录屏分段/ 里的块（10-19 晚实验录的测试画面，8 秒）一块块复制过去，超过 8 秒就不再出块。
// 用法：GIFKIT_REC_HELPER=<这个文件> GIFKIT_REC_TEST=marks|slices electron .
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.GIFKIT_REC_FAKE_SEGS || path.resolve(here, '..', '..', '..', '样本.nosync', '录屏分段');
const man = JSON.parse(readFileSync(path.join(SRC, 'segments.json'), 'utf8')).segments;
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let rec = null; // { dir, t0, timers, sent }
const now = () => (rec ? (Date.now() - rec.t0) / 1000 : null);

function sendSeg(i) {
  const s = man[i];
  if (!rec || rec.sent.has(i)) return;
  rec.sent.add(i);
  copyFileSync(path.join(SRC, s.file), path.join(rec.dir, s.file));
  emit({ ev: 'segment', type: 'media', file: s.file, start: s.start, dur: s.dur, index: i + 1, bytes: statSync(path.join(SRC, s.file)).size });
}

emit({ ev: 'ready', os: 'fake' });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const c = JSON.parse(line);
  if (c.cmd === 'pick') {
    const win = process.env.GIFKIT_REC_FAKE_KIND === 'window';
    setTimeout(() => emit(win
      ? { ev: 'picked', kind: 'window', scale: 2, contentRect: { x: 0, y: 0, w: 900, h: 600 }, windowID: 99, windowFrame: { x: 200, y: 150, w: 900, h: 600 }, title: '测试窗口', app: '假程序' }
      : { ev: 'picked', kind: 'display', scale: 2, contentRect: { x: 0, y: 0, w: 1440, h: 932 }, displayID: 1, displayFrame: { x: 0, y: 0, w: 1440, h: 932 } }), 300);
  } else if (c.cmd === 'start') {
    rec = { dir: c.dir, t0: Date.now(), timers: [], sent: new Set() };
    copyFileSync(path.join(SRC, 'init.mp4'), path.join(c.dir, 'init.mp4'));
    emit({ ev: 'capturing', width: 1920, height: 1080, fps: 60, scale: 2 });
    emit({ ev: 'writer', bitrate: 18662400, codec: 'h264' });
    emit({ ev: 'segment', type: 'init', file: 'init.mp4', bytes: 697 });
    emit({ ev: 'started', host: 0 });
    man.forEach((s, i) => rec.timers.push(setTimeout(() => sendSeg(i), (s.start + s.dur) * 1000)));
    rec.timers.push(setInterval(() => emit({ ev: 'stats', frames: Math.round(now() * 57.5), dropped: 0, seconds: now() }), 1000));
  } else if (c.cmd === 'mark') {
    emit({ ev: 'mark', t: now(), host: 0 });
  } else if (c.cmd === 'stop') {
    if (!rec) return emit({ ev: 'stopped', frames: 0, seconds: 0 });
    const t = now();
    rec.timers.forEach((x) => { clearTimeout(x); clearInterval(x); });
    man.forEach((s, i) => { if (s.start < t) sendSeg(i); }); // 停的时候把最后一块也写出来
    const secs = Math.min(t, man.at(-1).start + man.at(-1).dur);
    setTimeout(() => { emit({ ev: 'stopped', frames: Math.round(secs * 57.5), dropped: 0, seconds: secs, segments: rec.sent.size, status: 'ok', error: '' }); rec = null; }, 100);
  } else if (c.cmd === 'quit') process.exit(0);
});
