// GLM 方言的 DSML 工具调用文本兜底（0.4.8，装机反馈"工具调用有时候输出 <｜｜DSML｜｜ calls> 原文"）。
//
// 现象：模型该用 tool_calls JSON 的时候，偶尔把调用写成 DSML 标记文本（GLM 系的函数调用
// 训练格式）。上游 core/model-stream 只认 OpenAI 形状的 choices[].delta.tool_calls，这段
// 文本就被当普通正文流进气泡——用户看到的就是那串原文，工具也不执行。
//
// 这里做**收口处的兜底**（agent.runTurn 拿到完整正文后）：正文里检出 DSML 块就解析成
// 工具调用，走与 tool_calls 完全同一条执行循环。不做流式逐帧解析——DSML 块跨 SSE 帧
// 分片，逐帧状态机复杂且收益只有"早一拍执行"；收口解析对非流式/流式两种网关都成立。
//
// 格式（半角原样；用户贴屏的"｜｜"是输入法转的全角 U+FF5C，先归一再解析）：
//   <|DSML|>calls
//   <|DSML|>invoke name="list_files"
//   <|DSML|>parameter name="path" string="true"
//   /mnt/tree
//   <|DSML|>/parameter
//   <|DSML|>/invoke
//   <|DSML|>/calls
// parameter 的值：string="true" 按字符串原值；否则先试 JSON.parse（数字/布尔/嵌套），
// 失败退字符串。多个 invoke 并列时全部解析。
// 解析出零个调用、或任何块残缺（有 invoke 没闭合）都返回 null —— 宁可按普通正文处理，
// 也不把半个调用喂给执行器。

export interface DsmlCall {
  id: string;
  name: string;
  /** 与 tool_calls 的 arguments 同形状：JSON 字符串。 */
  arguments: string;
}

export interface DsmlParseResult {
  calls: DsmlCall[];
  /** 去掉整个 calls 块后的正文（前后空白裁掉；空则空串）。 */
  rest: string;
}

const DSML_TAG = "<|DSML|>";

/**
 * 归一：① 全角竖线（U+FF5C，用户贴屏被输入法转过的）→ 半角；② 双竖线形态 `||DSML||`
 * （装机实测模型就这么吐的）→ 单竖线；③ HTML 风格标签（`<|DSML| calls>` 开、
 * `</|DSML| calls>` 闭——装机现场形态）→ 统一成 `<|DSML|>calls` / `<|DSML|>/calls`。
 * 官方单竖线 + 尖括号内斜杠的形态（`<|DSML|>calls`…`<|DSML|>/calls`）归一后原样通过。
 */
function normalize(text: string): string {
  return text
    .replaceAll("｜", "|")
    .replaceAll("||DSML||", "|DSML|")
    // 闭合标签（HTML 风格，斜杠在头）→ 统一 <|DSML|>/xxx
    .replace(/<\/\|DSML\|\s*(calls|invoke|parameter)\s*>/gu, "<|DSML|>/$1")
    // 开标签（带属性或裸名，尾上有 >）→ 统一 <|DSML|>xxx 属性…（去标签名与属性间的空格、去尾 >）
    .replace(/<\|DSML\|\s*(calls|invoke|parameter)\s*([^>]*?)\s*>/gu, (_m, tag, attrs) =>
      `<|DSML|>${tag}${attrs ? ` ${attrs}` : ""}`);
}

export function parseDsmlCalls(rawText: string): DsmlParseResult | null {
  if (!rawText) return null;
  const text = normalize(rawText);
  // 检测在归一之后：装机原文可能是全角竖线/双竖线形态，直接 includes 半角标记会漏判。
  if (!text.includes(DSML_TAG)) return null;
  // 只认成对的 calls 块；块外的 <|DSML|> 碎片（模型闲聊提这个词）不动。
  // 闭合标签的尾 `>` 可选：官方形态带（<|DSML|>/calls>），装机形态经归一后不带。
  const blockRe = /<\|DSML\|>calls([\s\S]*?)<\|DSML\|>\/calls>?/u;
  const block = blockRe.exec(text);
  if (!block) return null;
  const calls: DsmlCall[] = [];
  const invokeRe = /<\|DSML\|>invoke name="([^"]+)"([\s\S]*?)(?:<\|DSML\|>\/invoke>?|$)/gu;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(block[1] ?? "")) !== null) {
    const name = m[1];
    if (!name) continue;
    const args: Record<string, unknown> = {};
    const paramRe = /<\|DSML\|>parameter name="([^"]+)"(?:\s+string="(true|false)")?\s*\n?([\s\S]*?)<\|DSML\|>\/parameter>?/gu;
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(m[2] ?? "")) !== null) {
      const key = p[1];
      if (!key) continue;
      const value = (p[3] ?? "").trim();
      if (p[2] === "true") {
        // 显式 string：值就是字符串原值（路径、查询词这类）。
        args[key] = value;
      } else {
        // 没标 string：先按 JSON 值试（数字/布尔/嵌套），失败退字符串——
        // 工具入参的 zod schema 对 number/boolean 收到字符串会拒，这里尽量保类型。
        try {
          args[key] = JSON.parse(value);
        } catch {
          args[key] = value;
        }
      }
    }
    calls.push({
      id: `dsml-${calls.length}-${Date.now().toString(36)}`,
      name,
      arguments: JSON.stringify(args),
    });
  }
  if (calls.length === 0) return null;
  const rest = text.replace(blockRe, "").trim();
  return { calls, rest };
}
