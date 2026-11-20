import assert from "node:assert/strict";
import * as vfs from "../compat/vfs.mjs";
import { createMobileFileSystemPort } from "../ports/file-system.mjs";

const results = [];
const test = async (name, fn) => {
  await fn();
  results.push(name);
};

await test("B-03 vfs.readMany 混合 /work 与 /mnt/ 路径：保持原始下标顺序与失败项隔离", async () => {
  vfs.setFsEngine("memory");
  vfs.reset();
  vfs.mkdir("/work/mix", { recursive: true });
  vfs.writeFile("/work/mix/a.txt", "work-A");
  vfs.writeFile("/work/mix/b.txt", "work-B");

  const prevTree = globalThis.zcodeTree;
  globalThis.zcodeTree = {
    call(raw) {
      const req = JSON.parse(raw);
      if (req.op === "stat") {
        if (req.path === "/mnt/ext/c.txt") return JSON.stringify({ ok: true, exists: true, kind: "file", size: 6, mtimeMs: 1 });
        return JSON.stringify({ ok: false, code: "ENOENT", path: req.path, message: "missing" });
      }
      if (req.op === "readMany") {
        // 故意倒序返回，验证按 path 认项且外部/work 总下标顺序不变
        return JSON.stringify({
          ok: true,
          items: [
            { path: "/mnt/ext/missing.txt", ok: false, code: "ENOENT", message: "missing" },
            { path: "/mnt/ext/c.txt", ok: true, base64: Buffer.from("tree-C").toString("base64") },
          ],
        });
      }
      return JSON.stringify({ ok: false, code: "ENOTSUP", message: "unsupported" });
    },
  };
  try {
    const out = vfs.readMany([
      "/mnt/ext/c.txt",
      "/work/mix/a.txt",
      "/mnt/ext/missing.txt",
      "/work/mix/does-not-exist.txt",
      "/work/mix/b.txt",
    ]);
    assert.equal(out.length, 5);
    assert.equal(out[0].ok, true);
    assert.equal(Buffer.from(out[0].bytes).toString("utf8"), "tree-C");
    assert.equal(out[1].ok, true);
    assert.equal(Buffer.from(out[1].bytes).toString("utf8"), "work-A");
    assert.equal(out[2].ok, false);
    assert.equal(out[2].code, "ENOENT");
    assert.equal(out[3].ok, false);
    assert.equal(out[4].ok, true);
    assert.equal(Buffer.from(out[4].bytes).toString("utf8"), "work-B");
  } finally {
    globalThis.zcodeTree = prevTree;
  }
});

await test("B-03 searchText 私有盘 CHUNK=512、SAF 树 CHUNK=128 批次数准确", async () => {
  vfs.setFsEngine("memory");
  vfs.reset();
  vfs.mkdir("/work/big", { recursive: true });
  for (let i = 0; i < 1200; i++) {
    vfs.writeFile(`/work/big/f-${i}.txt`, i === 1199 ? "TARGET_END\nline2" : `plain-${i}`);
  }
  const privBatches = [];
  const privVfs = {
    ...vfs,
    readMany(paths) {
      privBatches.push(paths.length);
      return vfs.readMany(paths);
    },
  };
  const privPort = createMobileFileSystemPort(privVfs, { workspaceRoot: "/work/big" });
  const privRes = await privPort.searchText({ path: "/work/big", pattern: "TARGET_END\\nline2", multiline: true });
  assert.deepEqual(privRes.files, ["/work/big/f-1199.txt"]);
  assert.deepEqual(privBatches, [512, 512, 176], "私有盘 1200 文件应按 512 拆为 3 批");

  const treeFiles = Array.from({ length: 300 }, (_, i) => `/mnt/usb/t-${i}.txt`);
  const treeBatches = [];
  const treeVfs = {
    statSync: () => ({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mtimeMs: 1 }),
    lstatSync: () => ({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mtimeMs: 1 }),
    readlinkSync() { throw new Error("unused"); },
    readdirSync: () => treeFiles.map((full, i) => ({
      name: `t-${i}.txt`,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isFile: () => true,
      path: full,
    })),
    readMany(paths) {
      treeBatches.push(paths.length);
      return paths.map((p, idx) => ({
        path: p,
        ok: true,
        bytes: new TextEncoder().encode(p.endsWith("t-299.txt") ? "TREE_HIT" : `n-${idx}`),
      }));
    },
  };
  const treePort = createMobileFileSystemPort(treeVfs, { workspaceRoot: "/mnt/usb" });
  const treeRes = await treePort.searchText({ path: "/mnt/usb", pattern: "TREE_HIT" });
  assert.deepEqual(treeRes.files, ["/mnt/usb/t-299.txt"]);
  assert.deepEqual(treeBatches, [128, 128, 44], "SAF /mnt/ 300 文件应按 128 拆为 3 批");
});

console.log(`readmany-order-smoke: ${results.length}/${results.length} PASS`);
for (const name of results) console.log(`  ✓ ${name}`);
