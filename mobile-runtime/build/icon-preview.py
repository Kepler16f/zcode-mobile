#!/usr/bin/env python3
"""把 adaptive-icon 按启动器真实遮罩合成出来看效果。

光看母版 PNG 不算数：设备上看到的是"背景矢量层 + 前景层"被系统遮罩切完的结果，
圆角切多少由启动器决定。这里按三种最常見的遮罩（正圆、连续圆角、大圆角矩形）各切一遍，
拼成一张对比图，缺角、留白过大、字形偏位都能直接看出来。
"""

import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DIST = os.path.join(ROOT, "mobile-runtime", "build", "icon")
RES = os.path.join(ROOT, "android-app", "app", "src", "main", "res")
SIDE = 432  # xxxhdpi 的 108dp


def background(size, top, bottom):
    rows = np.linspace(np.array(top, float), np.array(bottom, float), size)
    arr = np.dstack([np.repeat(rows[:, None, :], size, axis=1), np.full((size, size), 255.0)])
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def mask(size, shape):
    g = np.arange(size) + 0.5
    half = size / 2.0
    if shape == "circle":
        inside = np.hypot(g[None, :] - half, g[:, None] - half) <= half
    else:
        corner = {"squircle": 0.135, "rounded": 0.22}[shape]
        r = size * corner
        dx = np.maximum(0.0, np.abs(g - half) - (half - r)) / r
        dy = dx
        k = 3.2 if shape == "squircle" else 2.0
        inside = (dx[None, :] ** k + dy[:, None] ** k) <= 1.0
    return Image.fromarray((inside * 255).astype(np.uint8), "L")


def main():
    with open(os.path.join(DIST, "icon_safe_area.json"), encoding="utf-8") as f:
        area = json.load(f)
    top, bottom = area["backgroundStops"]["top"], area["backgroundStops"]["bottom"]
    fg = Image.open(os.path.join(RES, "mipmap-xxxhdpi", "ic_launcher_foreground.png")).convert("RGBA")
    assert fg.width == SIDE, "前景层尺寸不是 %d：%s" % (SIDE, fg.size)

    composed = background(SIDE, top, bottom)
    composed.alpha_composite(fg)
    tiles = [("母版（不遮）", composed), ("桌面 1024", Image.open(os.path.join(DIST, "AppIcon.png")).convert("RGBA").resize((SIDE, SIDE), Image.LANCZOS))]
    for label, shape in [("正圆遮罩", "circle"), ("连续圆角遮罩", "squircle"), ("大圆角矩形遮罩", "rounded")]:
        one = composed.copy()
        one.putalpha(mask(SIDE, shape))
        tiles.append((label, one))

    pad, cols = 24, len(tiles)
    sheet = Image.new("RGBA", (cols * (SIDE + pad) + pad, SIDE + pad + 46), (238, 240, 243, 255))
    from PIL import ImageDraw

    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype("msyh.ttc", 26)  # 标签是中文，arial 会渲染成方块
    for i, (label, tile) in enumerate(tiles):
        x = pad + i * (SIDE + pad)
        sheet.alpha_composite(tile, (x, pad))
        draw.text((x + 6, SIDE + pad + 8), label, fill=(30, 34, 40, 255), font=font)
    out = os.path.join(DIST, "icon-mask-preview.png")
    sheet.convert("RGB").save(out)
    print(out)


if __name__ == "__main__":
    main()
