# 第三方声明

GGIF 自己的代码（本仓库里的 `app/`、`engine/`）按 MIT 许可发布，见 [LICENSE](LICENSE)。

GGIF 的安装包里另外带了下面这些别人写的程序。GGIF 是把它们当作独立的程序来启动、用命令行参数和文件跟它们打交道，没有把它们的代码编进自己的程序里；它们各自按自己的许可证发布，许可证原文都在安装包的 `engine/vendor/licenses/` 目录里。

| 程序 | 版本 | 许可证 | 哪个安装包带 | 源码 |
|---|---|---|---|---|
| ffmpeg、ffprobe | Mac：9.0.1，自己从官方源码编（带 x264）；Windows：BtbN 编好的 n9.0.2 win64-gpl | GPL（Mac 这份整体按 GPL-2.0-or-later；Windows 这份的许可证以包里的 `ffmpeg-LICENSE.txt` 为准） | Mac、Windows | Mac：https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz ；Windows：https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-11-07-12-47 （构建脚本在同一个仓库） |
| x264 | r3222（编进 Mac 的 ffmpeg） | GPL-2.0-or-later | Mac | https://code.videolan.org/videolan/x264.git ，stable 分支，提交 b35605ace3ddf7c1a5d67a2eb553f034aef41d55 |
| libvmaf | 3.2.1（编进 Mac 的 ffmpeg） | BSD-2-Clause-Patent | Mac | https://github.com/Netflix/vmaf/archive/refs/tags/v3.2.1.tar.gz |
| dav1d | 1.5.4（编进 Mac 的 ffmpeg） | BSD-2-Clause | Mac | https://code.videolan.org/videolan/dav1d/-/archive/1.5.4/dav1d-1.5.4.tar.bz2 |
| gifsicle | 1.97（Mac 用 clang 编，Windows 用 MSVC 编，同一份源码） | GPL-2.0-only | Mac、Windows | https://www.lcdf.org/gifsicle/gifsicle-1.97.tar.gz |
| gifski | 1.34.0，官方发行的程序，没改过 | AGPL-3.0-or-later | Mac、Windows | https://github.com/ImageOptim/gifski ，标签 1.34.0 |
| lessgif | 0.1.0，官方发行的 wasm，没改过 | MIT 或 Apache-2.0 | Mac、Windows | https://github.com/moonjuho11/lessgif |
| Electron | 44.9.0 | MIT（另带 Chromium 等的许可清单） | Mac、Windows | https://github.com/electron/electron |

## 对应的源码在哪拿

- Mac 安装包里的 ffmpeg、ffprobe、gifsicle 是用 `app/scripts/build-encoders.mjs` 从上表的官方源码编出来的，没有改源码。用到的源码压缩包原样放在本仓库发布页的「第三方源码」压缩包里，里面还有一份「源码与编译参数.txt」，写着每个源码包的校验值和编译参数。
- Windows 安装包里的 gifsicle 用的是同一份 1.97 源码，只在编好的程序里嵌了一份让它按 UTF-8 读中文路径的清单，做法写在 `.github/workflows/win-vendor.yml` 里。
- gifski、lessgif、Windows 的 ffmpeg 用的是各自官方发行的程序，没有改过，对应的源码在上表的地址，按版本号或标签取。
- 拿不到、或者发现哪里对不上，请在本仓库提 issue。

## 说明

- gifski 的许可证全文在本仓库的 [third_party/gifski-LICENSE](third_party/gifski-LICENSE)（它 1.34.0 发行包里的 LICENSE 原样），打包时会放进安装包。
- GGIF 的标志（图标）不随 MIT 许可授权；介绍、链接本项目时可以用。
- 这份声明是照作者对各许可证的理解写的，不是法律意见。
