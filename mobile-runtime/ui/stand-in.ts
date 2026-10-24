// 端侧未实现的服务面。
// 为什么不是"空实现"：空实现会让 UI 显示"没有任务""没有模型"这种看起来正常、其实假的画面；
// 报错会让界面弹出一次明确的失败，而那正是我们要在报告和屏幕上都能看见的东西。
// 见 [[feedback-progress-must-be-visible-features]]：宁可明说没做，不要装作做了。
//
// 为什么"抛错"要做成 rejected Promise 而不是同步 throw：
// 这些面都是 RPC 客户端代理，契约上**每个方法都是异步的**（真服务端报错只可能以 rejection 回来）。
// 同步 throw 会让 UI 里那些已经写了 `.catch(...)` 的调用点照样炸穿 React 渲染
// （实测 Root.tsx:317 的 syncAppRuntimePreferences 是 fire-and-forget + catch，同步抛错时 catch 根本来不及挂），
// 首屏因此变成一个红框；改成 rejection 后同样的调用点会走它自己的告警分支，界面继续可用。
// 哪些"没接的面"真的被界面调用过：记下来。
// 为什么值得占包内一点内存：这些 rejection 十有八九被调用方的 `.catch` 吞掉，
// 屏幕上什么都不发生——而"该接哪个面"恰恰只能从"谁被调用了"看出来。
// 上限是防自己变成内存泄漏：这是个环形读数，只要最近这些。
const UNSUPPORTED_LEDGER_MAX = 64;
const unsupportedLedger = new Map<string, { count: number; at: number }>();

function recordUnsupportedCall(label: string, name: string): void {
  const key = `${label}.${name}`;
  const prev = unsupportedLedger.get(key);
  if (!prev && unsupportedLedger.size >= UNSUPPORTED_LEDGER_MAX) {
    const oldest = unsupportedLedger.keys().next().value;
    if (oldest !== undefined) unsupportedLedger.delete(oldest);
  }
  unsupportedLedger.set(key, { count: (prev?.count ?? 0) + 1, at: Date.now() });
}

/** 最近被调用过的未实现面（次数 + 最后一次时间），按最近排序。 */
export function unsupportedCalls(): Array<{ face: string; count: number; at: number }> {
  return [...unsupportedLedger.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .map(([face, v]) => ({ face, count: v.count, at: v.at }));
}

function unsupported(label: string, hint: string, name: string): Promise<never> {
  recordUnsupportedCall(label, name);
  return Promise.reject(new Error(`EUNSUPPORTED(${label}): ${name} —— ${hint}`));
}

/**
 * "这里永远没有事件"的那个面：一个自返回、自带 dispose 的函数。
 * 仓库里有两种事件写法，`onDidX(listener) -> disposable` 与 `onX() -> (listener) -> disposable`
 * （实测 windowControllerService.onDynamicControllerFrame、transport.onDynamicLocalTtftFacts），
 * 只满足一种就会在别人的代码里变成 "y is not a function"；这一种同时满足两种。
 */
const noEvent: () => unknown = () => noEvent;
(noEvent as { dispose?: () => void }).dispose = () => {};

/** 调用即失败的面。用于 UI accessor 上还没接到端侧运行时的 channel。 */
export function notSupported<T>(label: string, hint = "端侧还没接这个服务面"): T {
  // 目标对象只是 Proxy 协议要求的占位（get 全靠 handler），所以形状在这里"就是"T：
  // 这句 as 是这一格的定义本身，不是用来盖住某个没想清楚的地方。
  return new Proxy({} as Record<string, never>, {
    get(_t, key) {
      if (typeof key === "symbol") return undefined;
      return () => unsupported(label, hint, String(key));
    },
    set() {
      throw new Error(`EUNSUPPORTED(${label}): 不允许写入属性`);
    },
    has() {
      return true;
    },
  }) as unknown as T;
}

/**
 * 给"上游工厂在构造时会顺手订阅一下"的位置用的（例如任务/会话适配器的 agent）。
 * 与 notSupported 的差别只有一条：事件注册类成员返回一个"能取消、但什么都不收"的面。
 * 否则构造阶段就炸，整个组合根起不来，也就看不到任何屏幕；而真正的功能调用照样失败。
 *
 * 事件面为什么要长成"可以无限调用、自带 dispose"的形状：这个仓库里有两种事件写法，
 *   `onDidX(listener) -> disposable`（注册即订阅）
 *   `onX() -> (listener) -> disposable`（先拿 Event 再订阅，实测 windowControllerService.onDynamicControllerFrame）
 * 返回只满足一种的对象，另一种就在别人的代码里变成 "y is not a function"。
 * 一个自返回、带 dispose 的函数同时满足两种，而且语义都是"这里永远没有事件"。
 */
export function notSupportedDeferred<T>(label: string, hint = "端侧 Agent 运行时尚未接入"): T {
  return new Proxy({} as Record<string, never>, {
    get(_t, key) {
      if (typeof key === "symbol") return undefined;
      const name = String(key);
      if (/^(on|subscribe|once|off)/i.test(name)) {
        return () => noEvent;
      }
      if (name === "dispose" || name === "then") {
        // then 必须是 undefined：否则 `await 这个对象` 会被当成 thenable 卡住。
        return name === "then" ? undefined : () => undefined;
      }
      return () => unsupported(label, hint, name);
    },
    set() {
      throw new Error(`EUNSUPPORTED(${label}): 不允许写入属性`);
    },
    has() {
      return true;
    },
  }) as unknown as T;
}

/**
 * 把"已经实现的那几面"包起来：真实成员原样透出，其余名字换成明确报错的方法。
 *
 * 为什么真 agent 需要这层而 stub 不需要：ProxyChannel 服务端对没实现的名字回的是
 * `Method not found: listSessions`（proxy-channel.ts:94）——那是我们内部函数的名字，
 * 装机报告里读到它就是一条没有原因的红色错误。换成 `EUNSUPPORTED(...)` 之后，
 * "端侧 agent 实现了哪几面"这句话在任何一屏上都用同一种写法说话。
 *
 * 事件名要换成"永远没有事件"，不是换成抛错的方法：传输层在挂对话帧监听的那一步就会顺手订阅
 * `onDynamicLocalTtftFacts`（agentConversationTransport.ts:536），拿到的东西必须是能再调用一次的
 * 事件面；回一个 Promise 会让服务端把它当函数调用，报错点离"为什么没有 TTFT"更远。
 *
 * 只包 get，不包 has/ownKeys：`for (const key in service)` 是上游 fromService 预缓存事件用的
 * （proxy-channel.ts:54），ownKeys 撒谎会让它把没实现的名字当成事件去 buffer。
 */
export function withUnsupportedFallback<T extends object>(
  target: T,
  label: string,
  hint = "端侧 agent 只实现了 v4 对话那一面",
): T {
  return new Proxy(target, {
    get(obj, key) {
      if (typeof key === "symbol") return Reflect.get(obj, key);
      if (Reflect.has(obj, key)) return Reflect.get(obj, key);
      // then 必须是 undefined：否则 `await 这个对象` 会被当成 thenable 一路卡住。
      if (key === "then") return undefined;
      if (/^(on|subscribe|once|off)/i.test(key)) return () => noEvent;
      return () => unsupported(label, hint, key);
    },
  });
}
