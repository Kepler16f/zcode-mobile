import type { IHooksService } from "@zcode/services";

export function createMobileHooksService(base: IHooksService, canExecute: () => boolean): IHooksService {
  function assertAvailable() {
    if (!canExecute()) throw new Error("EUNSUPPORTED(mobile:hooksService): 缺少原生命令执行桥，钩子暂不可执行。");
  }
  return {
    async loadHooks(params) {
      assertAvailable();
      const result = await base.loadHooks(params);
      // 移动执行器只消费 .zcode；上游 legacy 扫描不能把未执行的钩子标成启用。
      const hooks = result.hooks.filter(hook => hook.location?.source === "zcode");
      return { ...result, hooks, hooksEnabled: hooks.some(hook => hook.enabled) };
    },
    async saveHooks(params) {
      assertAvailable();
      if (params.hooks.some(hook => hook.location && hook.location.source !== "zcode")) {
        throw new Error("移动端仅支持 .zcode 配置的钩子，无法保存 legacy 钩子。");
      }
      return base.saveHooks(params);
    },
    async grantWorkspaceHookTrust(params) {
      assertAvailable();
      if (!base.grantWorkspaceHookTrust) throw new Error("移动 Hook trust authority 尚未接入。");
      return base.grantWorkspaceHookTrust(params);
    },
  };
}
