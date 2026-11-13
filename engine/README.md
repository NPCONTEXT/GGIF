# gifkit 引擎（GIF 工具的核心，不带界面）

把视频 / GIF 做成符合公众号要求的 GIF。界面（Electron）以后直接调这里的函数；命令行给自动测试和 Windows 上不带界面的测试用。规则和数字的来源：`GIF工具/方案.md` 顶部「10-17 定下的事」、`GIF工具/技术评估报告.md`。

## 用法

```
node src/cli.js tools                                   # 检查外部程序
node src/cli.js convert <视频> [-o 输出.gif] [--preset upload|paste] [--start 秒 --dur 秒] [--width N --fps N] [--fine] [--smooth]
node src/cli.js batch <文件或目录…> -o <输出目录> [--preset …]
node src/cli.js check <GIF> [--preset …]
node src/cli.js fill <输入.gif> <输出.gif>
node src/cli.js estimate <视频> --width N --fps N
```

测试：`node --test test/unit.test.js`（几秒）；`GIFKIT_SLOW=1 node --test 'test/*.test.js'`（真编码，几分钟）。

几段拼成一张（11-06 多选导出）：`convertFile(视频, 输出, { ranges: [{ start, dur }, …] })`，两段以上按给的顺序拼（时长是几段之和，`start`、`dur` 不看）；每段先各自按自己的起点抽帧、时间归零再接，拼出来的帧 = 各段单独取的帧首尾接上，同一条 ffmpeg 里做完、不写中间视频（`src/frames.js` sourceChain，测试 `test/join.test.js`）。命令行没加这个参数。

## 流程

```
读入 → 读色彩标记（Display P3 → 转 sRGB；bt709 不动；没标记按 sRGB 并提示）
 → 取帧（原片按 n/f 时刻正在显示的那帧，lanczos 缩放）
 → 按档位从高往低试：默认 900×10、900×8、800×10 …（宽度优先）；--smooth 帧率优先
     每档：总帧数 ≤300 才试 → 快速预估（仿 Gifox × 0.94）；预估是上限的 2.8 倍以上直接跳过 → lessgif 在上限内找最高画质（--fine 再试 gifski+gifsicle）
     → 端到端画质分（参照原片，同样转色）过最低线（SSIM ≥0.90 且 VMAF ≥90，10-17 盲选标定；先算 SSIM，过了才算 VMAF）就采用
     每档都不过线：按体积比例给「剪到约几秒能保住某个宽度」的建议
 → 总帧数 ≤60 就凑到 61（补 1×1 透明小帧）→ 合规检查（体积、帧数、宽、完整解码）→ 写出（不覆盖已有文件）
```

批量：合规的原样复制；只是帧数不够的只凑帧；超标的 GIF 在「原宽（≤1080）/ 900 / 700」里试「解码后 lessgif」和「gifsicle 直接压」，按以输入为参照的画质分取高；视频走 convert。

## 外部程序

ffmpeg / ffprobe / gifsicle（PATH 里找，含 /opt/homebrew/bin）、gifski（开发时用 `GIF工具/工具.nosync/` 里的官方包）、lessgif v0.1.0 WASM（`GIF工具/第三方.nosync/`，用 `node --permission` 起子进程跑，只能读 wasm 和帧文件、只能写输出目录）。都可以用环境变量改位置：`GIFKIT_FFMPEG`、`GIFKIT_FFPROBE`、`GIFKIT_GIFSICLE`、`GIFKIT_GIFSKI`、`GIFKIT_LESSGIF_WASM`。

## 已知限制

- 输入 GIF 带透明的（贴纸类）没测；lessgif 处理透明的行为没看。
- 画质最低线、预估比率都是 6 段游戏素材上定的。
- 「仿 Gifox → lessgif」预估只回测了最高画质那档。
