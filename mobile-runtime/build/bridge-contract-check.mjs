import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const ktDir = resolve(repoRoot, "android-app/app/src/main/kotlin/cn/zcode/mobile");
const contractPath = resolve(repoRoot, "mobile-runtime/bridge-contract.yaml");

function stripComments(src, blankStringContent = false) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const nxt = src[i + 1];
    if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      out += '"""';
      i += 3;
      while (i < src.length && !(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) {
        out += blankStringContent ? (src[i] === "\n" ? "\n" : " ") : src[i];
        i++;
      }
      if (i < src.length) { out += '"""'; i += 3; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      out += ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\" && i + 1 < src.length) {
          out += blankStringContent ? "  " : src[i] + src[i + 1];
          i += 2;
          continue;
        }
        const c = src[i];
        out += c === q ? c : (blankStringContent ? " " : c);
        if (c === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "/" && nxt === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (ch === "/" && nxt === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) { out += "  "; i += 2; }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function unquote(v) {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * 解析 bridge-contract.yaml（结构固定的缩进 YAML，零外部依赖）。
 * 支持 Top-level sections（bridges / innerShims / callbacks）、4 格属性与 methods 子映射。
 */
function parseContractYaml(text) {
  const doc = { bridges: {}, innerShims: {}, callbacks: {} };
  let section = null;
  let entry = null;
  let inMethods = false;
  let method = null;
  let listTarget = null;

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)[0].length;
    const line = rawLine.trim();

    if (indent === 0) {
      const m = line.match(/^([A-Za-z_]\w*):\s*(.*)$/);
      assert.ok(m, `YAML 顶层格式无法识别: ${rawLine}`);
      section = m[1];
      entry = null;
      inMethods = false;
      method = null;
      listTarget = null;
      if (!["version", "description"].includes(section) && !doc[section]) doc[section] = {};
      continue;
    }

    if (!section || ["version", "description"].includes(section)) continue;

    if (indent === 2) {
      const m = line.match(/^([A-Za-z_]\w*):\s*$/);
      assert.ok(m, `YAML 条目名格式无效 (${section}): ${rawLine}`);
      entry = { methods: {}, consumers: [] };
      doc[section][m[1]] = entry;
      inMethods = false;
      method = null;
      listTarget = null;
      continue;
    }

    if (indent === 4 && entry) {
      if (line === "methods:") {
        inMethods = true;
        method = null;
        listTarget = null;
        continue;
      }
      if (line === "consumers:") {
        inMethods = false;
        method = null;
        listTarget = entry.consumers;
        continue;
      }
      const m = line.match(/^([A-Za-z_]\w*):\s*(.*)$/);
      assert.ok(m, `YAML 属性格式无效: ${rawLine}`);
      inMethods = false;
      method = null;
      listTarget = null;
      entry[m[1]] = unquote(m[2]);
      continue;
    }

    if (indent === 6) {
      if (listTarget && line.startsWith("- ")) {
        listTarget.push(unquote(line.slice(2)));
        continue;
      }
      if (inMethods) {
        const m = line.match(/^([A-Za-z_]\w*):\s*$/);
        assert.ok(m, `YAML methods 条目格式无效: ${rawLine}`);
        method = {};
        entry.methods[m[1]] = method;
        continue;
      }
    }

    if (indent === 8 && inMethods && method) {
      const m = line.match(/^([A-Za-z_]\w*):\s*(.*)$/);
      assert.ok(m, `YAML method 字段无效: ${rawLine}`);
      method[m[1]] = m[1] === "arity" ? Number(m[2]) : unquote(m[2]);
    }
  }
  return doc;
}

function extractMainBindings(mainKt) {
  const clean = stripComments(mainKt);
  const bindings = new Map();
  // 识别 val/var 显式类型、构造函数初始化、by lazy { Type(...) } 以及 onCreate 内赋值。
  const varTypes = new Map();
  for (const m of clean.matchAll(/\b(?:val|var)\s+(\w+)\s*:\s*([A-Z]\w*)\??/g)) {
    varTypes.set(m[1], m[2]);
  }
  for (const m of clean.matchAll(/\b(\w+)\s*(?:=|by\s+lazy\s*\{)\s*([A-Z]\w*)\s*\(/g)) {
    varTypes.set(m[1], m[2]);
  }
  for (const m of clean.matchAll(/\baddJavascriptInterface\(\s*([^,]+?)\s*,\s*"(zcode\w+)"\s*\)/g)) {
    const expr = m[1].trim().replace(/!!$/, "");
    const ctor = expr.match(/^([A-Z]\w*)\s*\(/);
    const cls = ctor ? ctor[1] : varTypes.get(expr) ?? expr;
    if (!bindings.has(m[2])) bindings.set(m[2], cls);
  }
  return bindings;
}

function countKotlinParams(paramStr) {
  const s = paramStr.trim();
  if (!s) return 0;
  let depth = 0;
  let count = 1;
  for (const ch of s) {
    if (ch === "<" || ch === "(") depth++;
    else if (ch === ">" || ch === ")") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

function extractKotlinMethodsByClass() {
  const methodsByClass = new Map();
  for (const f of readdirSync(ktDir).filter(x => x.endsWith(".kt")).sort()) {
    const clean = stripComments(readFileSync(resolve(ktDir, f), "utf8"), true);
    const lines = clean.split(/\r?\n/);
    let depth = 0;
    const classStack = [];
    let pendingClass = null;
    let pendingParenDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const cm = line.match(/^\s*(?:(?:inner|internal|private|public|open|abstract|final)\s+)*class\s+([A-Z]\w*)\b/);
      if (cm) {
        pendingClass = cm[1];
        pendingParenDepth = 0;
      }
      if (line.includes("@JavascriptInterface")) {
        let sig = "";
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          sig += " " + lines[j].trim();
          if (lines[j].includes("fun ")) {
            const m = sig.match(/fun\s+(\w+)\s*\(([^)]*)\)/);
            const owner = classStack.length ? classStack[classStack.length - 1].name : pendingClass;
            assert.ok(owner, `无法识别 @JavascriptInterface 所属类 (${f}:${j + 1})`);
            if (m) {
              if (!methodsByClass.has(owner)) methodsByClass.set(owner, new Map());
              methodsByClass.get(owner).set(m[1], {
                arity: countKotlinParams(m[2]),
                file: `android-app/app/src/main/kotlin/cn/zcode/mobile/${f}`,
                line: j + 1,
              });
            }
            break;
          }
        }
      }
      for (const ch of line) {
        if (pendingClass) {
          if (ch === "(") pendingParenDepth++;
          else if (ch === ")" && pendingParenDepth > 0) pendingParenDepth--;
        }
        if (ch === "{") {
          depth++;
          if (pendingClass && pendingParenDepth === 0) {
            classStack.push({ name: pendingClass, depth });
            pendingClass = null;
          }
        } else if (ch === "}") {
          while (classStack.length && classStack[classStack.length - 1].depth === depth) {
            classStack.pop();
          }
          depth--;
        }
      }
    }
  }
  return methodsByClass;
}

function collectJsBridgeReferences(validGlobals) {
  const roots = [
    resolve(repoRoot, "mobile-runtime/compat"),
    resolve(repoRoot, "mobile-runtime/ports"),
    resolve(repoRoot, "mobile-runtime/ui"),
    resolve(repoRoot, "zcode/packages/ui/src"),
  ];
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = resolve(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(mjs|js|ts|tsx)$/.test(name)) files.push(p);
    }
  };
  for (const r of roots) walk(r);

  const refs = [];
  const ignoreProps = new Set(["apply", "bind", "toString", "valueOf"]);
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"));
    const rel = relative(repoRoot, f).replace(/\\/g, "/");
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i];
      for (const gm of code.matchAll(/\b(?:globalThis|window|self)\??\.(zcode[A-Z]\w*|ZCodeCaptchaBridge)\b/g)) {
        assert.ok(validGlobals.has(gm[1]), `JS 访问了未在 bridge-contract.yaml 声明的原生桥全局 ${gm[1]} (${rel}:${i + 1})`);
      }
      for (const m of code.matchAll(/\b(zcode[A-Z]\w*|ZCodeCaptchaBridge)\??\.([A-Za-z_]\w*)\b/g)) {
        const [, globalName, member] = m;
        if (!validGlobals.has(globalName) || ignoreProps.has(member)) continue;
        refs.push({ file: rel, line: i + 1, globalName, member });
      }
    }
  }
  return refs;
}

// 执行双向校验
const contract = parseContractYaml(readFileSync(contractPath, "utf8"));
const mainBindings = extractMainBindings(readFileSync(resolve(ktDir, "MainActivity.kt"), "utf8"));
const browserClean = stripComments(readFileSync(resolve(ktDir, "BrowserBridge.kt"), "utf8"));
const innerBindings = new Map();
for (const m of browserClean.matchAll(/addJavascriptInterface\(\s*([A-Z]\w*)\s*\(\)\s*,\s*"(\w+)"\s*\)/g)) {
  innerBindings.set(m[2], m[1]);
}
const ktMethods = extractKotlinMethodsByClass();

// 1. MainActivity <-> bridge-contract.yaml bridges 双向一致性
for (const [globalName, ktClass] of mainBindings) {
  const spec = contract.bridges[globalName];
  assert.ok(spec, `Kotlin MainActivity 注册了 ${globalName} (${ktClass})，但 bridge-contract.yaml 缺少它`);
  assert.equal(spec.kotlinClass, ktClass, `${globalName} 的 kotlinClass 不一致`);
}
for (const [globalName, spec] of Object.entries(contract.bridges)) {
  assert.ok(mainBindings.has(globalName), `bridge-contract.yaml 声明了 ${globalName} (${spec.kotlinClass})，但 MainActivity 未注册`);
}

// 2. BrowserActivity inner shims <-> bridge-contract.yaml innerShims 双向一致性
for (const [globalName, ktClass] of innerBindings) {
  const spec = contract.innerShims[globalName];
  assert.ok(spec, `BrowserActivity 注册了内部垫片 ${globalName} (${ktClass})，但 bridge-contract.yaml 缺少它`);
  assert.equal(spec.kotlinClass, ktClass, `${globalName} kotlinClass 不一致`);
}
for (const [globalName, spec] of Object.entries(contract.innerShims)) {
  assert.ok(innerBindings.has(globalName), `bridge-contract.yaml 声明了 innerShim ${globalName} (${spec.kotlinClass})，但 BrowserActivity 未注册`);
}

// 3. 每个桥的 Kotlin @JavascriptInterface 方法集 & arity <-> bridge-contract.yaml 双向一致性
const allDeclared = { ...contract.bridges, ...contract.innerShims };
let totalMethods = 0;
for (const [globalName, spec] of Object.entries(allDeclared)) {
  const actual = ktMethods.get(spec.kotlinClass) ?? new Map();
  const documented = spec.methods ?? {};
  for (const [methodName, info] of actual) {
    assert.ok(documented[methodName], `${globalName} (${spec.kotlinClass}) 新增了方法 ${methodName}() 但契约未记录`);
    assert.equal(
      documented[methodName].arity,
      info.arity,
      `${globalName}.${methodName} 参数个数漂移: 契约=${documented[methodName].arity}, Kotlin=${info.arity}`,
    );
  }
  for (const methodName of Object.keys(documented)) {
    assert.ok(actual.has(methodName), `bridge-contract.yaml 声明了 ${globalName}.${methodName}，但 Kotlin ${spec.kotlinClass} 没有该方法`);
    totalMethods++;
  }
}

// 4. JS 调用点检查：所有 zcode*.method 必须存在于契约中
const validGlobals = new Set(Object.keys(allDeclared));
const refs = collectJsBridgeReferences(validGlobals);
for (const ref of refs) {
  const spec = allDeclared[ref.globalName];
  assert.ok(
    spec?.methods?.[ref.member],
    `JS 调用了未在 ${ref.globalName} 契约中声明的方法 ${ref.globalName}.${ref.member} (${ref.file}:${ref.line})`,
  );
}

// 5. callbacks 原生 emitter <-> 消费侧校验
const ktSources = readdirSync(ktDir).filter(x => x.endsWith(".kt")).map(x => stripComments(readFileSync(resolve(ktDir, x), "utf8"))).join("\n");
for (const [cbName, cbSpec] of Object.entries(contract.callbacks)) {
  assert.ok(ktSources.includes(cbName), `bridge-contract.yaml 声明了回调 ${cbName}，但 Kotlin 未触发它`);
  assert.ok(cbSpec.consumer, `callback ${cbName} 缺少 consumer`);
  const consumerText = readFileSync(resolve(repoRoot, cbSpec.consumer), "utf8");
  assert.ok(consumerText.includes(cbName), `callback ${cbName} 的 consumer (${cbSpec.consumer}) 未引用它`);
}

console.log(
  `bridge-contract-check: PASS (${Object.keys(contract.bridges).length} 主桥, ${Object.keys(contract.innerShims).length} 子页垫片, ${totalMethods} 方法, ${Object.keys(contract.callbacks).length} 回调, ${refs.length} JS 调用点全部一致)`,
);
