#!/usr/bin/env python3
"""从官方桌面图标重排出一套符合移动端安全区的图标。

母版是上游的 zcode/public/logo/icons/1024x1024.png（深色圆角方块 + 白色 Z）。
它不能直接当移动端图标用，两处硬伤：字形外接框宽 702px，超出 660 内容框；
Android 自适应图标的最严遮罩是直径 66dp 的圆，按外接框缩放会把 Z 的两个尖角切掉。
所以这里做的是"重排"而不是"缩放"：字形按内容像素的最大半径适配遮罩内切，
背景改成满血（不留透明角），圆角交给启动器遮罩去切。

校验不在这里做——check-icons.mjs 用另一套 PNG 解码器（pngjs）独立读回真实像素，
免得"同一把尺子既画又量"。
"""

import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SOURCE = os.path.join(ROOT, "zcode", "public", "logo", "icons", "1024x1024.png")
RES = os.path.join(ROOT, "android-app", "app", "src", "main", "res")
DIST = os.path.join(ROOT, "mobile-runtime", "build", "icon")

# 安全区参数一律写成"占画布边长的比例"，这样任何密度共用同一套判据。
MASTER_CONTENT_BOX = 660 / 1024  # 母版：内容必须完整落在 660 框内（硬限）
MASTER_SAFE_BOX = 640 / 1024  # 母版实际按 640 安全框排，给 660 硬限留 20px 余量
EDGE_MIN = 100 / 1024  # 硬边图形离 1024 边缘至少 100px
ALPHA_EDGE_MIN = 24 / 1024  # 离边缘 24px 内不许有不透明度变化
# Android 自适应图标：108dp 画布、可见区中心 72dp、最严遮罩是直径 66dp 的圆。
# 排到半径 31dp（校验器判 32dp）：1080→432 这类降采样的 LANCZOS 会在字形外缘留下
# alpha<3% 的振铃像素，实测让内容半径多出 0.9%，正好越线。留 1dp 吸收它，而不是放宽判据。
ADAPTIVE_CONTENT_RADIUS = 31.0 / 108.0
LEGACY_CORNER = 138 / 1024  # 遗留位图自己烘的圆角，取自官方母版的实测半径
SUPERELLIPSE_K = 3.2  # 连续圆角的超椭圆指数：2 是正圆，越大越方

DENSITIES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
LEGACY_DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def load_rgb(src):
    a = np.asarray(src.convert("RGBA")).astype(np.float64)
    return a[:, :, :3], a[:, :, 3]


def extract_glyph(src):
    """把白色字形从深色背景上抠下来，得到带反齿边的 RGBA 字形层。

    不能简单阈值：边缘像素是白与背景的线性混合，硬阈值会把官方图标圆角笔画切出锯齿。
    背景只有纵向渐变，所以按行拟合一条直线，再算每个像素的"白色占比"当 alpha。
    """
    rgb, alpha = load_rgb(src)
    h, w = rgb.shape[:2]
    # 取样避开字形（y 213..810）与圆角透明区（x<160）。
    ys = np.r_[170:213, 811:1000]
    xs = np.arange(160, 860, 7)
    row_index = np.repeat(ys, xs.size)
    col_index = np.tile(xs, ys.size)
    fits = []
    for ch in range(3):
        s = rgb[row_index, col_index, ch]
        slope, intercept = np.polyfit(row_index, s, 1)
        fits.append(np.clip(intercept + slope * np.arange(h), 0.0, 255.0))
    bg = np.stack(fits, axis=-1)  # (H,3)
    ratio = (rgb - bg[:, None, :]) / (255.0 - bg[:, None, :])
    t = np.clip(ratio.min(axis=2), 0.0, 1.0)
    # 噪声底：背景是 8bit 量化的渐变，拟合残差约 1 级，正好落在 ratio≈0.004 上，
    # 不设底就会把整张图当成字形。抬到 6% 再归一，抗锯齿斜坡只损失不到一个像素的十分之一。
    t = np.clip((t - 0.06) / 0.94, 0.0, 1.0)
    t[alpha < 8] = 0.0
    ys_nz, xs_nz = np.nonzero(t > 0)
    box = (int(xs_nz.min()), int(ys_nz.min()), int(xs_nz.max()) + 1, int(ys_nz.max()) + 1)
    crop = t[box[1] : box[3], box[0] : box[2]]
    layer = np.dstack([np.full(crop.shape, 255.0), np.full(crop.shape, 255.0), np.full(crop.shape, 255.0), crop * 255.0])
    img = Image.fromarray(layer.astype(np.uint8), "RGBA")

    # 内容像素到中心的最大半径决定缩放：外接框的四角是空的，按框缩放会白留一圈边距，
    # 而 Z 的尖角又确实顶到框外，两种错法都会发生，只有按实际像素半径才准。
    solid = crop > 250 / 255.0
    yy, xx = np.nonzero(solid)
    cx = crop.shape[1] / 2.0 - 0.5
    cy = crop.shape[0] / 2.0 - 0.5
    rmax = float(np.hypot(xx - cx, yy - cy).max())
    return img, rmax, box


def gradient(size, top, bottom):
    rows = np.linspace(np.array(top, float), np.array(bottom, float), size)
    arr = np.dstack([np.repeat(rows[:, None, :], size, axis=1), np.full((size, size), 255.0)])
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def squircle_mask(size, corner):
    r = size * corner
    g = np.arange(size) + 0.5
    dx = np.maximum(0.0, np.abs(g - size / 2.0) - (size / 2.0 - r)) / r
    dy = np.maximum(0.0, np.abs(g - size / 2.0) - (size / 2.0 - r)) / r
    inside = (dx[None, :] ** SUPERELLIPSE_K + dy[:, None] ** SUPERELLIPSE_K) <= 1.0
    return Image.fromarray((inside * 255).astype(np.uint8), "L")


def paste_scaled(canvas, glyph, rmax, frac, fit):
    """把字形层放大后居中贴上去。两种收法：

    - fit="radius"：内容像素到中心的最大半径 = frac * 画布边长。自适应前景层必须用这个，
      因为 Android 最严的遮罩是直径 66dp 的圆，而这个 Z 的尖角正好顶在外接框的角上，
      按外接框收会把两个尖角切掉。
    - fit="box"：外接框长边 = frac * 画布边长。母版用这个，因为母版面对的圆是"内切于整张方图"
      的那个（半径 512/1024），比启动器可见区的圆松得多，按半径收会让商店图比桌面图小一圈。
    """
    size = canvas.width
    if fit == "radius":
        scale = (frac * size) / rmax
    else:
        scale = (frac * size) / max(glyph.width, glyph.height)
    w = max(1, int(round(glyph.width * scale)))
    h = max(1, int(round(glyph.height * scale)))
    small = glyph.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(small, ((size - w) // 2, (size - h) // 2))
    return w, h


def main():
    if not os.path.exists(SOURCE):
        sys.exit("找不到官方母版：" + SOURCE)
    src = Image.open(SOURCE)
    glyph, rmax, bbox = extract_glyph(src)
    rgb, _ = load_rgb(src)
    mid = src.width // 2
    top = tuple(int(v) for v in rgb[6, mid, :])
    bottom = tuple(int(v) for v in rgb[src.height - 7, mid, :])

    os.makedirs(DIST, exist_ok=True)

    # 1) 母版：满血渐变 + 字形按 640 安全框收（内切圆、圆角矩形遮罩下都不缺角）。
    master = gradient(1024, top, bottom)
    paste_scaled(master, glyph, rmax, MASTER_SAFE_BOX, "box")
    master.save(os.path.join(DIST, "AppIcon.png"))
    for side in (512, 180, 120, 96, 64):
        master.resize((side, side), Image.LANCZOS).save(os.path.join(DIST, "AppIcon-%d.png" % side))

    # 2) 自适应前景层：1080 母版降采样到各密度，只含字形、透明底，按内容圆半径收。
    fg_master = Image.new("RGBA", (1080, 1080), (0, 0, 0, 0))
    paste_scaled(fg_master, glyph, rmax, ADAPTIVE_CONTENT_RADIUS, "radius")
    for name, px in DENSITIES.items():
        folder = os.path.join(RES, "mipmap-" + name)
        os.makedirs(folder, exist_ok=True)
        fg_master.resize((px, px), Image.LANCZOS).save(os.path.join(folder, "ic_launcher_foreground.png"))

    # 3) 遗留位图：圆角自己烘（minSdk 26 以下用不到，但商店列表与部分启动器仍读它），
    #    内容半径与自适应一致，被再遮一层也不缺角。
    legacy = gradient(1024, top, bottom)
    paste_scaled(legacy, glyph, rmax, ADAPTIVE_CONTENT_RADIUS, "radius")
    legacy.putalpha(squircle_mask(1024, LEGACY_CORNER))
    for name, px in LEGACY_DENSITIES.items():
        folder = os.path.join(RES, "mipmap-" + name)
        os.makedirs(folder, exist_ok=True)
        small = legacy.resize((px, px), Image.LANCZOS)
        small.save(os.path.join(folder, "ic_launcher.png"))
        small.save(os.path.join(folder, "ic_launcher_round.png"))

    # 4) 背景层：矢量渐变，分辨率无关，省掉 5 份 PNG。
    drawable = os.path.join(RES, "drawable")
    os.makedirs(drawable, exist_ok=True)
    hex_top = "#%02X%02X%02X" % top
    hex_bottom = "#%02X%02X%02X" % bottom
    with open(os.path.join(drawable, "ic_launcher_background.xml"), "w", encoding="utf-8") as f:
        f.write(
            """<?xml version="1.0" encoding="utf-8"?>
<!-- 自适应图标背景层：满血铺满 108dp，圆角由启动器遮罩负责。
     两个色标是从官方 1024 母版顶/底中点量出来的，不是挑的。 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:startX="54" android:startY="0"
                android:endX="54" android:endY="108"
                android:type="linear">
                <item android:offset="0" android:color="%s" />
                <item android:offset="1" android:color="%s" />
            </gradient>
        </aapt:attr>
    </path>
</vector>
"""
            % (hex_top, hex_bottom)
        )

    anydpi = os.path.join(RES, "mipmap-anydpi-v26")
    os.makedirs(anydpi, exist_ok=True)
    for icon in ("ic_launcher.xml", "ic_launcher_round.xml"):
        with open(os.path.join(anydpi, icon), "w", encoding="utf-8") as f:
            f.write(
                """<?xml version="1.0" encoding="utf-8"?>
<!-- 自适应图标：前景只含字形、且已按直径 62dp 的内容圆收过（判据是 64dp，留 1dp 吸收
     降采样振铃），圆形 / 圆角矩形 / 方角遮罩下都不缺角。 -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""
            )

    report = {
        "source": os.path.relpath(SOURCE, ROOT).replace("\\", "/"),
        "sourceGlyphBBoxPx": [bbox[2] - bbox[0], bbox[3] - bbox[1]],
        "sourceGlyphContentRadiusPx": round(rmax, 2),
        "canvasPx": 1024,
        "safeZonePx": round(MASTER_CONTENT_BOX * 1024),
        "contentBoxLimitPx": 660,
        "edgeMinPx": round(EDGE_MIN * 1024),
        "alphaEdgeMinPx": round(ALPHA_EDGE_MIN * 1024),
        "adaptiveContentRadiusDp": ADAPTIVE_CONTENT_RADIUS * 108,
        "backgroundStops": {"top": list(top), "bottom": list(bottom)},
        "legacyCornerRatio": round(LEGACY_CORNER, 4),
        "measuredBy": "check-icons.mjs（独立解码真实像素），这里只记生成参数",
    }
    with open(os.path.join(DIST, "icon_safe_area.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
