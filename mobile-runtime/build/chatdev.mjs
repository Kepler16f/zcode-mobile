// 本机浏览器验证的临时宿主（只在 dev 机器上跑，不进任何安装包）。
//
// 要回答的问题是："手机上那条对话链路，在真的 Chromium + 真的 dist-ui 里能不能走通"。
// 所以这里刻意不做的事比做的事更重要：
//   1. 不另打一份"验证专用 bundle"。服务的是 build/dist-ui —— 和复制进 APK assets 的那一份
//      是同一批文件。验证结果才可能迁移到手机上。
//   2. 不连任何真网关、不用任何真凭据。模型请求打到同源的 /mock/<模式>/v1，
//      端口只绑 127.0.0.1，出不了这台机器。
//   3. 不碰登录链路。UI 里那套 Provider 配置一行都不读，模型落点由页面注入
//      （entry.tsx 的 __zcodeMobileBoot 旗子），出货路径永远不会走到那儿。
//
// 三种模式对应屏幕上该看到的三种样子，够把"能对话"讲清楚：
//   ?mode=stream         正常流式回话
//   ?mode=businessError  HTTP 200 里夹业务错误（额度不足），正文必须为空 + 一条可读失败
//   ?mode=http500        网关 500，同样要报得出来
//   ?mode=notFound       网关 404 纯文本"404 page not found"：base URL 被填成完整端点时
//                        真网关就是这么回的（0.3.0 装机那条"提示 not found"的现场形状）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "dist-ui");
const port = Number(process.argv.find((a) => /^\d{4,5}$/.test(a)) ?? 8931);

const REPLY = "端侧验证：这段文字是本地 mock 网关流式回来的，没有出过这台机器。";

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// 注入的两段脚本：前一段关掉 bundle 自己的自动启动，后一段带着 mock 落点把同一份启动代码跑起来。
const PRELUDE = `<script>
  globalThis.__zcodeMobileSkipAutoBoot = true;
  // Bash 端到端判据用：?exec=1 时装一个与 Kotlin ExecBridge 回包同形的假桥（同步 JSON 字符串进出）。
  // 它跑在 bundle 之前——core 的 createNativeExecBridge 在引擎装配时读它，读到才注册 Bash。
  if (new URLSearchParams(location.search).get("exec") === "1") {
    globalThis.zcodeExec = {
      exec: (raw) => {
        const req = JSON.parse(raw);
        const cmd = String(req.command ?? "");
        const text = /zcode-bash-approved/.test(cmd) ? "zcode-bash-approved\\n" : "";
        return JSON.stringify({
          exitCode: text ? 0 : 1,
          timedOut: false,
          stdout: text,
          stderr: text ? "" : "unsupported in mock",
          pid: 4242,
          durationMs: 5,
        });
      },
    };
  }
</script>`;

const BOOT = `<script type="module">
  const q = new URLSearchParams(location.search);
  const mode = q.get("mode") || "stream";
  // 默认**不注入任何模型落点**：那样跑的才是出货那条解析链
  // （ProviderRuntime 配置 → resolveModelTarget → model-stream）。
  // 只有 ?override=1 才走 agent 侧的替换，用于跳过配置环节的快速验证。
  if (q.get("override") === "1") {
    await globalThis.__zcodeMobileBoot({
      agentModelTargets: {
        view: async () => ({
          providers: [{
            providerId: "mock-provider",
            executable: true,
            models: [{ modelId: "mock-model" }],
            config: {
              api: { type: "openai-chat-completions", baseUrl: "/mock/" + mode + "/v1" },
              access: { type: "personal-api-key", apiKey: "sk-chatdev" },
            },
          }],
          preferredSelection: { providerId: "mock-provider", modelId: "mock-model" },
        }),
      },
    });
  } else {
    await globalThis.__zcodeMobileBoot({});
  }
</script>`;

function devHtml() {
  const raw = fs.readFileSync(path.join(distDir, "ui.html"), "utf8");
  const entryTag = '<script type="module" src="./entry.js">';
  if (!raw.includes(entryTag)) throw new Error("dist-ui/ui.html 里找不到 entry.js 那段 script，注入点变了");
  return raw.replace(entryTag, `${PRELUDE}\n    ${entryTag}`).replace("</body>", `  ${BOOT}\n  </body>`);
}

// 每次模型请求都记下来：harness 要靠它判断"第二句有没有带上历史"。
const requestLog = [];

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function handleMock(req, res, mode) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // 解析不了照样记一条，让页面能看到"发出去的是什么"
    }
    requestLog.push({ at: Date.now(), mode, messages: body.messages ?? null, model: body.model ?? null });
    if (requestLog.length > 60) requestLog.splice(0, requestLog.length - 60);
    // 用 res 的 close：req 在请求体读完就 close，把它当"客户端挂断"会让 mock 自己先取消。
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    if (mode === "http500") {
      res.writeHead(500, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: { message: "网关 500：模型服务不可用" } }));
      return;
    }
    if (mode === "notFound") {
      // 刻意用 text/plain 且没有 JSON 载荷：这类 404 没有任何"错误信息"可解析，
      // 屏幕上能依靠的只有请求地址本身。
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" });
      res.end("404 page not found\n");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
    });
    if (mode === "businessError") {
      sseChunk(res, { success: false, providerCode: 50001, message: "套餐额度不足，请换一个模型" });
      sseChunk(res, "[DONE]");
      res.end();
      return;
    }
    // 0.9.0子代理E2E：父请求发真实Agent调用，子请求输出长文本，最后父轮正常收口。
    const childRequest = body.messages?.some(m=>m.role==="system" && String(m.content).includes("You are a subagent;"));
    if (mode === "subagent" && !childRequest && !body.messages?.some(m=>m.role==="tool")) {
      sseChunk(res,{id:"parent-agent",choices:[{index:0,delta:{tool_calls:[{index:0,id:"agent-e2e",type:"function",function:{name:"Agent",arguments:JSON.stringify({subagent_type:"general-purpose",description:"检查流畅度",prompt:"输出长篇检查报告"})}}]},finish_reason:null}]});
      sseChunk(res,{id:"parent-agent",choices:[{index:0,delta:{},finish_reason:"tool_calls"}]});
      sseChunk(res,"[DONE]");res.end();return;
    }
    // 工具循环模式：按请求里已有的 tool 结果数决定这一步回什么。判据的关键是
    // "没声明 tools 就退回普通流" —— 若引擎没加载（core 动态 import 失败），请求体没有 tools，
    // mock 就不会发 tool_calls，e2e 的"有工具行 / 引擎就绪"判据当场失败，绝不假通过。
    if (mode === "tool") {
      const declared = Array.isArray(body.tools) && body.tools.length > 0;
      const toolResults = Array.isArray(body.messages)
        ? body.messages.filter((m) => m && m.role === "tool").length
        : 0;
      // 写到会话的工作区**里面**：agent 的 FileSystemPort 以 workspacePath 为越界闸，
      // 上一版写 /work/.zcode/… 被如实拒（"路径越出授权工作区"）——那是沙箱在起作用，不是循环的 bug。
      // 从请求的 system prompt 里取端侧报给模型的 workspace 路径（"Workspace path on device: <p>"），
      // 让 mock 用与会话一致的落点；取不到就退回 default 工作区。
      const systemText = Array.isArray(body.messages)
        ? body.messages.filter((m) => m && m.role === "system").map((m) => String(m.content ?? "")).join("\n")
        : "";
      const wsMatch = /Workspace path on device:\s*(\S+)/.exec(systemText);
      const ws = wsMatch ? wsMatch[1].replace(/\/+$/, "") : "/work/.zcode/workspace/default";
      const FILE = `${ws}/tool-smoke.txt`;
      const toolCallChunk = (name, args) => {
        sseChunk(res, {
          id: "chatcmpl-tool", object: "chat.completion.chunk", created: 1, model: "mock-model",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${toolResults}_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
        });
        sseChunk(res, {
          id: "chatcmpl-tool", object: "chat.completion.chunk", created: 1, model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        });
        sseChunk(res, "[DONE]");
        res.end();
      };
      if (!declared) {
        // 引擎没声明工具：如实发普通文本，让上层判据失败（而不是永不收敛）。
        sseChunk(res, { id: "chatcmpl-tool", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { content: "（未声明工具）" }, finish_reason: "stop" }] });
        sseChunk(res, "[DONE]");
        res.end();
        return;
      }
      // 步序按"已回传的结果数"推进。三档子流程：
      //  老 tool 档（无 Bash）：Write→Read→收口（hit=wOk&&rOk，判据不变）。
      //  exec 档（声明 Bash+Delete，0.4.8 起 Delete 与 Bash 同闸注册）：
      //    Bash→Write→Delete→Write→Delete→收口（hit=wOk&&delOk；bashOk 单独报）。
      //    第二次 Delete **没有弹窗还回"已删除"** —— 那是审批"始终允许"记忆生效的显式证据。
      //  0.4.7 exec 档的老四步（Bash→Write→Read）只在"有 Bash 没 Delete"的引擎上走（当前不存在）。
      const bashFlow = body.tools.some((t) => t.function?.name === "Bash");
      const deleteFlow = bashFlow && body.tools.some((t) => t.function?.name === "Delete");
      if (toolResults === 0) {
        if (bashFlow) return toolCallChunk("Bash", { command: "echo zcode-bash-approved" });
        return toolCallChunk("Write", { file_path: FILE, content: "zcode-tool-loop-ok" });
      }
      if (toolResults === 1) {
        if (bashFlow) return toolCallChunk("Write", { file_path: FILE, content: "zcode-tool-loop-ok" });
        return toolCallChunk("Read", { file_path: FILE });
      }
      if (toolResults === 2) {
        if (deleteFlow) return toolCallChunk("Delete", { path: FILE });
        if (bashFlow) return toolCallChunk("Read", { file_path: FILE });
      }
      if (toolResults === 3 && deleteFlow) return toolCallChunk("Write", { file_path: FILE, content: "zcode-tool-loop-ok-2" });
      if (toolResults === 4 && deleteFlow) return toolCallChunk("Delete", { path: FILE });
      // 收口。判据按**内容**认领而不是按位置（子流程消息数不同）：
      //  bashOk：Bash 的 stdout 含 marker —— 真经审批后由执行端口跑出（桌面是假桥，设备是真 toybox）。
      //  wOk：Write 返回含 marker —— 真写进了 vfs。
      //  rOk：Read 返回里带这个文件名（file_unchanged 是 Read 对"刚写过"的如实语义，能读到状态才算真执行）。
      //  delOk：两份 Delete 都回"已删除"（第二份无弹窗仍执行 ⇒ 始终允许记忆生效）。
      const toolMsgs = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m && m.role === "tool");
      const allRaw = toolMsgs.map((m) => String(m.content ?? "")).join(" | ");
      const squeeze = (x) => String(x).replace(/\s+/g, " ").slice(0, 1200);
      const bashOk = allRaw.includes("zcode-bash-approved");
      const wOk = allRaw.includes("zcode-tool-loop-ok");
      const rOk = allRaw.includes("tool-smoke.txt");
      const delOk = (allRaw.match(/已删除/g) ?? []).length >= 2;
      const hit = deleteFlow ? wOk && delOk : wOk && rOk;
      sseChunk(res, { id: "chatcmpl-tool", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { content: `工具自检完成 hit=${hit} bash=${bashOk} delete=${delOk} raw=${squeeze(allRaw)}` }, finish_reason: null }] });
      sseChunk(res, { id: "chatcmpl-tool", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } });
      sseChunk(res, "[DONE]");
      res.end();
      return;
    }
    const pieces = mode === "subagent" && childRequest
      ? ["\n\n```typescript\nconst answer: number = 42;\n```\n\n$$\\frac{x^2}{2}+\\sqrt{y}$$\n\n",...Array.from({length:120},(_,i)=>`\n\n第${i+1}项检查：${"子代理长文本与抽屉交互验证。".repeat(12)}`)]
      : [...REPLY];
    let i = 0;
    const push = () => {
      if (abort.signal.aborted) return;
      if (i < pieces.length) {
        sseChunk(res, {
          id: "chatcmpl-chatdev",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, delta: { content: pieces[i] }, finish_reason: null }],
        });
        i += 1;
        setTimeout(push, 45);
        return;
      }
      sseChunk(res, {
        id: "chatcmpl-chatdev",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 24, completion_tokens: pieces.length, total_tokens: 24 + pieces.length },
      });
      sseChunk(res, "[DONE]");
      res.end();
    };
    push();
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const mockMatch = /^\/mock\/([A-Za-z0-9_-]+)\/v1\/(chat\/completions|messages|responses)$/.exec(url.pathname);
  res.setHeader("access-control-allow-origin", "*");
  if (mockMatch && req.method === "OPTIONS") {
    res.setHeader("access-control-allow-headers", "content-type,authorization,x-api-key,anthropic-version");
    res.setHeader("access-control-allow-methods", "POST,OPTIONS");
    res.end();
    return;
  }
  if (mockMatch && req.method === "POST") {
    handleMock(req, res, mockMatch[1]);
    return;
  }
  if (url.pathname === "/mock-log") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(requestLog));
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === "/" || url.pathname === "/dev.html") {
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
    res.end(devHtml());
    return;
  }
  // 工具引擎的 core bundle：设备相对路径 `../mobile/dist/zcode-core.mobile.js`（相对 assets/ui/entry.js）
  // 落在 assets/mobile/dist/ 下——那是 copyMobileRuntime 本来就打进包的自检产物，UI 复用它、零新增字节。
  // 桌面 entry.js 在 web 根，同一条相对路径解析成 /mobile/dist/zcode-core.mobile.js，这条路由把它
  // 指回 build/dist 的真身——**桌面与设备走的是同一个相对 URL**，e2e 验的不是"另一条能通的路"。
  if (url.pathname === "/mobile/dist/zcode-core.mobile.js") {
    const core = path.join(here, "dist", "zcode-core.mobile.js");
    if (!fs.existsSync(core)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("404 core bundle 未构建（先跑 build/bundle.mjs）");
      return;
    }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    fs.createReadStream(core).pipe(res);
    return;
  }
  // 静态：只允许 dist-ui 之内的路径（越界的 .. 直接落到 404，不去猜调用方想读什么）。
  const file = path.resolve(distDir, "." + decodeURIComponent(url.pathname));
  if (!file.startsWith(distDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`404 ${url.pathname}`);
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
});

/**
 * 起宿主。端到端脚本把它和浏览器放在**同一个进程**里跑：跨进程起的那份，
 * 会在两次工具调用之间被回收，于是下一轮 e2e 只能看到 ERR_CONNECTION_REFUSED。
 * 端口占用当"已有宿主"处理，让直接 `node chatdev.mjs 8977` 起着的开发宿主也能复用。
 */
export function startChatdev(listenPort = port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () =>
      resolve({ server, port: listenPort, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startChatdev().then(
    () =>
      process.stdout.write(
        `chatdev: http://127.0.0.1:${port}/?mode=stream  （服务 ${path.relative(here, distDir)}，mock 只在本机）\n`,
      ),
    (e) => {
      process.stdout.write(`chatdev 起不来：${String(e?.message ?? e)}\n`);
      process.exit(1);
    },
  );
}
