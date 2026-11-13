// 操作日志（10-22 设置卷第二批；作者批准「就按这份记」，测试期间默认开）：出问题时 Claude 在本机读，不联网、不上传。
// 一天一个文件「GGIF-2026-10-22.log」，只留最近 7 天，单个文件超过 5MB 就不再往里写；一行一条：时刻 [类别] 事件 {字段}。
// 脱敏：不记文件名、路径、剪贴板内容。碰到过的路径、文件名都记下来，写的时候换掉；别的像路径的整段换成「<路径>」，
// 带扩展名的文件名换成「<文件>」，用户名换成「<用户>」。
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEEP_DAYS = 7;
export const MAX_BYTES = 5e6;
const USER = (() => {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
})();
const HOME = os.homedir();
const MEDIA = 'gif|mp4|mov|m4v|webm|mkv|avi|png|jpe?g|webp|heic|log|json';
const FILE_RE = new RegExp(`[^\\s/"'“”「」：:，,；;（）()<>]+\\.(?:${MEDIA})\\b`, 'gi');
const PATH_RE = /(?:~|\/(?:Users|Volumes|private|tmp|var|Applications|opt|System|Library))\/[^\s"'“”「」，,；;（）()<>]*/g;
const known = new Map(); // 碰到过的路径 / 文件名 → 换成什么

/** 记下这些路径（连同它所在的文件夹、带扩展名的文件名），之后写日志时换掉 */
export function remember(...paths) {
  for (const p of paths) {
    if (typeof p !== 'string' || p.length < 3) continue;
    known.set(p, '<路径>');
    const dir = path.dirname(p);
    if (dir.length > 1) known.set(dir, '<路径>');
    const base = path.basename(p);
    if (/\.[a-z0-9]{2,5}$/i.test(base) && base.length > 2) known.set(base, '<文件>');
  }
  while (known.size > 800) known.delete(known.keys().next().value); // 最早记的先丢
}

/** 去掉路径、文件名、用户名 */
export function scrub(v) {
  if (typeof v !== 'string') return v;
  let s = v;
  for (const [k, to] of [...known].sort((a, b) => b[0].length - a[0].length)) if (s.includes(k)) s = s.split(k).join(to);
  if (HOME.length > 1) s = s.split(HOME).join('~');
  s = s.replace(PATH_RE, '<路径>').replace(FILE_RE, '<文件>');
  if (USER.length > 1) s = s.split(USER).join('<用户>');
  return s;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hms = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

export class OpLog {
  /** dir：日志文件夹（数据文件夹里的 logs）；enabled：设置里开没开；now：测试时换成假的时钟 */
  constructor({ dir, enabled = true, now = () => new Date() }) {
    Object.assign(this, { dir, enabled, now });
    this.full = new Set(); // 今天写满 5MB 的文件
  }

  fileFor(d = this.now()) {
    return path.join(this.dir, `GGIF-${ymd(d)}.log`);
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
  }

  /** 记一条：类别、事件、字段（字段里的字符串都脱敏；值是 undefined 的不写） */
  log(cat, event = '', fields = null) {
    if (!this.enabled || !this.dir) return;
    try {
      const d = this.now();
      const f = this.fileFor(d);
      if (this.full.has(f)) return;
      mkdirSync(this.dir, { recursive: true });
      let size = 0;
      try {
        size = statSync(f).size;
      } catch {}
      if (size > MAX_BYTES) {
        appendFileSync(f, `${hms(d)} [日志] 今天的超过 5MB，后面的不记了\n`);
        this.full.add(f);
        return;
      }
      const body = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields, (_k, v) => scrub(v))}` : '';
      appendFileSync(f, `${hms(d)} [${cat}]${event ? ` ${scrub(event)}` : ''}${body}\n`);
    } catch {} // 日志写不了不影响干活
  }

  /** 只留最近 7 天（今天算第 1 天）；只删自己那种名字的文件 */
  prune() {
    try {
      const cut = ymd(new Date(this.now().getTime() - (KEEP_DAYS - 1) * 864e5));
      for (const n of readdirSync(this.dir)) {
        const m = n.match(/^GGIF-(\d{4}-\d{2}-\d{2})\.log$/);
        if (m && m[1] < cut) rmSync(path.join(this.dir, n), { force: true });
      }
    } catch {}
  }
}
