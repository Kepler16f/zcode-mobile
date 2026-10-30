import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const esbuild = require("esbuild");
const git = createRequire(path.join(root, "mobile-runtime/package.json"))("isomorphic-git");
const out = path.join(root, "mobile-runtime/build", `.tmp-git-panel-${process.pid}.mjs`);
await esbuild.build({ stdin: { contents: `export {createMobileGitService} from "./git-service.ts"; export {mobileGitDiff} from "./git-diff.ts";`, resolveDir: path.join(root, "mobile-runtime/ui") }, outfile: out, bundle: true, format: "esm", platform: "node", target: "node24", logLevel: "warning" });
try {
  const { createMobileGitService, mobileGitDiff } = await import(pathToFileURL(out).href);
  fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "tmp/git-panel-")).replaceAll("\\", "/");
  const service = createMobileGitService({ load: async workspacePath => ({ git, fs, dir: workspacePath, isRepository: fs.existsSync(`${workspacePath}/.git`) }) });
  const empty = await service.getRepositorySummary({ workspacePath: dir });
  assert.equal(empty.isGitAvailable, true);
  assert.equal(empty.isRepository, false);
  await git.init({ fs, dir, defaultBranch: "main" });
  await git.setConfig({ fs, dir, path: "user.name", value: "Test" });
  await git.setConfig({ fs, dir, path: "user.email", value: "test@example.invalid" });
  fs.writeFileSync(`${dir}/a.txt`, "old\n");
  await git.add({ fs, dir, filepath: "a.txt" });
  await git.commit({ fs, dir, message: "initial", author: { name: "Test", email: "test@example.invalid" } });
  assert.equal((await service.getRepositorySummary({ workspacePath: dir })).isDirty, false);
  fs.writeFileSync(`${dir}/a.txt`, "new and longer\n");
  assert.deepEqual((await service.getChanges({ workspacePath: dir, sourceId: "unstaged" })).map(x => x.repoRelativePath), ["a.txt"]);
  const unstagedDiff = await service.getDiff({ workspacePath: dir, path: "a.txt", sourceId: "unstaged" });
  assert.equal(unstagedDiff.beforeContent, "old\n");
  assert.equal(unstagedDiff.afterContent, "new and longer\n");
  await service.stagePaths({ workspacePath: dir, paths: [`${dir}/a.txt`] });
  assert.equal((await service.getChanges({ workspacePath: dir, sourceId: "staged" })).length, 1);
  const stagedDiff = await service.getDiff({ workspacePath: dir, path: "a.txt", sourceId: "staged" });
  assert.equal(stagedDiff.beforeContent, "old\n");
  assert.equal(stagedDiff.afterContent, "new and longer\n");
  await service.unstagePaths({ workspacePath: dir, paths: ["a.txt"] });
  assert.equal((await service.getChanges({ workspacePath: dir, sourceId: "staged" })).length, 0);
  await service.stagePaths({ workspacePath: dir, paths: ["a.txt"] });
  const committed = await service.commit({ workspacePath: dir, message: "update", paths: ["a.txt"], stagedOnly: true });
  assert.match(committed.commitHash, /^[a-f0-9]{40}$/);
  assert.equal((await service.getCommitGraph({ workspacePath: dir })).commits.length, 2);
  const branch = await service.createBranchAndSwitch({ workspacePath: dir, branchName: "feature" });
  assert.equal(branch.ok, true);
  assert.equal((await service.getLocalBranches({ workspacePath: dir })).currentBranchName, "feature");
  const workspacePath = dir;
  const list = sourceId => service.getChanges({ workspacePath, sourceId });
  const diff = (name, sourceId = "unstaged") => service.getDiff({ workspacePath, path: name, sourceId });
  // 同秒同尺寸修改：即使 index stat 完全相同，面板也必须读取实际内容。
  const previous = fs.statSync(`${dir}/a.txt`);
  fs.writeFileSync(`${dir}/a.txt`, "OLD and longer\n");
  fs.utimesSync(`${dir}/a.txt`, previous.atime, previous.mtime);
  assert.deepEqual((await list("unstaged")).map(x => [x.repoRelativePath, x.added, x.removed]), [["a.txt", 1, 1]]);
  assert.match((await diff("a.txt")).patch, /-new and longer\n\+OLD and longer/);
  await service.stagePaths({ workspacePath, paths: ["a.txt"] });
  fs.writeFileSync(`${dir}/a.txt`, "OLD and longer\nsecond\n");
  assert.deepEqual((await list("staged")).map(x => [x.added, x.removed]), [[1, 1]]);
  assert.deepEqual((await list("unstaged")).map(x => [x.added, x.removed]), [[1, 0]]);
  assert.equal((await diff("a.txt", "staged")).afterContent, "OLD and longer\n");
  assert.equal((await diff("a.txt")).beforeContent, "OLD and longer\n");
  fs.writeFileSync(`${dir}/new.txt`, "one\r\ntwo");
  const untracked = (await list("unstaged")).find(x => x.repoRelativePath === "new.txt");
  assert.equal(untracked.isUntracked, true);
  assert.equal(untracked.added, 2);
  assert.match((await diff("new.txt")).patch, /--- \/dev\/null\n\+\+\+ b\/new.txt\n@@ -0,0 \+1,2 @@\n\+one\n\+two\n\\ No newline/);
  await service.stagePaths({ workspacePath, paths: ["new.txt"] });
  assert.equal((await diff("new.txt", "staged")).beforeContent, null);
  assert.equal((await diff("new.txt", "staged")).afterContent, "one\ntwo");
  fs.unlinkSync(`${dir}/a.txt`);
  const deletion = (await list("unstaged")).find(x => x.repoRelativePath === "a.txt");
  assert.equal(deletion.kind, "deleted");
  assert.equal(deletion.removed, 1);
  assert.match((await diff("a.txt")).patch, /\+\+\+ \/dev\/null/);
  await service.stagePaths({ workspacePath, paths: ["a.txt"] });
  assert.equal((await list("staged")).find(x => x.repoRelativePath === "a.txt").kind, "deleted");
  assert.equal((await diff("a.txt", "staged")).beforeContent, "new and longer\n");
  assert.equal((await diff("a.txt", "staged")).afterContent, null);
  fs.writeFileSync(`${dir}/.gitignore`, "ignored/\n*.log\n");
  fs.mkdirSync(`${dir}/ignored`);
  fs.writeFileSync(`${dir}/ignored/x.txt`, "hidden");
  fs.writeFileSync(`${dir}/ignored.log`, "hidden");
  assert.ok(!(await list("unstaged")).some(x => x.repoRelativePath.startsWith("ignored")));
  fs.writeFileSync(`${dir}/binary.bin`, Buffer.from([0, 255, 10]));
  assert.equal((await diff("binary.bin")).availability, "binary");
  fs.writeFileSync(`${dir}/large.txt`, "a".repeat(1024 * 1024 + 1));
  assert.equal((await diff("large.txt")).availability, "truncated");
  fs.writeFileSync(`${dir}/empty.txt`, "");
  assert.equal((await list("unstaged")).find(x => x.repoRelativePath === "empty.txt").kind, "added");
  const emptyRepo = fs.mkdtempSync(path.join(root, "tmp/git-panel-unborn-")).replaceAll("\\", "/");
  await git.init({ fs, dir: emptyRepo, defaultBranch: "main" });
  assert.equal((await service.getRepositorySummary({ workspacePath: emptyRepo })).isDirty, false);
  fs.writeFileSync(`${emptyRepo}/first.txt`, "first\n");
  await service.stagePaths({ workspacePath: emptyRepo, paths: ["first.txt"] });
  assert.equal((await service.getChanges({ workspacePath: emptyRepo, sourceId: "staged" }))[0].added, 1);
  assert.match((await service.getDiff({ workspacePath: emptyRepo, path: "first.txt", sourceId: "staged" })).patch, /--- \/dev\/null/);
  await service.unstagePaths({ workspacePath: emptyRepo, paths: ["first.txt"] });
  assert.equal((await service.getChanges({ workspacePath: emptyRepo, sourceId: "staged" })).length, 0);
  assert.equal((await diff("missing.txt")).availability, "unavailable");
  await assert.rejects(service.stagePaths({ workspacePath: dir, paths: ["../outside.txt"] }), /越出/);
  await assert.rejects(service.getDiff({ workspacePath: dir, path: "../outside.txt" }), /越出/);
  await assert.rejects(diff(".git/config"), /路径/);
  await assert.rejects(diff("nested/.git/config"), /路径/);
  // 用系统 Git 校验生成 patch，并用独立 LCS 验证 Myers 的最小增删数。
  const version = text => ({ type: "blob", mode: 0o100644, oid: "test", bytes: new TextEncoder().encode(text) });
  const preview = (a, b) => mobileGitDiff("roundtrip.txt", "roundtrip.txt", version(a), version(b), v => Promise.resolve(v.bytes));
  let random = 41;
  const next = n => ((random = (random * 1664525 + 1013904223) >>> 0) % n);
  const tokens = ["one\n", "two\n", "\n", "-- text\n", "++ text\n"];
  for (let run = 0; run < 80; run++) {
    const a = Array.from({ length: next(9) }, () => tokens[next(tokens.length)]);
    const b = Array.from({ length: next(9) }, () => tokens[next(tokens.length)]);
    if (a.length && next(2)) a[a.length - 1] = a.at(-1).slice(0, -1);
    if (b.length && next(2)) b[b.length - 1] = b.at(-1).slice(0, -1);
    if (a.at(-1) === "") a.pop();
    if (b.at(-1) === "") b.pop();
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) lcs[i][j] = a[i - 1] === b[j - 1] ? lcs[i - 1][j - 1] + 1 : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    const result = await preview(a.join(""), b.join(""));
    assert.equal(result.added, b.length - lcs[a.length][b.length]);
    assert.equal(result.removed, a.length - lcs[a.length][b.length]);
    if (a.join("") === b.join("")) continue;
    fs.writeFileSync(`${dir}/roundtrip.txt`, a.join(""));
    const applied = spawnSync("git", ["apply", "--check", "-"], { cwd: dir, input: result.diff.patch, encoding: "utf8", windowsHide: true });
    assert.equal(applied.status, 0, `${applied.stderr}\n${result.diff.patch}`);
  }
  const deep = Array.from({ length: 200 }, (_, i) => `line ${i}\n`);
  const changed = [...deep]; changed[10] = "changed first\n"; changed[190] = "changed last\n";
  const multiHunk = await preview(deep.join(""), changed.join(""));
  assert.equal(multiHunk.diff.patch.match(/^@@ /gm).length, 2);
  fs.writeFileSync(`${dir}/roundtrip.txt`, deep.join(""));
  const multiApplied = spawnSync("git", ["apply", "--check", "-"], { cwd: dir, input: multiHunk.diff.patch, encoding: "utf8", windowsHide: true });
  assert.equal(multiApplied.status, 0, multiApplied.stderr);
  const budget = await preview(Array.from({ length: 1400 }, (_, i) => `old ${i}\n`).join(""), Array.from({ length: 1400 }, (_, i) => `new ${i}\n`).join(""));
  assert.equal(budget.diff.availability, "truncated");
  assert.equal((await preview("", "\n".repeat(50_001))).diff.availability, "truncated");
  let scans = 0;
  let ticks = 0;
  const instrumented = { ...git, walk: async args => { scans++; return git.walk(args); } };
  const measured = createMobileGitService({load: async () => ({git:instrumented,fs,dir,isRepository:true})});
  for(let i=0;i<120;i++) fs.writeFileSync(`${dir}/heartbeat-${i}.txt`, "test");
  const timer = setInterval(()=>ticks++,0);
  try {
    const result = await measured.refresh({workspacePath:dir});
    assert.equal(scans,1,"一次刷新只遍历一次工作树");
    assert.equal(result.summary.isDirty,true);
    assert.ok(result.unstagedChanges.length >= 120);
    assert.ok(ticks > 0,"长目录扫描必须给主事件循环让出时间");
  } finally { clearInterval(timer); }

  // ══ 面板新增能力（0.9.2 桌面对齐）：丢弃改动 / 分支比较 / 提交信息 / 推送 / 指定起点 ══
  const panelDir = fs.mkdtempSync(path.join(root, "tmp/git-panel-parity-")).replaceAll("\\", "/");
  const panel = createMobileGitService({ load: async workspacePath => ({ git, fs, dir: workspacePath, isRepository: fs.existsSync(`${workspacePath}/.git`) }) });
  const author = { name: "Test", email: "test@example.invalid" };
  await git.init({ fs, dir: panelDir, defaultBranch: "main" });
  await git.setConfig({ fs, dir: panelDir, path: "user.name", value: "Test" });
  await git.setConfig({ fs, dir: panelDir, path: "user.email", value: "test@example.invalid" });
  fs.writeFileSync(`${panelDir}/a.txt`, "one\n");
  await git.add({ fs, dir: panelDir, filepath: "a.txt" });
  const baseCommit = await git.commit({ fs, dir: panelDir, message: "base", author });

  // A. 丢弃未暂存改动：工作树回到索引内容
  fs.writeFileSync(`${panelDir}/a.txt`, "one\ntwo\n");
  await panel.discardPaths({ workspacePath: panelDir, paths: ["a.txt"], staged: false });
  assert.equal(fs.readFileSync(`${panelDir}/a.txt`, "utf8"), "one\n", "未暂存改动应恢复到索引内容");

  // B. 丢弃暂存改动：索引与工作树一起回到 HEAD；本次新加的文件从工作树消失
  fs.writeFileSync(`${panelDir}/a.txt`, "one\nstaged\n");
  await git.add({ fs, dir: panelDir, filepath: "a.txt" });
  fs.writeFileSync(`${panelDir}/a.txt`, "one\nstaged\nworktree\n");
  fs.writeFileSync(`${panelDir}/new.txt`, "brand new\n");
  await git.add({ fs, dir: panelDir, filepath: "new.txt" });
  await panel.discardPaths({ workspacePath: panelDir, paths: ["a.txt", "new.txt"], staged: true });
  assert.equal(fs.readFileSync(`${panelDir}/a.txt`, "utf8"), "one\n", "丢弃暂存改动后工作树应回到 HEAD");
  assert.equal(fs.existsSync(`${panelDir}/new.txt`), false, "本次新加的文件应随暂存改动一起被丢弃");
  assert.equal((await panel.getChanges({ workspacePath: panelDir, sourceId: "staged" })).length, 0, "丢弃后不应还有暂存改动");

  // C. 未跟踪文件没有索引内容可恢复：明确报错，不静默删用户文件
  fs.writeFileSync(`${panelDir}/untracked.txt`, "loose\n");
  await assert.rejects(panel.discardPaths({ workspacePath: panelDir, paths: ["untracked.txt"], staged: false }), /未跟踪/);
  assert.equal(fs.existsSync(`${panelDir}/untracked.txt`), true, "未跟踪文件不能被丢弃操作删掉");
  fs.unlinkSync(`${panelDir}/untracked.txt`);

  // D. 分支比较：三点语义（共同祖先 → HEAD），远端独有的提交不算成本地改动
  assert.equal((await panel.getBranchComparison({ workspacePath: panelDir })).baseRef, null, "没有上游时不应编造比较基准");
  await git.branch({ fs, dir: panelDir, ref: "remote-only" });
  await git.checkout({ fs, dir: panelDir, ref: "remote-only" });
  fs.writeFileSync(`${panelDir}/remote.txt`, "remote\n");
  await git.add({ fs, dir: panelDir, filepath: "remote.txt" });
  const remoteOnly = await git.commit({ fs, dir: panelDir, message: "remote only", author });
  await git.checkout({ fs, dir: panelDir, ref: "main" });
  fs.writeFileSync(`${panelDir}/local.txt`, "local\n");
  await git.add({ fs, dir: panelDir, filepath: "local.txt" });
  const localOnly = await git.commit({ fs, dir: panelDir, message: "local only", author });
  await git.writeRef({ fs, dir: panelDir, ref: "refs/remotes/origin/main", value: remoteOnly });
  await git.setConfig({ fs, dir: panelDir, path: "branch.main.remote", value: "origin" });
  await git.setConfig({ fs, dir: panelDir, path: "branch.main.merge", value: "refs/heads/main" });
  const comparison = await panel.getBranchComparison({ workspacePath: panelDir });
  assert.equal(comparison.baseRef, "origin/main");
  assert.equal(comparison.headRef, "main");
  assert.equal(comparison.comparisonLabel, "main -> origin/main");
  assert.deepEqual(comparison.changes.map(change => change.repoRelativePath), ["local.txt"], "只应报告共同祖先之后的本地改动");
  assert.equal(comparison.changes[0].kind, "added");
  assert.equal(comparison.changes[0].section, "branch");
  assert.equal(comparison.changes[0].added, 1);
  assert.ok(localOnly && baseCommit);

  // E. 本地生成提交信息：只依据真实改动，不联网
  fs.writeFileSync(`${panelDir}/local.txt`, "local\nchanged\n");
  const generated = await panel.generateCommitMessage({ workspacePath: panelDir });
  assert.match(generated.message, /local\.txt/, "提交信息应包含真实改动文件");
  assert.equal(generated.providerId, "mobile-local-git", "本地生成必须如实标注来源");
  fs.writeFileSync(`${panelDir}/ignored-by-session.txt`, "noise\n");
  const scoped = await panel.generateCommitMessage({ workspacePath: panelDir, currentSessionFilePaths: [`${panelDir}/local.txt`] });
  assert.match(scoped.message, /local\.txt/);
  assert.doesNotMatch(scoped.message, /ignored-by-session/, "只应描述本次会话碰过的文件");
  fs.unlinkSync(`${panelDir}/ignored-by-session.txt`);
  await git.add({ fs, dir: panelDir, filepath: "local.txt" });
  await git.commit({ fs, dir: panelDir, message: "clean", author });
  await assert.rejects(panel.generateCommitMessage({ workspacePath: panelDir }), /没有可用/);

  // F. 推送：远端选择、建立上游、失败语义
  await assert.rejects(panel.push({ workspacePath: panelDir }), /远端|没有配置/);
  const httpModule = await import("node:http");
  const pkt = text => {
    const body = Buffer.from(text, "utf8");
    // pkt-line 的长度前缀固定 4 位十六进制，且**含这 4 个字节本身**（内容 N 字节 → N+4）。
    return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii"), body]);
  };
  const flush = Buffer.from("0000", "ascii");
  let pushBody = "";
  const server = httpModule.createServer((req, res) => {
    if (req.method === "GET") {
      // 远端广告：只有一个旧提交 → 客户端会真的发起推送
      // 内容类型必须与请求的服务名一致，否则对端会把它当「哑 HTTP」并报 SmartHttpError。
      res.writeHead(200, { "content-type": "application/x-git-receive-pack-advertisement" });
      res.end(Buffer.concat([pkt("# service=git-receive-pack\n"), flush, pkt(`${baseCommit} refs/heads/main\x00report-status\n`), flush]));
      return;
    }
    req.on("data", chunk => { pushBody += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
      // 响应走 side-band：外层是带 0x01（数据通道）前缀的包，**包体本身又是一条 pkt-line**。
      // 只加前缀不嵌套 pkt-line 的话，对端会把文本当长度前缀解析（NaN）并空转。
      const band = text => {
        const inner = pkt(text);
        const payload = Buffer.concat([Buffer.from([1]), inner]);
        return Buffer.concat([
          Buffer.from((payload.length + 4).toString(16).padStart(4, "0"), "ascii"),
          payload,
        ]);
      };
      res.end(Buffer.concat([band("unpack ok\n"), band("ok refs/heads/main\n"), flush]));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await git.addRemote({ fs, dir: panelDir, remote: "origin", url: `http://127.0.0.1:${server.address().port}/repo.git` });
    // 先清掉之前为比较而写的上游配置，验证「原先没有上游 → 推送后建立上游」
    await git.setConfig({ fs, dir: panelDir, path: "branch.main.remote", value: "" });
    await git.setConfig({ fs, dir: panelDir, path: "branch.main.merge", value: "" });
    const pushed = await panel.push({ workspacePath: panelDir });
    assert.equal(pushed.branchName, "main");
    assert.equal(pushed.remoteName, "origin");
    assert.equal(pushed.setUpstream, true, "原先没有上游时应建立上游");
    assert.equal(pushed.trackingBranchName, "origin/main");
    assert.ok(pushBody.length > 0, "服务端应收到推送请求体");
    assert.equal(await git.getConfig({ fs, dir: panelDir, path: "branch.main.remote" }), "origin");
    assert.equal(await git.getConfig({ fs, dir: panelDir, path: "branch.main.merge" }), "refs/heads/main");
    // 已有上游时再次推送不再声称建立上游
    const again = await panel.push({ workspacePath: panelDir });
    assert.equal(again.setUpstream, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }

  // G. 指定起点建分支：起点是提交号时分支必须落在那个提交上
  const feature = await panel.createBranchAndSwitch({ workspacePath: panelDir, branchName: "feature", startPoint: baseCommit });
  assert.equal(feature.ok, true, JSON.stringify(feature.issues));
  assert.equal((await panel.getRepositorySummary({ workspacePath: panelDir })).branchName, "feature");
  assert.equal(await git.resolveRef({ fs, dir: panelDir, ref: "HEAD" }), baseCommit, "新分支应落在指定起点上");
  const missing = await panel.createBranchAndSwitch({ workspacePath: panelDir, branchName: "bad", startPoint: "no-such-ref" });
  assert.equal(missing.ok, false);
  assert.match(missing.issues.map(issue => issue.message).join(" "), /找不到起点/);
  console.log("git-panel-smoke: PASS");
} finally {
  fs.unlinkSync(out);
}
