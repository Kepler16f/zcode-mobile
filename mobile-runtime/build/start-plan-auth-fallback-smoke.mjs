// Start Plan 授权兜底链冒烟（0.11.2，对齐已装桌面 3.16.3 的 wxe 语义）：
// 装机主诉"Start Plan 查询失败"的根因之一——旧代码在 JWT（zcodejwttoken）缺失时
// 直接抛凭据不可用，整个套餐入口跟着"查询失败"。3.16.3 的行为：JWT 缺失回退到
// 套餐 apiKey（换发链）。三条判据钉死这条兜底链 + 一条"余额 401 不再炸快照"。
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync } from "node:fs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const out = path.join(root, "tmp/start-plan-auth-fallback-test.mjs");
try {
  await require("esbuild").build({
    stdin: {
      contents: `export {createAccountProviderRequestAuthService} from "@zcode/services/deep/model-provider/accountProviderRequestAuthService.js";
export {ZAI_PROVIDER_ID} from "@zcode/shared";`,
      resolveDir: root,
    },
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "warning",
    banner: { js: 'import {createRequire as _c} from "node:module";const require=_c(import.meta.url);' },
    nodePaths: ["ui", "services", "shared", "provider"]
      .map((n) => path.join(root, `zcode/packages/${n}/node_modules`))
      .concat(path.join(root, "zcode/node_modules")),
    plugins: [
      {
        name: "services-deep",
        setup(b) {
          b.onResolve({ filter: /^@zcode\/services\/deep\// }, (a) => ({
            path: path.join(
              root,
              "zcode/packages/services/src",
              a.path.slice("@zcode/services/deep/".length).replace(/\.js$/, ".ts"),
            ),
          }));
        },
      },
    ],
  });
  const { createAccountProviderRequestAuthService, ZAI_PROVIDER_ID } = await import(
    pathToFileURL(out).href
  );

  const makeService = ({ jwt, planApiKey }) => {
    const calls = { oauth: 0, planKey: 0 };
    const service = createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: async (access) => access,
      loadOAuthTokenSet: async () => {
        calls.oauth += 1;
        return jwt ? { accessToken: "oauth-token", zcodeJwtToken: jwt } : null;
      },
      loadIndividualPlanApiKey: async () => {
        calls.planKey += 1;
        return planApiKey;
      },
      resolveTeamPlanApiKey: async () => null,
    });
    return { service, calls };
  };
  const input = {
    providerId: "account:zai-start-plan",
    accountAccess: { type: "zhipu-account", family: "zai", planKind: "start-plan" },
    reason: "usage",
  };

  // ① JWT 在：直接用 JWT，不走换发链。
  {
    const { service, calls } = makeService({ jwt: "jwt-token", planApiKey: "plan-key" });
    const material = await service.resolveCurrent(input);
    assert.equal(material.apiKey, "jwt-token", "① JWT 在时必须用 JWT");
    assert.equal(calls.planKey, 0, "① JWT 在时不得调换发链");
    console.log("PASS ① JWT 在 → 用 JWT（不触发换发兜底）");
  }
  // ② JWT 缺：回退套餐 apiKey（3.16.3 语义，装机主诉的修复面）。
  {
    const { service, calls } = makeService({ jwt: null, planApiKey: "plan-key" });
    const material = await service.resolveCurrent(input);
    assert.equal(material.apiKey, "plan-key", "② JWT 缺时必须回退套餐 apiKey");
    assert.equal(calls.oauth, 1, "② 应先试过 JWT 加载");
    console.log("PASS ② JWT 缺 → 回退套餐 apiKey（不再抛凭据不可用）");
  }
  // ③ 都缺：如实抛（上层分类成 unavailable 快照），不是静默假凭据。
  {
    const { service } = makeService({ jwt: null, planApiKey: null });
    await assert.rejects(
      () => service.resolveCurrent(input),
      (e) => e.name === "AccountRequestCredentialUnavailableError",
      "③ 都缺时必须抛 AccountRequestCredentialUnavailableError",
    );
    console.log("PASS ③ 都缺 → 如实抛凭据不可用（上层分类，不造假凭据）");
  }
  console.log("Start Plan 授权兜底冒烟：3/3 PASS");
} finally {
  rmSync(out, { force: true });
}
