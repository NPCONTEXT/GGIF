// 用 lessgif 的 WASM 编码一段 RGBA 原始帧（从 GIF工具/脚本/lessgif编码.mjs 搬来，逻辑不变）。
// 只用它的 C 接口（gz_*），不加载它自带的 JS；WASM 实例化时不给任何外部接口。
// 由 encoders/index.js 用「node --permission」起子进程跑：只能读 wasm、原始帧和本脚本，只能写输出目录。
//
// 参数：<lessgif.wasm> <帧.rgba> <宽> <高> <帧数> <帧率> <quality 0-100> <输出.gif> [抖动 0-1，默认 0.5] [颜色数，默认 255]
// 输出一行 JSON：{bytes, frames, ms}
import { readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';

const [wasmPath, rawPath, W, H, N, FPS, Q, outPath, D, C] = process.argv.slice(2);
const w = Number(W);
const h = Number(H);
const n = Number(N);
const fps = Number(FPS);
const quality = Number(Q);
const dither = D === undefined ? 0.5 : Number(D);
const colors = C === undefined ? 255 : Number(C); // 手动参数「颜色数」；lessgif 上限 255

const mod = new WebAssembly.Module(readFileSync(wasmPath));
if (WebAssembly.Module.imports(mod).length) {
  throw new Error('lessgif.wasm 要求外部接口，和审查时不一致：' + JSON.stringify(WebAssembly.Module.imports(mod)));
}
const x = new WebAssembly.Instance(mod, {}).exports;

const fsz = w * h * 4;
const fd = openSync(rawPath, 'r');
const frame = Buffer.alloc(fsz);
const getFrame = (i) => {
  readSync(fd, frame, 0, fsz, i * fsz);
  return frame;
};
const cs = (i) => Math.round((i * 100) / fps);
const delays = Array.from({ length: n }, (_, i) => cs(i + 1) - cs(i));
const bytes = () => new Uint8Array(x.memory.buffer);
const str = (p, l) => new TextDecoder().decode(bytes().slice(p, p + l));
const check = (s, r, what) => {
  if (r < 0) throw new Error(`${what}: ${str(x.gz_err_ptr(s), x.gz_err_len(s))}`);
  return r;
};

const t0 = performance.now();
const s = x.gz_new_quality(quality, colors, dither);
const buf = x.gz_alloc(fsz);
x.gz_set_loop(s, 0);
for (let i = 0; i < n; i++) {
  bytes().set(getFrame(i), buf);
  check(s, x.gz_pal_add(s, buf, w, h), 'palette');
}
check(s, x.gz_pal_build(s), 'palette');
check(s, x.gz_enc_new(s, w, h), 'encoder');
for (let i = 0; i < n; i++) {
  bytes().set(getFrame(i), buf);
  check(s, x.gz_enc_push(s, buf, delays[i]), `frame ${i}`);
}
const len = check(s, x.gz_enc_finish(s), 'finish');
const ptr = x.gz_out_ptr(s);
writeFileSync(outPath, bytes().slice(ptr, ptr + len));
closeSync(fd);
console.log(JSON.stringify({ bytes: len, frames: x.gz_frames_written(s), ms: Math.round(performance.now() - t0) }));
