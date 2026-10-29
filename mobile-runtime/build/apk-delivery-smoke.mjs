import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { publishApk } from "./publish-apk.mjs";
const root = mkdtempSync(path.join(os.tmpdir(), "zcode-delivery-"));
try {
  const downloads = path.join(root, "downloads"); mkdirSync(downloads);
  const source = path.join(root, "new.apk"); writeFileSync(source, "new apk");
  for (const name of ["aZCode-0.7.9.apk", "aZCode-0.8.0.apk", "aZCode-0.9.0.apk", "Other-0.1.0.apk", "aZCode-not-version.apk"]) writeFileSync(path.join(downloads, name), name);
  assert.throws(() => publishApk({ apk: path.join(root, "missing"), version: "0.8.1", downloadDir: downloads }));
  assert.ok(existsSync(path.join(downloads, "aZCode-0.8.0.apk")), "复制失败不能删除旧版");
  assert.throws(() => publishApk({ apk: source, version: "../bad", downloadDir: downloads }));
  const delivered = publishApk({ apk: source, version: "0.8.1", downloadDir: downloads });
  assert.equal(readFileSync(delivered.target, "utf8"), "new apk");
  assert.deepEqual(delivered.removed.sort(), ["aZCode-0.7.9.apk", "aZCode-0.8.0.apk"]);
  assert.ok(existsSync(path.join(downloads, "aZCode-0.9.0.apk")));
  assert.ok(existsSync(path.join(downloads, "Other-0.1.0.apk")));
  writeFileSync(source, "rebuilt");
  publishApk({ apk: source, version: "0.8.1", downloadDir: downloads });
  assert.equal(readFileSync(delivered.target, "utf8"), "rebuilt");
  console.log("apk-delivery-smoke: PASS");
} finally { rmSync(root, { recursive: true, force: true }); }
