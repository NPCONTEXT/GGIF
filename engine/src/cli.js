#!/usr/bin/env node
// 命令行入口。界面（Electron）以后直接调同一套函数；命令行主要给自动测试和 Windows 上不带界面的测试用。
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, missingTools, RM_RETRY } from './tools.js';
import { PRESETS, DEFAULT_PRESET } from './presets.js';
import { convertFile, resolvePreset, safeOutputPath, outputBase } from './convert.js';
import { batch } from './batch.js';
import { checkGif, fmtBytes } from './check.js';
import { fillFrames } from './fill.js';
import { probe, colorPlan } from './probe.js';
import { extractFrames } from './frames.js';
import { estimateLessgif } from './estimate.js';

const HELP = `gifkit：把视频 / GIF 做成符合公众号要求的 GIF

  gifkit convert <视频> [-o 输出.gif] [选项]     单个视频转 GIF（自动选档）
  gifkit batch <文件或目录…> -o <输出目录> [选项]  批量：合规的原样保留，帧数不够的凑帧，超标的压缩，视频转换
  gifkit check <GIF> [--preset …]                 合规检查
  gifkit fill <输入.gif> <输出.gif> [--target 61]  凑帧
  gifkit estimate <视频> --width N --fps N         快速预估 lessgif 最高画质的体积
  gifkit tools                                     检查需要的外部程序

选项：
  --preset upload|paste   公众号预设：upload = 图片库上传 9.9MB（默认）；paste = 飞书粘贴 4.8MB
  --width N --fps N       指定宽度 / 每秒帧数（不给就自动按档位试）
  --start 秒 --dur 秒      截取片段
  --crop 宽:高:x:y        裁画面
  --smooth                流畅优先（先保帧率再降宽；默认清晰优先）
  --fine                  精细模式：再试 gifski，按画质分取高（更慢）
  --no-fill               不凑帧
  --no-floor              不管画质最低线（只管装得下）
  --allow-below-floor     每档都没过最低线时，用画质最高的那档
  --color auto|none|p3    色彩：自动（默认，Display P3 自动转 sRGB）/ 不转 / 按 P3 转
  --json                  输出 JSON
`;

function parseArgs(argv) {
  const pos = [];
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 后面缺值`);
      return argv[++i];
    };
    if (a === '-o' || a === '--out') o.out = next();
    else if (a === '--preset') o.preset = next();
    else if (a === '--width') o.width = Number(next());
    else if (a === '--fps') o.fps = Number(next());
    else if (a === '--start') o.start = Number(next());
    else if (a === '--dur') o.dur = Number(next());
    else if (a === '--target') o.target = Number(next());
    else if (a === '--color') o.color = next();
    else if (a === '--crop') {
      const [w, h, x, y] = next().split(':').map(Number);
      o.crop = { w, h, x: x || 0, y: y || 0 };
    } else if (a === '--smooth') o.prefer = 'smooth';
    else if (a === '--fine') o.fine = true;
    else if (a === '--no-fill') o.fill = false;
    else if (a === '--no-floor') o.floor = false;
    else if (a === '--allow-below-floor') o.allowBelowFloor = true;
    else if (a === '--json') o.json = true;
    else if (a === '--keep-work') o.keepWork = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error(`不认识的选项：${a}`);
    else pos.push(a);
  }
  if (o.color === 'auto') delete o.color;
  return { pos, o };
}

const progress = (o) => (p) => {
  if (!o.json) process.stderr.write(`  · ${p.stage}${p.width ? ` ${p.width}×${p.fps ?? ''}` : ''}${p.estimate ? `（预估 ${(p.estimate / 1e6).toFixed(2)}MB）` : ''}\n`);
};

function printConvert(r) {
  if (!r.ok && !r.output) {
    console.log(`没做成：${r.reason}`);
  } else {
    const c = r.chosen;
    console.log(`输出：${r.output}`);
    console.log(`档位：${c.width} 宽，每秒 ${c.fps} 帧，${c.frames} 帧；编码 ${c.encoder}（q=${c.q}）；${fmtBytes(c.bytes)}`);
    console.log(`画质：SSIM ${c.ssim}，VMAF ${c.vmaf}（${c.pass ? '过了最低线' : '没过最低线'}）`);
    if (r.fill) console.log(`凑帧：${r.fill.ok ? `${r.fill.before} → ${r.fill.after} 帧` : `没凑成（${r.fill.reason}）`}`);
    console.log(`合规：${r.check.ok ? '通过' : r.check.problems.join('；')}`);
    if (r.hint) console.log(`上传：${r.hint}`);
  }
  console.log(`色彩：${r.color.note}`);
  if (r.tried?.length) {
    console.log('试过的档：');
    for (const t of r.tried) console.log(`  ${t.width}×${t.fps}：${t.result}${t.bytes ? `（${(t.bytes / 1e6).toFixed(2)}MB，SSIM ${t.ssim}，VMAF ${t.vmaf}）` : ''}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, o } = parseArgs(rest);
  if (!cmd || o.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'tools') {
    const miss = missingTools(['ffmpeg', 'ffprobe', 'gifsicle', 'gifski', 'lessgifWasm']);
    for (const [k, v] of Object.entries(TOOLS)) console.log(`${k.padEnd(12)} ${v || '（没找到）'}${v && !existsSync(v) ? '（不存在）' : ''}`);
    console.log(miss.length ? `缺：${miss.join('、')}` : '都在');
    return miss.length ? 1 : 0;
  }
  const miss = missingTools();
  if (miss.length) throw new Error(`缺外部程序：${miss.join('、')}（运行 gifkit tools 看详情）`);
  const preset = resolvePreset(o.preset);

  if (cmd === 'convert') {
    if (pos.length !== 1) throw new Error('用法：gifkit convert <视频> [-o 输出.gif]');
    const input = pos[0];
    const out = o.out || path.join(path.dirname(input), `${outputBase(input)}_压缩.gif`);
    const r = await convertFile(input, out, { ...o, preset, onProgress: progress(o) });
    if (o.json) console.log(JSON.stringify(r, null, 1));
    else printConvert(r);
    return r.ok ? 0 : 2;
  }
  if (cmd === 'batch') {
    if (!pos.length || !o.out) throw new Error('用法：gifkit batch <文件或目录…> -o <输出目录>');
    const r = await batch(pos, o.out, {
      ...o, preset, onProgress: progress(o),
      onItem: (it) => { if (!o.json) process.stderr.write(`${it.ok ? '✓' : '✗'} ${path.basename(it.input)}：${it.action}，${it.detail}\n`); },
    });
    if (o.json) console.log(JSON.stringify(r, null, 1));
    else {
      console.log(r.summary);
      console.log(`上传：${r.hint}`);
    }
    return r.items.every((x) => x.ok) ? 0 : 2;
  }
  if (cmd === 'check') {
    if (pos.length !== 1) throw new Error('用法：gifkit check <GIF>');
    const r = await checkGif(pos[0], preset);
    if (o.json) console.log(JSON.stringify(r, null, 1));
    else {
      const s = r.summary;
      console.log(`${s.width}×${s.height}，${s.frames} 帧，${s.durationSec.toFixed(2)} 秒，${fmtBytes(s.bytes)}`);
      console.log(r.ok ? `符合「${preset.name}」` : `不符合「${preset.name}」：${r.problems.join('；')}`);
      if (r.needsFill) console.log(`总帧数不到 ${preset.minFrames}：读者会看到微信缩成 640 宽的版本，建议凑帧（gifkit fill）`);
    }
    return r.ok ? 0 : 2;
  }
  if (cmd === 'fill') {
    if (pos.length !== 2) throw new Error('用法：gifkit fill <输入.gif> <输出.gif>');
    if (path.resolve(pos[0]) === path.resolve(pos[1])) throw new Error('输出不能覆盖输入文件');
    const r = fillFrames(await readFile(pos[0]), o.target || preset.minFrames);
    const out = safeOutputPath(pos[1]);
    if (r.ok) await writeFile(out, r.buffer);
    console.log(r.ok ? `${r.before} → ${r.after} 帧（${r.reason}），写到 ${out}` : `没凑成：${r.reason}`);
    return r.ok ? 0 : 2;
  }
  if (cmd === 'estimate') {
    if (pos.length !== 1 || !o.width || !o.fps) throw new Error('用法：gifkit estimate <视频> --width N --fps N');
    const info = await probe(pos[0]);
    const color = colorPlan(info, o.color);
    const work = await mkdtemp(path.join(os.tmpdir(), 'gifkit-est-'));
    try {
      const frames = await extractFrames({ file: pos[0], info, color, start: o.start, dur: o.dur, width: o.width, fps: o.fps, crop: o.crop, dir: work });
      const e = await estimateLessgif(frames, { limit: preset.limit });
      if (o.json) console.log(JSON.stringify({ frames: frames.n, ...e }, null, 1));
      else {
        console.log(`${frames.w}×${frames.h}，${frames.n} 帧；lessgif 最高画质约 ${(e.estimate / 1e6).toFixed(2)}MB（${(e.range[0] / 1e6).toFixed(2)}–${(e.range[1] / 1e6).toFixed(2)}），${e.ratioSource}`);
        console.log(e.fits ? `能装进「${preset.name}」` : `装不进「${preset.name}」的最高画质，要降画质或降档`);
      }
    } finally {
      await rm(work, { recursive: true, force: true, ...RM_RETRY });
    }
    return 0;
  }
  throw new Error(`不认识的命令：${cmd}（gifkit help 看用法）`);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`出错：${e.message || e}`);
    process.exit(1);
  },
);
