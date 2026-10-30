#!/usr/bin/env node
// zod(v4) → Dart 协议代码生成器（P0 PoC）。
//
// 真相源：zcode/packages/shared/dist/zcode-protocol-v4/index.js（上游编译产物）。
// 策略：不做 zod 内部 API 内省，统一先过官方 z.toJSONSchema()，再按 JSON Schema
// 生成 Dart 数据类。生成器只耦合 JSON Schema 这一个稳定面（docs/flutter-rewrite-plan.md §1 替换件 B）。
//
// 用法（在 D:\Zcode 仓库根执行）：
//   node flutter-app/tool/zod2dart/generate.mjs            # 生成 lib/protocol/generated/protocol_v4.dart + REPORT.md
//   node flutter-app/tool/zod2dart/generate.mjs --check    # 只打印覆盖率报告，不落盘
//
// 覆盖率纪律（计划 §2 验收判据 1）：每个导出 *Schema 都必须出现在
// generated / unsupported 两个桶之一；unsupported 必须有原因。
// 生成物纪律：只做形状映射，不做运行时校验——校验权威在内核；
// 可选字段在 Dart 侧一律表示为可空类型（"可能缺席"的最诚实表达）。

import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(REPO_ROOT, "flutter-app", "lib", "protocol", "generated", "protocol_v4.dart");
const REPORT_FILE = path.join(REPO_ROOT, "flutter-app", "tool", "zod2dart", "REPORT.md");
const BUNDLE_FILE = path.join(TOOL_DIR, "schema-bundle.generated.mjs");

// esbuild 与 zod 都取自上游仓库的依赖树（zcode/node_modules），生成器自身零 npm 依赖
const upstreamRequire = createRequire(path.join(REPO_ROOT, "zcode", "packages", "shared", "package.json"));
const esbuild = upstreamRequire("esbuild");

// 协议模块加载：schema-entry.mjs（协议 TS 源 + zod）打包成自包含 ESM 再动态 import。
// 不能直接 import dist——dist 的依赖链会进 TS 源码目录，Node 的类型剥离不做 .js→.ts 重写。
async function loadProtocolModule() {
  await esbuild.build({
    entryPoints: [path.join(TOOL_DIR, "schema-entry.mjs")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: BUNDLE_FILE,
    logLevel: "silent",
    // 裸导入（zod 等）在上游仓库的依赖树里解析，而不是 flutter-app（无 npm 树）
    nodePaths: [path.join(REPO_ROOT, "zcode", "node_modules")],
  });
  try {
    return await import(pathToFileURL(BUNDLE_FILE).href);
  } finally {
    fs.rmSync(BUNDLE_FILE, { force: true });
  }
}

// ---------- Dart 命名 ----------

const DART_RESERVED = new Set([
  "assert", "break", "case", "catch", "class", "const", "continue", "default", "do", "else",
  "enum", "extends", "false", "final", "finally", "for", "if", "in", "is", "new", "null",
  "rethrow", "return", "super", "switch", "this", "throw", "true", "try", "var", "void",
  "while", "with", "dynamic", "int", "double", "num", "bool", "String",
]);

function pascalCase(name) {
  return name
    .replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

function dartFieldName(jsonKey) {
  let f = jsonKey.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[0-9]/.test(f)) f = "f" + f;
  if (DART_RESERVED.has(f)) f = f + "_";
  return f;
}

// JSON Schema 的 enum 值（如 "output.text"）→ 合法且不冲突的 Dart 枚举成员名
function dartEnumMembers(values) {
  const used = new Map();
  return values.map((v) => {
    let m = String(v)
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((seg, i) => (i === 0 ? seg : seg[0].toUpperCase() + seg.slice(1)))
      .join("");
    if (/^[0-9]/.test(m)) m = "v" + m;
    if (DART_RESERVED.has(m)) m = m + "_";
    const n = used.get(m) ?? 0;
    used.set(m, n + 1);
    if (n > 0) m = `${m}_${n + 1}`;
    return m;
  });
}

// ---------- JSON Schema → Dart ----------

class Unsupported extends Error {}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) throw new Unsupported(`非片段 $ref: ${ref}`);
  let node = root;
  for (const seg of ref.slice(2).split("/")) {
    node = node?.[seg.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  if (node == null) throw new Unsupported(`$ref 解析失败: ${ref}`);
  return node;
}

// 返回 { dartType, isNullable, enumValues }；enumValues 仅 string-enum 时非空
function schemaToDart(node, root, ctx) {
  if (node === true || node == null) return { dartType: "Object?" };
  if (node === false) throw new Unsupported("never schema");

  if (node.$ref) {
    const target = resolveRef(root, node.$ref);
    const name = pascalCase(node.$ref.split("/").pop());
    // ref 类延迟到收尾统一发射（同一目标可能被多次引用）
    ctx.pendingRefClasses.set(name, { node: target, root });
    let nullable = false;
    if (target && typeof target === "object" && Array.isArray(target.anyOf)) {
      nullable = target.anyOf.some((m) => m?.type === "null");
    }
    return { dartType: name, isNullable: nullable };
  }

  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const members = node.anyOf ?? node.oneOf;
    const nonNull = members.filter((m) => m !== null && m?.type !== "null" && m !== false);
    const hasNull = members.some((m) => m === null || m?.type === "null");
    const allStringLiterals = nonNull.length > 0 && nonNull.every((m) => m && !m.$ref && m.type === "string" && Array.isArray(m.enum));
    if (allStringLiterals) {
      const values = [...new Set(nonNull.flatMap((m) => m.enum))];
      return { dartType: null, isNullable: hasNull, enumValues: values };
    }
    if (nonNull.length === 1 && hasNull) {
      const inner = schemaToDart(nonNull[0], root, ctx);
      return { ...inner, isNullable: true };
    }
    throw new Unsupported(`联合类型（${members.length} 支）P0 不生成`);
  }

  // zod v4 的 toJSONSchema 把可空标量写成 type:"string,null"（逗号串）或 ["string","null"]
  if (typeof node.type === "string" && node.type.includes(",")) {
    const parts = node.type.split(",").map((s) => s.trim());
    return schemaToDart({ ...node, type: parts }, root, ctx);
  }
  if (Array.isArray(node.type)) {
    const nonNull = node.type.filter((t) => t !== "null");
    const hasNull = node.type.includes("null");
    if (nonNull.length === 1 && hasNull && !node.enum) {
      const inner = schemaToDart({ ...node, type: nonNull[0] }, root, ctx);
      if (inner.enumValues) return { ...inner, isNullable: true };
      return { dartType: inner.dartType, isNullable: true };
    }
    throw new Unsupported(`多型 type [${node.type}] P0 不生成`);
  }

  switch (node.type) {
    case "string":
      if (node.enum) return { dartType: null, enumValues: node.enum };
      return { dartType: "String" };
    case "integer":
      return { dartType: "int" };
    case "number":
      return { dartType: "num" };
    case "boolean":
      return { dartType: "bool" };
    case "array": {
      if (node.prefixItems) throw new Unsupported("tuple 数组 P0 不生成");
      const item = schemaToDart(node.items ?? true, root, ctx);
      if (item.enumValues) throw new Unsupported("enum 数组 P0 不生成");
      return { dartType: `List<${item.dartType}${item.isNullable ? "?" : ""}>` };
    }
    case "object": {
      const hasProps = node.properties && Object.keys(node.properties).length > 0;
      if (!hasProps) {
        const ap = node.additionalProperties;
        if (ap && typeof ap === "object") {
          const v = schemaToDart(ap, root, ctx);
          if (v.enumValues) throw new Unsupported("enum 值映射 P0 不生成");
          return { dartType: `Map<String, ${v.dartType}${v.isNullable ? "?" : ""}>` };
        }
        return { dartType: "Map<String, Object?>" };
      }
      const className = ctx.nextClassName();
      ctx.pendingObjects.push({ name: className, node, root });
      return { dartType: className };
    }
    default:
      throw new Unsupported(`JSON Schema type "${node.type ?? JSON.stringify(node).slice(0, 40)}"`);
  }
}

function emitEnum(name, values) {
  const members = dartEnumMembers(values);
  const lines = [
    `/// ${name}（协议 v4 字符串枚举；raw 值保持 wire 原样）`,
    `enum ${name} {`,
    ...values.map((v, i) => `  ${members[i]}('${String(v).replaceAll("'", "\\'")}'),`),
    "  ;",
    "",
    `  const ${name}(this.value);`,
    "  final String value;",
    "",
    "  String toJson() => value;",
    `  static ${name}? tryFromJson(Object? json) =>`,
    "      json is String ? values.where((e) => e.value == json).firstOrNull : null;",
    "}",
  ];
  return lines.join("\n");
}

function emitClass(name, objNode, root) {
  const props = objNode.properties ?? {};
  const required = new Set(objNode.required ?? []);
  const strict = objNode.additionalProperties === false;
  const keys = Object.keys(props).sort();

  // 先解析全部字段；不支持的字段降级为 Object?（生成必须全量——一个字段不毁掉整个导出），
  // 降级原因进 fieldLevelUnsupported，最终进 REPORT.md
  const fields = keys.map((key) => {
    const field = dartFieldName(key);
    let info;
    try {
      info = schemaToDart(props[key], root, sharedCtx);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      const reason = `字段 ${name}.${key}: ${e.message}`;
      fieldLevelUnsupported.push(reason);
      return { key, field, dartType: "Object?", isNullable: true, isEnum: false, degraded: e.message };
    }
    const isNullable = info.isNullable === true || !required.has(key);
    if (info.enumValues) {
      const ename = `${name}${pascalCase(key)}`;
      fieldLevelEnums.set(ename, info.enumValues);
      return { key, field, dartType: ename, isNullable, isEnum: true };
    }
    return { key, field, dartType: info.dartType, isNullable, isEnum: false };
  });

  const lines = [];
  lines.push(`/// ${name}（协议 v4；可选字段在 Dart 侧表示为可空）`);
  if (strict) lines.push("/// additionalProperties=false（strict）：多余键由内核校验，Dart 侧忽略");
  for (const f of fields) {
    if (f.degraded) lines.push(`/// ⚠ 字段 ${f.key} 降级为 Object?（生成器不支持：${f.degraded}）`);
  }
  lines.push(`class ${name} {`);
  for (const f of fields) {
    lines.push(`  final ${f.dartType}${f.isNullable ? "?" : ""} ${f.field};`);
  }
  lines.push("");
  lines.push(`  ${name}({`);
  for (const f of fields) {
    lines.push(f.isNullable ? `    this.${f.field},` : `    required this.${f.field},`);
  }
  lines.push("  });");
  lines.push("");

  lines.push(`  factory ${name}.fromJson(Object? json) {`);
  lines.push(`    if (json is! Map<String, Object?>) return _$invalid('${name}', json);`);
  for (const f of fields) {
    if (f.isEnum) {
      lines.push(`    final ${f.dartType}? ${f.field} = ${f.dartType}.tryFromJson(json['${f.key}']);`);
      if (!f.isNullable) lines.push(`    if (${f.field} == null) return _$invalid('${name}.${f.key}', json['${f.key}']);`);
      continue;
    }
    if (f.isNullable) {
      lines.push(`    final ${f.dartType}? ${f.field} = json['${f.key}'] == null ? null : ${castExpr(f.dartType, `json['${f.key}']`)};`);
    } else {
      lines.push(`    final ${f.dartType} ${f.field} = ${castExpr(f.dartType, `json['${f.key}']`)};`);
    }
  }
  lines.push(`    return ${name}(${fields.map((f) => `${f.field}: ${f.field}`).join(", ")});`);
  lines.push("  }");
  lines.push("");

  lines.push("  Map<String, Object?> toJson() => {");
  for (const f of fields) {
    const expr = f.isEnum ? `${f.field}.toJson()` : f.field;
    if (f.isNullable) {
      lines.push(`    if (${f.field} != null) '${f.key}': ${expr},`);
    } else {
      lines.push(`    '${f.key}': ${expr},`);
    }
  }
  lines.push("  };");
  lines.push("");
  lines.push("  @override");
  lines.push(`  bool operator ==(Object other) =>`);
  lines.push(`      identical(this, other) || other is ${name} && jsonEncode(toJson()) == jsonEncode(other.toJson());`);
  lines.push("  @override");
  lines.push("  int get hashCode => jsonEncode(toJson()).hashCode;");
  lines.push("  @override");
  lines.push(`  String toString() => '${name}(' + jsonEncode(toJson()) + ')';`);
  lines.push("}");
  return lines.join("\n");
}

// castExpr：把 dynamic 的 json 值表达式转成目标 Dart 类型的表达式
function castExpr(dartType, expr) {
  if (dartType === "String") return `${expr} as String`;
  if (dartType === "int") return `${expr} as int`;
  if (dartType === "num") return `${expr} as num`;
  if (dartType === "bool") return `${expr} as bool`;
  if (dartType === "Object?") return expr;
  if (dartType.startsWith("List<")) {
    const inner = dartType.slice(5, -1);
    if (inner === "Object?") return `(${expr} as List).cast<Object?>().toList()`;
    if (["String", "int", "num", "bool"].includes(inner)) return `(${expr} as List).cast<${inner}>().toList()`;
    if (inner === "Map<String, Object?>") return `(${expr} as List).map((e) => (e as Map).cast<String, Object?>()).toList()`;
    return `(${expr} as List).map((e) => ${castExpr(inner, "e")}).toList()`;
  }
  if (dartType.startsWith("Map<String, ")) {
    const v = dartType.slice(12, -1);
    if (v === "Object?") return `(${expr} as Map).cast<String, Object?>()`;
    if (["String", "int", "bool"].includes(v)) return `(${expr} as Map).cast<String, ${v}>()`;
    if (v === "num") return `(${expr} as Map).map((k, e) => MapEntry(k as String, e as num))`;
    return `(${expr} as Map).map((k, e) => MapEntry(k as String, ${castExpr(v, "e")}))`;
  }
  // 具名类（嵌套对象 / $ref 目标）
  return `${dartType}.fromJson(${expr})`;
}

// ---------- 主流程 ----------

// emitClass 内部要向 ctx 登记字段级枚举，用模块级变量承当（生成是单线程一次性的）
const fieldLevelEnums = new Map();
const fieldLevelUnsupported = [];
let sharedCtx = null;

async function main() {
  const checkOnly = process.argv.includes("--check");

  const mod = await loadProtocolModule();
  const z = mod.z;
  const exportNames = Object.keys(mod).filter((k) => k.endsWith("Schema")).sort();

  sharedCtx = {
    classNameSeq: 0,
    pendingObjects: [],
    pendingRefClasses: new Map(),
    nextClassName: () => {
      sharedCtx.classNameSeq += 1;
      return `_${sharedCtx.classNameSeq}Nested`;
    },
  };

  const report = { generated: [], unsupported: [] };
  let classCount = 0;
  let enumCount = 0;
  let typedefCount = 0;
  const units = []; // {key, code}

  for (const exportName of exportNames) {
    const schema = mod[exportName];
    if (!schema || typeof schema !== "object" || !("_zod" in schema)) continue;
    const base = pascalCase(exportName.replace(/Schema$/, ""));
    try {
      const js = z.toJSONSchema(schema, { io: "output" });
      if (js.type === "string" && Array.isArray(js.enum)) {
        units.push({ key: `enum:${base}`, code: emitEnum(base, js.enum) });
        enumCount++;
        report.generated.push(exportName);
        continue;
      }
      if (["string", "number", "integer", "boolean"].includes(js.type)) {
        const t = { string: "String", number: "num", integer: "int", boolean: "bool" }[js.type];
        units.push({ key: `typedef:${base}`, code: `/// ${base}（协议 v4 标量）\ntypedef ${base} = ${t};` });
        typedefCount++;
        report.generated.push(exportName);
        continue;
      }
      if (js.type === "object" && js.properties && Object.keys(js.properties).length > 0) {
        units.push({ key: `class:${base}`, code: emitClass(base, js, js) });
        classCount++;
        report.generated.push(exportName);
        continue;
      }
      report.unsupported.push({ name: exportName, reason: "顶层形状不是具名 object/enum/标量" });
    } catch (e) {
      report.unsupported.push({
        name: exportName,
        reason: e instanceof Unsupported ? e.message : `toJSONSchema 失败: ${String(e.message).slice(0, 90)}`,
      });
    }
  }

  // 收尾：内联对象类
  while (sharedCtx.pendingObjects.length > 0) {
    const { name, node, root } = sharedCtx.pendingObjects.shift();
    units.push({ key: `class:${name}`, code: emitClass(name, node, root) });
    classCount++;
  }
  // 收尾：$ref 目标类
  while (sharedCtx.pendingRefClasses.size > 0) {
    const [name, { node, root }] = [...sharedCtx.pendingRefClasses][0];
    sharedCtx.pendingRefClasses.delete(name);
    if (units.some((u) => u.key === `class:${name}`)) continue;
    try {
      units.push({ key: `class:${name}`, code: emitClass(name, node, root) });
      classCount++;
    } catch (e) {
      // ref 类失败不阻断整体；引用点会编译报错
      report.unsupported.push({ name: `$defs.${name}`, reason: `ref 类生成失败: ${String(e.message).slice(0, 80)}` });
    }
  }
  // 收尾：字段级枚举
  for (const [ename, values] of [...fieldLevelEnums].sort()) {
    units.push({ key: `enum:${ename}`, code: emitEnum(ename, values) });
    enumCount++;
  }
  // 收尾：字段级降级清单冲刷进报告（去重）
  for (const reason of [...new Set(fieldLevelUnsupported)].sort()) {
    report.unsupported.push({ name: "(字段降级→Object?)", reason });
  }
  fieldLevelUnsupported.length = 0;

  units.sort((a, b) => a.key.localeCompare(b.key));

  const coverage = `${report.generated.length}/${exportNames.length}`;
  const header = [
    "// AUTO-GENERATED —— 不要手改。改协议请改上游 schema 后重新生成。",
    "// 真相源：zcode/packages/shared/src/zcode-protocol-v4（经 dist 编译产物 + z.toJSONSchema）",
    "// 重新生成：node flutter-app/tool/zod2dart/generate.mjs",
    `// 覆盖率：generated=${coverage}（class ${classCount} / enum ${enumCount} / typedef ${typedefCount}）`,
    `// 未覆盖清单见 flutter-app/tool/zod2dart/REPORT.md（${report.unsupported.length} 项）`,
    "",
    "import 'dart:convert';",
    "",
    "// fromJson 收到非预期形状时的统一失败点（生成物不做运行时校验——校验权威在内核）",
    "Never _$invalid(String where, Object? json) {",
    "  final s = jsonEncode(json);",
    "  throw FormatException('protocol_v4 形状不符 @ $where: ${s.length > 120 ? s.substring(0, 120) : s}');",
    "}",
    "",
  ].join("\n");

  const content = header + "\n" + units.map((u) => u.code).join("\n\n") + "\n";

  const reportText = [
    "# zod2dart 覆盖率报告（`node flutter-app/tool/zod2dart/generate.mjs --check` 刷新）",
    "",
    `- 导出 *Schema 总数：${exportNames.length}`,
    `- 已生成：${report.generated.length}（class ${classCount} / enum ${enumCount} / typedef ${typedefCount}）`,
    `- 未生成：${report.unsupported.length}`,
    "",
    "## unsupported 与原因",
    "",
    ...(report.unsupported.length
      ? report.unsupported.map((u) => `- \`${u.name}\` — ${u.reason}`)
      : ["（无）"]),
    "",
    "## generated 清单",
    "",
    ...report.generated.map((g) => `- \`${g}\``),
    "",
  ].join("\n");

  if (checkOnly) {
    console.log(reportText);
    return;
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, content, "utf8");
  fs.writeFileSync(REPORT_FILE, reportText, "utf8");
  console.log(`generated=${coverage}（class ${classCount} / enum ${enumCount} / typedef ${typedefCount}）unsupported=${report.unsupported.length} -> ${path.relative(REPO_ROOT, OUT_FILE)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
