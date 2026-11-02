// 端侧更新桥胶水的自检（不进交付链，只在本机跑）。
// 判据：
//   A. 桌面宿主（没有 window.zcodeUpdate / window.zcodeNotify）→ 每个出口都安全返回
//      null/false，一个字节都不抛（通知是锦上添花，绝不能把一轮对话搞挂）。
//   B. 桥在的时候，JSON 回包按约定解析：checkForUpdate 的 hasUpdate/current/latest、
//      startDownload 的 jobId、getDownloadProgress 的 state/downloaded/total/filePath、
//      installApk 的 need_install_permission（要能认出这个错误码）。
//   C. 桥回的不是合法 JSON / 桥抛异常 → 当"没有回包"，不炸。
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "mobile-runtime/ui/app-update.ts");
const output = path.join(root, "tmp", `app-update-${process.pid}.mjs`);
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [source],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
});
try {
  const api = await import(pathToFileURL(output).href);

  // A. 没有桥：全部安全返回。
  assert.equal(api.getAppUpdateBridge(), undefined, "没有桥时不该给出更新桥");
  assert.equal(api.getNotifyBridge(), undefined, "没有桥时不该给出通知桥");
  assert.equal(api.checkForUpdate(), null);
  assert.equal(api.startDownload("https://x/y.apk", false), null);
  assert.equal(api.getDownloadProgress("job-1"), null);
  assert.equal(api.cancelDownload("job-1"), false);
  assert.equal(api.installApk("/tmp/a.apk"), null);
  assert.equal(api.openInstallPermission(), false);
  assert.equal(api.requestNotificationPermission(), false);
  assert.equal(api.hasNotificationPermission(), false);
  console.log("PASS  没有原生桥时全部安全返回");

  // B. 桥在：按契约解析。
  const calls = [];
  globalThis.zcodeUpdate = {
    checkForUpdate: () => {
      calls.push("checkForUpdate");
      return JSON.stringify({
        ok: true,
        hasUpdate: true,
        current: "0.11.1",
        latest: "0.11.2",
        tag: "v0.11.2",
        url: "https://x/y.apk",
        notes: "n",
        size: 1024,
      });
    },
    startDownload: (url, background) => {
      calls.push(`startDownload:${background}:${url}`);
      return JSON.stringify({ ok: true, jobId: "job-7" });
    },
    getDownloadProgress: (jobId) =>
      JSON.stringify({ ok: true, state: "done", downloaded: 100, total: 100, filePath: "/f.apk" }),
    cancelDownload: () => JSON.stringify({ ok: true }),
    installApk: () =>
      JSON.stringify({ ok: false, error: "need_install_permission", canRequest: true }),
    openInstallPermission: () => JSON.stringify({ ok: true }),
  };
  globalThis.zcodeNotify = {
    requestPermission: () => JSON.stringify({ ok: true, granted: true }),
    hasPermission: () => true,
  };
  const check = api.checkForUpdate();
  assert.equal(check.hasUpdate, true);
  assert.equal(check.current, "0.11.1");
  assert.equal(check.latest, "0.11.2");
  assert.equal(api.startDownload("https://x/y.apk", true), "job-7");
  assert.ok(calls.includes("startDownload:true:https://x/y.apk"), "后台下载必须带 background=true");
  const progress = api.getDownloadProgress("job-7");
  assert.equal(progress.state, "done");
  assert.equal(progress.filePath, "/f.apk");
  assert.equal(api.cancelDownload("job-7"), true);
  const install = api.installApk("/f.apk");
  assert.equal(install.ok, false);
  assert.equal(install.error, "need_install_permission");
  assert.equal(api.openInstallPermission(), true);
  assert.equal(api.requestNotificationPermission(), true);
  assert.equal(api.hasNotificationPermission(), true);
  console.log("PASS  桥在时按契约解析（含 need_install_permission）");

  // C. 桥回垃圾 / 桥抛异常 → 当"没有回包"。
  globalThis.zcodeUpdate = {
    checkForUpdate: () => "not json",
    startDownload: () => {
      throw new Error("boom");
    },
    getDownloadProgress: () => "{{{",
    installApk: () => "null",
  };
  assert.equal(api.checkForUpdate(), null);
  assert.equal(api.startDownload("https://x/y.apk", false), null);
  assert.equal(api.getDownloadProgress("job-7"), null);
  assert.equal(api.installApk("/f.apk"), null);
  console.log("PASS  桥回垃圾/抛异常时不当成成功");
  console.log("app-update-smoke: PASS");
} finally {
  delete globalThis.zcodeUpdate;
  delete globalThis.zcodeNotify;
  unlinkSync(output);
}
