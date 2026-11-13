// 菜单栏素材库：一行一个原素材（分组），挂着各档位的压缩版本；拖进来的文件排队一个个压。
// 只存结果信息（路径、体积、尺寸、时长），不存原素材、不存帧；缩略图只放内存——
// 作者：同类工具「最大痛点是保留了原始素材，导致工具经常内存膨胀，这个我们可以不保存」。
// 版本并存不覆盖；同档多次导出，列表显示最新的，旧的进右键「历史版本」；只有用户主动删除才清理（作者的方案，00:38 前批准）。
import { EventEmitter } from 'node:events';
import { existsSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export const MEDIA_EXT = new Set(['.gif', '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const ACTIVE = new Set(['waiting', 'running']);

/**
 * 文件在外接硬盘上、这块硬盘现在没接（/Volumes/某硬盘 整个不在）：当「暂时不在」，不当删掉（10-20 审查 M2：拔掉硬盘一打开面板，
 * 记录就被去掉、插回来也回不来）。接回来以后照常能用。
 */
export function volumeGone(p, platform = process.platform) {
  const s = String(p || '');
  if (platform === 'win32') {
    // Windows版（11-08）：盘符整个不在（U 盘、移动硬盘拔了、映射的网络盘断了）当「暂时不在」；\\服务器\… 这种不查，免得等网络超时卡住
    const w = /^([A-Za-z]):[\\/]/.exec(s);
    return Boolean(w) && !existsSync(`${w[1]}:\\`);
  }
  const m = /^\/Volumes\/[^/]+/.exec(s);
  return Boolean(m) && !existsSync(m[0]);
}

export class Library extends EventEmitter {
  /**
   * runOne(group, version, { signal, onProgress })：压一个版本，把结果字段写回 version；出错就抛。
   * satisfies(version, presetId)：这个版本的文件是否满足某个档位（体积、帧数、宽度）。
   * presetIds：档位顺序（列表里圆点的顺序）。file：历史记录存哪（JSON）。
   */
  constructor({ runOne, satisfies, presetIds, file }) {
    super();
    this.groups = []; // 新的在前
    this.seq = 0;
    this.current = null; // { group, version, ac }
    this.runOne = runOne;
    this.satisfies = satisfies;
    this.presetIds = presetIds;
    this.file = file;
    this.saveTimer = null;
    this.writeSeq = 0; // 第几次存盘（退出时同步存了以后，比它早的异步存盘不再覆盖）
  }

  // ---------- 查询 ----------
  findGroup(id) {
    return this.groups.find((g) => g.id === id);
  }

  findVersion(id) {
    for (const g of this.groups) {
      const v = g.versions.find((x) => x.id === id);
      if (v) return { group: g, version: v };
    }
    return {};
  }

  /** 某档位「当前」的已完成版本：用户设为当前的 > 这一档最新的 > 别的档里正好也满足这一档的。 */
  doneFor(g, preset) {
    const done = g.versions.filter((v) => v.state === 'done' && v.file && existsSync(v.file));
    const pinned = done.find((v) => v.id === g.pinned?.[preset]);
    if (pinned) return pinned;
    const own = done.filter((v) => v.preset === preset).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (own) return own;
    return done.filter((v) => this.satisfies(v, preset)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  /** 列表里这一档显示哪个：正在压 / 排队 / 刚失败的优先显示状态，否则显示当前版本。 */
  displayFor(g, preset) {
    const latest = g.versions.filter((v) => v.preset === preset && v.state !== 'cancelled').sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest && latest.state !== 'done') {
      // 失败的：这一档自己没有可用版本就显示。别的档的结果正好也满足这一档，也照样显示失败
      // （作者：「没压成功，只弹窗，没有在图片列表标注哪里失败」——原来 4.8 档那份顶上，9.9 档失败就看不出来了）
      const own = this.doneFor(g, preset);
      if (latest.state !== 'failed' || !own || own.preset !== preset) return latest;
    }
    return this.doneFor(g, preset);
  }

  // ---------- 加任务 ----------
  /** 整个文件的那一行（录屏的「段」另算，见 addRange）。 */
  groupFor(source) {
    let g = this.groups.find((x) => x.source === source && !x.range);
    if (g) {
      g.removing = false; // 刚点了移除、还没停下时又拖进来：用户还要它
      this.groups = [g, ...this.groups.filter((x) => x !== g)];
    } else {
      g = { id: ++this.seq, source, name: path.basename(source), versions: [], pinned: {}, createdAt: Date.now() };
      this.groups.unshift(g);
    }
    return g;
  }

  /**
   * 录屏切出来的片段：先进列表、标「待压缩」，不排队（作者批的录屏方案：录制中只切片不压缩，停录后「全部压缩」）。
   * meta：{ session: 这次录屏的编号, durationSec, bytes }。之后要了任何一档版本，就不再算待压缩。
   */
  addPending(source, meta = {}) {
    const g = this.groupFor(source);
    if (!g.versions.length) g.pending = { session: meta.session || null, durationSec: meta.durationSec ?? null, bytes: meta.bytes ?? null, createdAt: Date.now() };
    this.changed();
    return g;
  }

  /**
   * 录屏的一段：同一个录像可以有好几段，每段一行，只记起止（10-18 答复作者的机制：片段共用一份原素材；作者「切片后还支持移动打标位置」）。
   * range：{ n: 第几段, start, end }（秒）；label：列表里显示的名字。先「待压缩」，不排队。
   */
  addRange(source, range, { label, session = null, rec = false, prefix = null } = {}) {
    // 记下录像的大小、修改时间、设备号 + 文件编号：录像改名、挪走以后按编号找回（10-20 审查 B7：原来不记，改名后这几行直接没了）
    let st = null;
    try {
      st = statSync(source);
    } catch {}
    const g = {
      id: ++this.seq, source, name: label || `${path.basename(source)} · 第 ${range.n} 段`, versions: [], pinned: {}, createdAt: Date.now(),
      // set：同一组段的编号（录屏编号，或主界面切的那一组）；rec：录屏的段（在主界面改了要同步回来）；prefix：名字前半截。主界面打标（10-19 深夜）加的
      // join：拼起来的那一行（11.14 多选导出）的几段 [{ start, end }]，这种行不算这一组的段
      range: { n: range.n, start: range.start, end: range.end, ...(range.join ? { join: range.join } : {}), ...(session ? { set: session } : {}), ...(rec ? { rec: true } : {}), ...(prefix ? { prefix } : {}) },
      pending: { session, durationSec: Math.round((range.end - range.start) * 100) / 100, bytes: null, createdAt: Date.now() },
      ...(st ? { sourceSize: st.size, sourceMtime: st.mtimeMs, sourceDev: st.dev, sourceIno: st.ino } : {}),
    };
    this.groups.unshift(g);
    this.changed();
    return g;
  }

  /** 某次录屏还没压的片段（新的在前）。 */
  pendingOf(session) {
    return this.groups.filter((g) => g.pending && g.pending.session === session);
  }

  /**
   * 要一个档位的版本。reuse：已有合格的当前版本、原素材也没变，就直接复用不重压（作者需求「已经生成的合格结果直接复用」）。
   * skipIfSatisfied：轮到它时如果别的版本已经满足这一档，就不编码（双版本模式里 9.9 的结果 ≤4.8MB 时）。
   * 返回 { group, version, reused }。
   */
  request(source, preset, opts = {}) {
    if (!MEDIA_EXT.has(path.extname(source).toLowerCase())) return {};
    return this.requestGroup(this.groupFor(source), preset, opts);
  }

  /** 给某一行要一个档位的版本（录屏的段用它；整个文件用上面的 request）。 */
  requestGroup(g, preset, { mode = 'fast', reuse = true, skipIfSatisfied = false, sourceStat } = {}) {
    g.removing = false;
    g.pending = null; // 待压缩的片段开始压了
    const sameSource = !sourceStat || g.sourceSize === undefined || (g.sourceSize === sourceStat.size && Math.abs(g.sourceMtime - sourceStat.mtimeMs) <= 1);
    if (sourceStat) Object.assign(g, { sourceSize: sourceStat.size, sourceMtime: sourceStat.mtimeMs, sourceDev: sourceStat.dev, sourceIno: sourceStat.ino });
    if (reuse && sameSource) {
      const v = this.doneFor(g, preset);
      if (v) {
        this.changed();
        return { group: g, version: v, reused: true };
      }
    }
    const pending = g.versions.find((v) => v.preset === preset && ACTIVE.has(v.state));
    if (pending) return { group: g, version: pending };
    const v = { id: ++this.seq, preset, mode, state: 'waiting', createdAt: Date.now(), skipIfSatisfied };
    g.versions.push(v);
    this.changed();
    this.pump();
    return { group: g, version: v };
  }

  /** 记一个已经做好的版本（完整界面导出的结果）。成为这一档的当前版本。 */
  addDone(source, fields, groupId) {
    const g = (groupId && this.findGroup(groupId)) || this.groupFor(source);
    g.pending = null;
    const v = { id: ++this.seq, state: 'done', createdAt: Date.now(), finishedAt: Date.now(), ...fields };
    g.versions.push(v);
    if (g.pinned) delete g.pinned[v.preset];
    this.groups = [g, ...this.groups.filter((x) => x !== g)];
    this.changed();
    return { group: g, version: v };
  }

  // ---------- 跑队列 ----------
  async pump() {
    if (this.current) return;
    let next = null;
    for (const g of this.groups) {
      for (const v of g.versions) if (v.state === 'waiting' && (!next || v.createdAt < next.version.createdAt)) next = { group: g, version: v };
    }
    if (!next) {
      this.emit('idle');
      return;
    }
    const { group: g, version: v } = next;
    if (v.skipIfSatisfied && this.doneFor(g, v.preset)) {
      g.versions = g.versions.filter((x) => x !== v); // 已经有满足这一档的版本，不重复编码
      this.changed();
      this.pump();
      return;
    }
    const ac = new AbortController();
    this.current = { group: g, version: v, ac };
    Object.assign(v, { state: 'running', stage: '准备', startedAt: Date.now() });
    this.changed();
    try {
      await this.runOne(g, v, {
        signal: ac.signal,
        onProgress: (p) => {
          Object.assign(v, { stage: p.stage, stageWidth: p.width, stageFps: p.fps });
          this.changed(false);
        },
      });
      if (ac.signal.aborted) v.state = 'cancelled';
      else if (v.state === 'running') v.state = 'done';
    } catch (e) {
      const msg = String(e.message || e);
      Object.assign(v, ac.signal.aborted || msg.includes('已取消') ? { state: 'cancelled' } : { state: 'failed', error: msg, tooLong: Boolean(e.tooLong) });
    } finally {
      v.finishedAt = Date.now();
      v.stage = '';
      if (v.state === 'done' && g.pinned) delete g.pinned[v.preset];
      if (v.state === 'cancelled') g.versions = g.versions.filter((x) => x !== v);
      this.dropIfEmpty(g);
      this.current = null;
      this.emit('finished', g, v);
      this.changed();
      this.pump();
    }
  }

  // ---------- 改 ----------
  /**
   * 素材没有版本了（取消了排队的、删掉了最后一个版本），或者用户要移除、正在压的那个已经停下：这一行就去掉。
   * 10-19 晚查出：原来会留下只有名字、没有版本块的空行；「从列表移除」对正在压的也不生效。
   */
  dropIfEmpty(g) {
    if ((!g.versions.length && !(g.pending && !g.removing)) || (g.removing && !g.versions.some((v) => ACTIVE.has(v.state)))) {
      this.groups = this.groups.filter((x) => x !== g);
    }
  }

  cancel(versionId) {
    const { group: g, version: v } = this.findVersion(versionId);
    if (!v) return;
    if (this.current?.version === v) this.current.ac.abort();
    else if (v.state === 'waiting') {
      g.versions = g.versions.filter((x) => x !== v);
      this.dropIfEmpty(g);
      this.changed();
    }
  }

  setCurrent(versionId) {
    const { group: g, version: v } = this.findVersion(versionId);
    if (!v) return;
    g.pinned = { ...g.pinned, [v.preset]: v.id };
    this.changed();
  }

  /** 从记录里去掉一个版本（文件删不删由调用方决定）。 */
  dropVersion(versionId) {
    const { group: g, version: v } = this.findVersion(versionId);
    if (!v) return;
    if (ACTIVE.has(v.state)) return this.cancel(versionId);
    g.versions = g.versions.filter((x) => x !== v);
    this.dropIfEmpty(g);
    this.changed();
  }

  /** 从列表移除整个素材（只删记录，不删文件）。正在压的先取消，停下以后这一行再去掉。 */
  removeGroup(groupId) {
    const g = this.findGroup(groupId);
    if (!g) return;
    g.removing = true;
    for (const v of [...g.versions]) if (ACTIVE.has(v.state)) this.cancel(v.id);
    this.dropIfEmpty(g);
    this.changed();
  }

  /** 清空列表（只删记录，不删文件）；还在跑的留着。返回清掉的那些（「撤销」用：restore）。 */
  clear() {
    const gone = this.groups.filter((g) => !g.versions.some((v) => ACTIVE.has(v.state)));
    this.groups = this.groups.filter((g) => g.versions.some((v) => ACTIVE.has(v.state)));
    this.changed();
    return gone;
  }

  /**
   * 撤销清空 / 移除：把这些行放回来（已经在列表里的不重复放），接在现有的后面（作者：清空列表可以撤销）。
   * 撤销前又把同一个文件拖了进来（整个文件那一行已经有了）：不另起一行，旧行的结果并进现在这一行（10-20 审查 M6）。
   */
  restore(groups) {
    const have = new Set(this.groups.map((g) => g.id));
    const back = [];
    for (const g of groups) {
      if (have.has(g.id)) continue;
      const now = !g.range && this.groups.find((x) => x.source === g.source && !x.range);
      if (now) {
        const files = new Set(now.versions.map((v) => v.file).filter(Boolean));
        now.versions.push(...g.versions.filter((v) => v.state === 'done' && !files.has(v.file)));
        now.pending = now.versions.length ? null : now.pending;
        continue;
      }
      back.push({ ...g, removing: false });
    }
    this.groups = [...this.groups, ...back];
    this.changed();
    return back.length;
  }

  /** 一次移除好几行（只删记录，不删文件）。返回移除的那些（撤销用）。 */
  removeGroups(ids) {
    const gone = this.groups.filter((g) => ids.includes(g.id) && !g.versions.some((v) => ACTIVE.has(v.state)));
    for (const id of ids) this.removeGroup(id);
    return gone;
  }

  /**
   * 重查列表里的文件（面板打开、点 / 拖之前、启动后；作者：本地文件移动 / 删除 / 改名，图片列表怎么办）。
   * 结果文件不在了：先按设备号 + 编号找新位置（同一块硬盘上改名、挪到别的文件夹都能找回），找到就把路径改过来；
   * 找不到、或者在废纸篓里，当删掉：这个版本去掉，整行没结果了整行去掉（不用等重启）。
   * 原素材不在了：也先找，找到就改路径；找不到不动（编辑时用结果）；录屏待压缩的段（只有录像、没有结果）录像不在了，整行去掉。
   * locate(ids) → Map(「设备号:编号」→ 现在的路径，找不到没有这一项)；isTrash(路径) → 在不在废纸篓里。返回有没有变。
   */
  async reconcile(locate, { isTrash = () => false } = {}) {
    const lost = [];
    for (const g of this.groups) {
      // 外接硬盘没接的不算丢（10-20 审查 M2）
      for (const v of g.versions) if (v.state === 'done' && v.file && !existsSync(v.file) && !volumeGone(v.file)) lost.push({ g, v, id: v.ino ? `${v.dev}:${v.ino}` : null });
      if (g.source && !existsSync(g.source) && !volumeGone(g.source)) lost.push({ g, src: true, id: g.sourceIno ? `${g.sourceDev}:${g.sourceIno}` : null });
    }
    if (!lost.length) return false;
    const ids = [...new Set(lost.map((x) => x.id).filter(Boolean))];
    let found = new Map();
    if (ids.length) {
      try {
        found = await locate(ids);
      } catch (e) {
        // 找路径超时、出错：这次先都不动，下次再查（10-20 审查 B4：原来当作都没找到，文件其实还在也被去掉了）。
        // 10-20 凌晨踩过：调用写错被这里吞掉；现在吞掉的后果是「不动」，不会再误删记录，但要看日志
        console.error('按编号找文件出错（这次先不动）：', e.message);
        return false;
      }
    }
    let changed = false;
    for (const x of lost) {
      const p = x.id ? found.get(x.id) : null;
      const ok = Boolean(p) && !isTrash(p) && existsSync(p);
      if (x.src) {
        if (ok) x.g.source = p;
        else if ((x.g.pending && !x.g.versions.length) || (x.g.versions.length && x.g.versions.every((y) => y.state === 'failed'))) this.groups = this.groups.filter((y) => y !== x.g);
        else continue;
        changed = true;
        continue;
      }
      if (ok) x.v.file = p;
      else {
        x.g.versions = x.g.versions.filter((y) => y !== x.v);
        for (const k of Object.keys(x.g.pinned || {})) if (x.g.pinned[k] === x.v.id) delete x.g.pinned[k];
        this.dropIfEmpty(x.g);
      }
      changed = true;
    }
    if (changed) this.changed();
    return changed;
  }

  // ---------- 给界面 ----------
  /** 每个素材：版本小块（同一个文件满足两档就合成一块、两个圆点）和各档的历史版本数。 */
  list() {
    return this.groups.map((g) => {
      const chips = [];
      for (const p of this.presetIds) {
        const v = this.displayFor(g, p);
        if (!v) continue;
        const same = chips.find((c) => c.versionId === v.id || (v.state === 'done' && c.state === 'done' && c.file === v.file));
        if (same) {
          if (!same.dots.includes(p)) same.dots.push(p);
          continue;
        }
        chips.push({
          versionId: v.id, dots: [p], state: v.state, file: v.file || null, bytes: v.bytes || null, isSource: Boolean(v.isSource),
          stage: v.stage || '', startedAt: v.startedAt || null, error: v.error ? friendlyError(v.error) : '', tooLong: Boolean(v.tooLong), width: v.width, height: v.height, durationSec: v.durationSec,
          fits: v.state === 'done' ? this.satisfies(v, p) : null,
        });
      }
      if (!chips.length) {
        // 结果都在没接的外接硬盘上：灰的一块「硬盘没接」，接上就恢复（10-20 审查 M2）
        const off = g.versions.filter((v) => v.state === 'done' && v.file && volumeGone(v.file)).sort((a, b) => b.createdAt - a.createdAt);
        if (off.length) {
          const dots = this.presetIds.filter((p) => off.some((v) => v.preset === p));
          chips.push({
            versionId: off[0].id, dots, state: 'offline', file: null, bytes: off[0].bytes || null, isSource: Boolean(off[0].isSource),
            stage: '', startedAt: null, error: '', tooLong: false, width: off[0].width, height: off[0].height, durationSec: off[0].durationSec, fits: null,
            volume: /^\/Volumes\/([^/]+)/.exec(off[0].file)?.[1] || '',
          });
        }
      }
      if (!chips.length && g.pending) {
        chips.push({
          versionId: `p${g.id}`, dots: [], state: 'pending', file: existsSync(g.source) ? g.source : null, bytes: g.pending.bytes, isSource: true,
          stage: '', startedAt: null, error: '', tooLong: false, durationSec: g.pending.durationSec, fits: null,
        });
      }
      const history = {};
      for (const p of this.presetIds) {
        const shown = chips.filter((c) => c.dots.includes(p)).map((c) => c.versionId);
        history[p] = g.versions.filter((v) => v.preset === p && v.state === 'done' && !shown.includes(v.id) && v.file && existsSync(v.file)).length;
      }
      return { id: g.id, name: g.name, source: g.source, chips, history, pending: g.pending ? g.pending.session : null, range: g.range || null };
    });
  }

  /** 某档位的历史版本（不含当前显示的），新的在前。 */
  historyOf(groupId, preset) {
    const g = this.findGroup(groupId);
    if (!g) return [];
    const cur = this.doneFor(g, preset);
    return g.versions
      .filter((v) => v.preset === preset && v.state === 'done' && v !== cur && v.file && existsSync(v.file))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---------- 存盘 ----------
  changed(save = true) {
    this.emit('change');
    if (save && this.file) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.save(), 500);
    }
  }

  /**
   * 退出时马上存（10-20 审查 M3：平时停 0.5 秒才存，退出前那一下的改动会丢）。同步写，不用拦下退出
   * （拦下退出会让这一次系统关机、注销被取消）。还没写完的异步存盘，之后不再覆盖它。
   */
  flushSync() {
    if (!this.file || (!this.saveTimer && !this.pendingSaves)) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.syncWrote = ++this.writeSeq;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.quit.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot()));
      renameSync(tmp, this.file);
    } catch (e) {
      console.error('退出前存盘失败：', e.message);
    }
  }

  /**
   * 存盘排队：前一次没写完不会和下一次抢同一个临时文件（10-20 实测撞过：rename ENOENT），出错只记日志、不抛（不弹报错框）。
   */
  save() {
    this.saving = (this.saving || Promise.resolve()).then(() => this.saveNow()).catch((e) => console.error('列表存盘失败：', e.message));
    return this.saving;
  }

  /** 只存已完成版本的结果信息（含设备号和文件编号，改名、挪走后找回用）和没做成的档位、原因；不存原素材、不存缩略图。 */
  snapshot() {
    const keep = ['id', 'preset', 'mode', 'file', 'bytes', 'width', 'height', 'frames', 'durationSec', 'createdAt', 'finishedAt', 'action', 'isSource', 'edit', 'dev', 'ino'];
    const keepFailed = ['id', 'preset', 'mode', 'state', 'error', 'tooLong', 'createdAt', 'finishedAt']; // 没做成的也存（10-22 试用反馈：只有失败结果的行，原来重启后整行没了）
    const data = {
      version: 1,
      seq: this.seq,
      groups: this.groups.map((g) => ({
        id: g.id, source: g.source, name: g.name, sourceSize: g.sourceSize, sourceMtime: g.sourceMtime, sourceDev: g.sourceDev, sourceIno: g.sourceIno, createdAt: g.createdAt, pinned: g.pinned, edit: g.edit,
        pending: g.pending || undefined,
        range: g.range || undefined,
        versions: g.versions.filter((v) => v.state === 'done' || v.state === 'failed').map((v) => Object.fromEntries((v.state === 'failed' ? keepFailed : keep).filter((k) => v[k] !== undefined).map((k) => [k, v[k]]))),
      })).filter((g) => g.versions.length || g.pending),
    };
    return data;
  }

  async saveNow() {
    const mine = ++this.writeSeq;
    const data = this.snapshot();
    this.pendingSaves = (this.pendingSaves || 0) + 1;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      if ((this.syncWrote || 0) > mine) return; // 退出前已经同步存了更新的
      await rename(tmp, this.file);
    } finally {
      this.pendingSaves--;
    }
  }

  /** 读历史：结果文件已经不在的版本去掉，没有版本的素材去掉。 */
  async load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.seq = data.seq || 0;
      this.groups = (data.groups || [])
        // 文件不在、但记了编号的先留着（启动后重查时按编号找回）；外接硬盘没接的也留着（10-20 审查 M2）
        .map((g) => {
          const srcThere = Boolean(g.source) && (existsSync(g.source) || g.sourceIno || volumeGone(g.source));
          const versions = (g.versions || []).filter((v) => (v.state === 'failed' ? srcThere : v.file && (existsSync(v.file) || v.ino || volumeGone(v.file))));
          return { ...g, pinned: g.pinned || {}, versions: versions.map((v) => ({ ...v, state: v.state === 'failed' ? 'failed' : 'done' })) };
        })
        // 录屏待压缩的段：录像改了名（记了编号）、在没接的硬盘上，也先留着（10-20 审查 B7）
        .map((g) => ({ ...g, pending: g.pending && !g.versions.some((v) => v.state === 'done') && (existsSync(g.source) || g.sourceIno || volumeGone(g.source)) ? g.pending : null }))
        .filter((g) => g.versions.length || g.pending);
      for (const g of this.groups) for (const v of [g, ...g.versions]) this.seq = Math.max(this.seq, v.id);
    } catch {
      // 历史文件坏了就当没有，不影响使用
      this.groups = [];
    }
  }
}

/**
 * 没做成的原因写成人话（10-22 试用反馈：通知里原来是程序内部报错的英文原文）。引擎自己的报错都是中文，照用；
 * 系统报错按代码翻成一句；别的英文当程序出错，原文照样记进操作日志。
 */
export function friendlyError(msg) {
  const m = String(msg || '');
  if (/[\u4e00-\u9fff]/.test(m)) return m;
  if (/ENOSPC/.test(m)) return '磁盘满了';
  if (/EACCES|EPERM/.test(m)) return '没有权限读写这个文件夹';
  if (/ENOENT/.test(m)) return '文件找不到了（可能被挪走或删了）';
  return '程序出错了，已记进日志';
}
