import { createRequire } from "node:module";
const req = createRequire("D:/Zcode/zcode/apps/zcode-cli/package.json");
const esbuild = req("esbuild");
const fs = await import("node:fs");
await esbuild.build({
  entryPoints: ["D:/Zcode/zcode/apps/zcode-cli/packages/contracts/src/tools/write.ts"],
  outfile: "D:/Zcode/tmp-writeschema.mjs", bundle: true, format: "esm", platform: "node", logLevel: "silent",
  alias: { "#src": "D:/Zcode/zcode/apps/zcode-cli/packages/contracts/src" },
});
const { WriteOutputSchema } = await import("file:///D:/Zcode/tmp-writeschema.mjs");
// mock 场景：新建单行文件。core 的 write handler 会算 structuredPatch。
// 候选1：正常形状（应该过）
const ok = WriteOutputSchema.safeParse({
  type: "create", filePath: "/work/x.txt", content: "zcode-tool-loop-ok\n",
  structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+zcode-tool-loop-ok"] }],
  originalFile: null,
});
console.log("candidate1:", ok.success, ok.success ? "" : JSON.stringify(ok.error.issues).slice(0,200));
// 候选2：lines 里混入 undefined（diff 边界 bug 的典型产物）
const bad = WriteOutputSchema.safeParse({
  type: "create", filePath: "/work/x.txt", content: "zcode-tool-loop-ok\n",
  structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+zcode-tool-loop-ok", undefined] }],
  originalFile: null,
});
console.log("candidate2:", bad.success, bad.success ? "" : JSON.stringify(bad.error.issues).slice(0,200));
fs.rmSync("D:/Zcode/tmp-writeschema.mjs", { force: true });
