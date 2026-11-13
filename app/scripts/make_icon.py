#!/usr/bin/env python3
# 画应用图标母版（1024×1024 PNG）：圆角方块底 + 白色圆角边框 + 播放三角，图形和菜单栏图标 trayTemplate 一致，换成彩色。
# 用法：python3 app/scripts/make_icon.py [输出.png]（默认 app/assets/icon-1024.png）
# 只在改图标时跑一次，产物提交进仓库；打包脚本 pack.mjs 只用系统自带的 sips + iconutil 把它转成 .icns，不需要 PIL。
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

S = 4  # 先按 4 倍画再缩小，边缘平滑
N = 1024 * S
out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'assets' / 'icon-1024.png'


def sc(v):
    return int(round(v * S))


# macOS 图标网格：内容方块 824×824，居中，圆角约 185
x0, y0, x1, y1 = sc(100), sc(100), sc(924), sc(924)
radius = sc(185)

canvas = Image.new('RGBA', (N, N), (0, 0, 0, 0))

# 投影：方块形状模糊后往下错一点
shadow = Image.new('L', (N, N), 0)
ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + sc(12), x1, y1 + sc(12)), radius, fill=90)
shadow = shadow.filter(ImageFilter.GaussianBlur(sc(18)))
canvas.paste(Image.new('RGBA', (N, N), (0, 0, 0, 255)), (0, 0), shadow)

# 底色：上浅下深的绿色渐变（公众号的绿）
top, bottom = (52, 214, 140), (6, 158, 86)
grad = Image.new('RGBA', (1, N))
for y in range(N):
    t = min(max((y - y0) / (y1 - y0), 0), 1)
    grad.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
grad = grad.resize((N, N))
mask = Image.new('L', (N, N), 0)
ImageDraw.Draw(mask).rounded_rectangle((x0, y0, x1, y1), radius, fill=255)
canvas.paste(grad, (0, 0), mask)

# 白色横向圆角边框（菜单栏图标的外框，约 4:3）
d = ImageDraw.Draw(canvas)
fw, fh = 600, 450
fx0, fy0 = (1024 - fw) / 2, (1024 - fh) / 2
d.rounded_rectangle((sc(fx0), sc(fy0), sc(fx0 + fw), sc(fy0 + fh)), sc(78), outline=(255, 255, 255, 255), width=sc(46))

# 播放三角（往右挪一点，视觉上居中）
cx, cy, th = 512 + 18, 512, 220
tw = th * 0.9
d.polygon([(sc(cx - tw / 2), sc(cy - th / 2)), (sc(cx + tw / 2), sc(cy)), (sc(cx - tw / 2), sc(cy + th / 2))], fill=(255, 255, 255, 255))

canvas.resize((1024, 1024), Image.LANCZOS).save(out)
print(out)
