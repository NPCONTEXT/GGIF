// 清以前没删掉的临时目录（10-31 负载优化，日常更新维护 11.11）。主进程启动 5 秒后调；单独一个文件，单元测试不用起 Electron。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 清以前没删掉的临时目录（10-31 负载优化：退出时没删完、或者压到一半被强退留下的，原始帧一份几百 MB）。只动 GGIF 自己起名的：
 * 主程序的缓存 gifkit-app-*（里面 owner.pid 记的进程还活着就不动；没有这个文件的是 0.5.0 以前的，超过 1 小时才删），
 * 引擎压缩时的工作目录 gifkit-q- / gifkit-m- / gifkit-re- / gifkit-score- / gifkit-XXXXXX（超过 6 小时才删，正在压的不会这么久）。
 * 录屏的分块 gifkit-rec-* 不动（异常退出时那是录像的唯一一份）。
 */
export function staleTempDirs(dir, { now = Date.now(), alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } } } = {}) {
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const age = now - st.mtimeMs;
    if (/^gifkit-app-[A-Za-z0-9]{6}$/.test(n)) {
      let pid = null;
      try {
        pid = Number(readFileSync(path.join(p, 'owner.pid'), 'utf8')) || null;
      } catch {}
      if (pid ? !alive(pid) : age > 3600e3) out.push(p);
    } else if (/^gifkit-(q-|m-|re-|score-)?[A-Za-z0-9]{6}$/.test(n) && age > 6 * 3600e3) out.push(p);
  }
  return out;
}
