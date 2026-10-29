import assert from "node:assert/strict";
import * as vfs from "../compat/vfs.mjs";
import { cp } from "../compat/shims/fs-promises.mjs";

vfs.setFsEngine("memory");
vfs.mkdir("/work/skill-copy/source/docs", { recursive: true });
vfs.writeFile("/work/skill-copy/source/SKILL.md", "hello", {}, "writeFile");
vfs.writeFile("/work/skill-copy/source/docs/guide.md", "guide", {}, "writeFile");
await cp("/work/skill-copy/source", "/work/skill-copy/copy", { recursive: true });
assert.equal(vfs.readFileSync("/work/skill-copy/copy/SKILL.md", "utf8"), "hello");
assert.equal(vfs.readFileSync("/work/skill-copy/copy/docs/guide.md", "utf8"), "guide");
vfs.symlinkSync("/work/skill-copy/source/SKILL.md", "/work/skill-copy/source/docs/link.md");
await assert.rejects(cp("/work/skill-copy/source", "/work/skill-copy/rejected", { recursive: true }), /符号链接/);
assert.equal(vfs.existsSync("/work/skill-copy/rejected"), false);
console.log("skill-copy-smoke: PASS");
