#!/usr/bin/env node
// 图标安全区校验：把真实像素读回来量，不采信生成脚本自己写的参数。
//
// 为什么单独一个文件、还故意换一套解码器（pngjs，而生成用 PIL）：
// 同一工具链既画又量，画错了量也量不出来。这里读的是落盘的 PNG 本体，
// 生成脚本里改坏了公式、或者 resize 把内容推出安全区，都会在这里现形。
//
// 判据分两套：
//  - 满血图（母版、自适应前景）：不许在离边缘 24px 内出现不透明度变化，
//    因为圆角/圆形遮罩由系统切，边缘留透明就会切出毛边。
//  - 遗留位图（mipmap-*/ic_launcher.png）：圆角是**故意烘进去**的，天然有边缘透明变化，
//    所以只量内容半径，不套 24px 那条。两套规则混用会把该过的判 FAIL。
//
// 用法：node mobile-runtime/build/check-icons.mjs
//       node mobile-runtime/build/check-icons.mjs --negative-control

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(path.join(root, "zcode", "package.json"));
const { PNG } = require(path.join(root, "zcode", "node_modules", "pngjs"));

const RES = path.join(root, "android-app", "app", "src", "main", "res");
const DIST = path.join(here, "icon");
const OFFICIAL = path.join(root, "zcode", "public", "logo", "icons", "1024x1024.png");

// 判据常数全部以"占画布边长的比例"写，任何密度按同一比例换算。
const RULE = {
  contentBox: 660 / 1024, // 内容必须完整落在 660 框内
  edgeMin: 100 / 1024, // 硬边图形离边缘至少 100px
  alphaEdgeMin: 24 / 1024, // 离边缘 24px 内不许有不透明度变化
  adaptiveRadius: 32 / 108, // 自适应前景内容半径上限（直径 66dp 圆再留 1dp）
  tolerance: 0.004, // 0.4% 画布，吸收 LANCZOS 重采样的半个像素
};

function decode(file) {
  const png = PNG.sync.read(readFileSync(file));
  return { w: png.width, h: png.height, data: png.data, file };
}

/** 内容像素 = 明显亮于背景的像素（字形纯白、背景最亮 23），或前景层里 alpha>8 的像素。 */
function measure(img, mode) {
  const { w, h, data } = img;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  let minx = w, miny = h, maxx = -1, maxy = -1, rmax = 0, count = 0;
  // 边缘不透明度变化：离边缘 alphaEdgeMin 带内，是否存在 alpha 从透明到不透明的跳变。
  const band = Math.max(1, Math.round(RULE.alphaEdgeMin * w));
  let edgeAlphaChanges = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      const content = mode === "alpha" ? a > 8 : Math.min(data[i], data[i + 1], data[i + 2]) > 40 && a > 8;
      if (content) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        const r = Math.hypot(x - cx, y - cy);
        if (r > rmax) rmax = r;
        count++;
      }
      if (x < band || y < band || x >= w - band || y >= h - band) {
        const xl = x > 0 ? data[i - 4 + 3] : a;
        const xr = x < w - 1 ? data[i + 4 + 3] : a;
        const yu = y > 0 ? data[i - w * 4 + 3] : a;
        const yd = y < h - 1 ? data[i + w * 4 + 3] : a;
        if (Math.max(Math.abs(a - xl), Math.abs(a - xr), Math.abs(a - yu), Math.abs(a - yd)) > 32) {
          edgeAlphaChanges++;
        }
      }
    }
  }
  if (maxx < 0) return { empty: true };
  return {
    bbox: [minx, miny, maxx, maxy],
    bboxSize: [maxx - minx + 1, maxy - miny + 1],
    contentRadius: rmax,
    contentPixels: count,
    edgeAlphaChanges,
    // 离四边的最近距离：硬边图形必须 ≥100px。
    edgeDist: [minx, miny, w - 1 - maxx, h - 1 - maxy],
  };
}

/** 遮罩存活：把内容像素逐个投到遮罩形状里，落在外面的数量必须为 0。 */
function maskSurvival(img, shape) {
  const { w, h, data } = img;
  const half = w / 2;
  let outside = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.min(data[i], data[i + 1], data[i + 2]) <= 40 || data[i + 3] <= 8) continue;
      const nx = Math.abs(x + 0.5 - half) / half;
      const ny = Math.abs(y + 0.5 - half) / half;
      const inside =
        shape === "circle"
          ? Math.hypot(nx, ny) <= 1
          : Math.pow(Math.max(0, nx - (1 - 0.225)) / 0.225, 3.2) + Math.pow(Math.max(0, ny - (1 - 0.225)) / 0.225, 3.2) <= 1;
      if (!inside) outside++;
    }
  }
  return outside;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

function checkMaster(file, label, { fullBleed }) {
  const img = decode(file);
  const m = measure(img, "luma");
  const box = RULE.contentBox * img.w;
  const edge = RULE.edgeMin * img.w;
  const alphaBand = RULE.alphaEdgeMin * img.w;
  const maxHalf = Math.max(...m.bboxSize) / 2;
  check(`${label} 内容落在 ${Math.round(box)}px 框内`, Math.max(...m.bboxSize) <= box * (1 + RULE.tolerance), `实测 bbox=${m.bboxSize.join("x")}，内容半径=${m.contentRadius.toFixed(1)}px`);
  check(`${label} 硬边离边缘 ≥${Math.round(edge)}px`, Math.min(...m.edgeDist) >= edge, `实测四边 ${m.edgeDist.map((v) => Math.round(v)).join("/")}`);
  if (fullBleed) {
    check(`${label} 离边缘 ${Math.round(alphaBand)}px 内无不透明度变化`, m.edgeAlphaChanges === 0, `实测跳变点 ${m.edgeAlphaChanges} 个`);
  }
  const circ = maskSurvival(img, "circle");
  const squ = maskSurvival(img, "squircle");
  check(`${label} 圆形遮罩下内容完整`, circ === 0, `被切掉 ${circ} 个内容像素`);
  check(`${label} 圆角矩形遮罩下内容完整`, squ === 0, `被切掉 ${squ} 个内容像素`);
  return { img, m };
}

function main() {
  const negative = process.argv.includes("--negative-control");
  if (negative) {
    // 负对照：官方桌面母版必须被判 FAIL（字形外接框 702px > 660，且带透明圆角）。
    // 这条跑绿说明校验器是摆设——它连已知不合格的都放过。
    console.log("负对照：拿官方桌面母版跑同一套判据，预期 FAIL");
    const img = decode(OFFICIAL);
    const m = measure(img, "luma");
    const overBox = Math.max(...m.bboxSize) > RULE.contentBox * img.w;
    const edgeAlpha = m.edgeAlphaChanges > 0;
    check("负对照：校验器抓到官方母版内容超框", overBox, `外接框 ${m.bboxSize.join("x")}，限 ${Math.round(RULE.contentBox * img.w)}`);
    check("负对照：校验器抓到官方母版边缘有不透明度变化", edgeAlpha, `跳变点 ${m.edgeAlphaChanges} 个`);
    // 极性说明：这里 PASS = 违规被抓到。两条全 PASS 才算校验器有效；
    // 任何一条 PASS 不了（即官方母版被判合格），说明判据是摆设。
    const missed = results.filter((r) => !r.ok).length;
    console.log(missed === 0 ? "负对照有效：官方母版两条违规都被判出" : `负对照失效：有 ${missed} 条违规没抓到`);
    process.exit(missed === 0 ? 0 : 1);
  }

  const files = [
    [path.join(DIST, "AppIcon.png"), "母版", true],
    [path.join(DIST, "AppIcon-180.png"), "AppIcon 180", true],
    [path.join(DIST, "AppIcon-120.png"), "AppIcon 120", true],
    [path.join(DIST, "AppIcon-96.png"), "AppIcon 96", true],
    [path.join(DIST, "AppIcon-64.png"), "AppIcon 64", true],
  ];
  for (const [file, label, fullBleed] of files) {
    if (!existsSync(file)) {
      check(`${label} 存在`, false, file);
      continue;
    }
    checkMaster(file, label, { fullBleed });
  }

  // 自适应前景层：内容半径必须落在 32/108 以内，且自身是透明底。
  for (const [dir, px] of [["mdpi", 108], ["hdpi", 162], ["xhdpi", 216], ["xxhdpi", 324], ["xxxhdpi", 432]]) {
    const file = path.join(RES, `mipmap-${dir}`, "ic_launcher_foreground.png");
    if (!existsSync(file)) {
      check(`前景层 ${dir} 存在`, false, file);
      continue;
    }
    const img = decode(file);
    const m = measure(img, "alpha");
    const limit = RULE.adaptiveRadius * img.w;
    check(`前景层 ${dir} 尺寸 ${px}px`, img.w === px && img.h === px, `实测 ${img.w}x${img.h}`);
    check(`前景层 ${dir} 内容半径 ≤${limit.toFixed(1)}px（即 108dp 画布上半径 32dp）`, m.contentRadius <= limit * (1 + RULE.tolerance), `实测 ${m.contentRadius.toFixed(1)}px，内容像素 ${m.contentPixels}`);
    check(`前景层 ${dir} 离边缘 ${Math.round(RULE.alphaEdgeMin * px)}px 内无不透明度变化`, m.edgeAlphaChanges === 0, `实测跳变点 ${m.edgeAlphaChanges} 个`);
  }

  // 遗留位图：圆角是烘进去的（整块 tile 都不透明），所以只能按亮度认字形，
  // 按 alpha 认会把背景一起算成内容、半径直接爆表。
  for (const [dir, px] of [["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]]) {
    const file = path.join(RES, `mipmap-${dir}`, "ic_launcher.png");
    if (!existsSync(file)) {
      check(`遗留图标 ${dir} 存在`, false, file);
      continue;
    }
    const img = decode(file);
    const m = measure(img, "luma");
    check(`遗留图标 ${dir} 内容半径 ≤${(RULE.adaptiveRadius * px).toFixed(1)}px`, m.contentRadius <= RULE.adaptiveRadius * px * (1 + RULE.tolerance), `实测 ${m.contentRadius.toFixed(1)}px`);
  }

  // XML 接线：anydpi 的 adaptive-icon 引用的资源必须在每个密度里都存在。
  const anydpi = path.join(RES, "mipmap-anydpi-v26", "ic_launcher.xml");
  check("mipmap-anydpi-v26/ic_launcher.xml 存在", existsSync(anydpi), anydpi);
  if (existsSync(anydpi)) {
    const xml = readFileSync(anydpi, "utf8");
    check("ic_launcher.xml 是 adaptive-icon 且引用背景+前景", /<adaptive-icon/.test(xml) && /@drawable\/ic_launcher_background/.test(xml) && /@mipmap\/ic_launcher_foreground/.test(xml), "");
    check("背景层矢量存在", existsSync(path.join(RES, "drawable", "ic_launcher_background.xml")), "");
  }
  const manifest = readFileSync(path.join(root, "android-app", "app", "src", "main", "AndroidManifest.xml"), "utf8");
  check("manifest 不再用系统默认图标", !/@android:drawable\/sym_def_app_icon/.test(manifest) && /android:icon="@mipmap\/ic_launcher"/.test(manifest), "");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n图标安全区校验：${results.length - failed.length} PASS / ${failed.length} FAIL`);
  if (failed.length) {
    console.log("失败项：" + failed.map((f) => f.name).join(" | "));
    process.exit(1);
  }
}

main();
