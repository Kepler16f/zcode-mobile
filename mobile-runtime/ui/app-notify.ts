// 端侧通知面：通知保活 + 出错提醒。
//
// 用户原话："有了通知权限以后你可以给出通知保活，遇到出错误也发通知提醒用户。"
//
// 分工（写在这里，免得两边各想一半）：
//   - 原生代理：真正的前台服务、常驻通知、系统通知面板全在安卓侧。它把桥挂在
//     window.zcodeNotify 上：requestPermission() / hasPermission() / notify() / setKeepAlive()。
//     本文件只负责"什么时候开、什么时候关、用户授权了没有"。
//   - JS 侧（这里）：一轮起跑 → 常驻通知开；一轮收口 → 常驻通知关；一轮失败 → 发一条
//     错误提醒（用户可能在别的界面，看不到屏幕上的气泡）。
//
// 纪律（比功能重要，三条）：
//   1. 没有桥（桌面 harness、Node 自检、还没装原生代理）＝完全静默降级：所有出口返回
//      false、一个字节都不抛。通知是锦上添花，绝不能把一轮对话搞挂。
//   2. 不主动弹权限框。权限请求只由设置页显式触发（requestNotifyPermission）——
//      每轮问一次是骚扰，系统弹窗还可能打断正在进行的对话。
//   3. 保活开关（localStorage `zcode-mobile.keepAlive`）只管"常驻通知"这一件事；
//      出错提醒不受它影响——用户原话里出错提醒是常开的。
//
// 纯 TS、零依赖：不 import 任何东西（原生桥是注入的全局，不是模块依赖）。

/** 原生代理注入的桥。四个方法缺失任意一个都按"半截桥"处理（宁可什么都不做）。 */
type NotifyBridge = {
  requestPermission?: () => string;
  hasPermission?: () => boolean;
  notify?: (id: string, title: string, text: string, ongoing: boolean) => string;
  setKeepAlive?: (enabled: boolean) => string;
};

type GlobalWithNotify = { zcodeNotify?: NotifyBridge };

/** 保活开关的持久化键："1"＝开、"0"＝关、**缺省＝关**。 */
export const KEEP_ALIVE_STORAGE_KEY = "zcode-mobile.keepAlive";
/** 开关变化广播（设置页切开关时派发，detail: { enabled: boolean }）。 */
export const KEEP_ALIVE_EVENT = "zcode-mobile:keep-alive-changed";
/** 出错提醒的固定通知 id：同一轮反复失败只更新同一条通知，不刷屏。 */
export const TURN_ERROR_NOTIFICATION_ID = "zcode-turn-error";

/** 本会话是否已经问过一次权限（问过就不再问，避免每轮骚扰）。 */
let permissionRequestedThisSession = false;
/** 常驻通知当前是不是开着（决定"关"的时候要不要真的调桥收掉）。 */
let keepAliveActive = false;
/** 事件监听是否已经挂上（模块级自动挂一次，重复调用不重复挂）。 */
let keepAliveListenerInstalled = false;

function bridge(): NotifyBridge | undefined {
  const b = (globalThis as GlobalWithNotify).zcodeNotify;
  if (!b || typeof b !== "object") return undefined;
  // 半截桥按无桥处理：桥是原生代理装的，装到一半就说明它还没准备好。
  if (typeof b.hasPermission !== "function") return undefined;
  return b;
}

/** 这台设备上有没有原生通知桥（桌面 harness / Node 自检里恒为 false）。 */
export function hasNotifyBridge(): boolean {
  return bridge() !== undefined;
}

function bridgeHasPermission(b: NotifyBridge): boolean {
  try {
    return b.hasPermission?.() === true;
  } catch {
    // 读权限失败按没权限：宁可不通知，也不冒弹权限框的风险。
    return false;
  }
}

/**
 * 桥返回值的容错解析。契约上四个方法都返回 JSON 字符串（如 {"ok":true,"granted":true}），
 * 但真机上原生代理也可能顺手返回对象或者裸值——这里都认，不因为形状不对就抛。
 */
function parseBridgeResult(raw: unknown): { ok: boolean; granted?: boolean } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw === "object") {
    const obj = raw as { ok?: unknown; granted?: unknown };
    return {
      ok: obj.ok !== false,
      ...(typeof obj.granted === "boolean" ? { granted: obj.granted } : {}),
    };
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return { ok: true };
    try {
      const parsed = JSON.parse(text) as { ok?: unknown; granted?: unknown } | null;
      return {
        ok: parsed?.ok !== false,
        ...(typeof parsed?.granted === "boolean" ? { granted: parsed.granted } : {}),
      };
    } catch {
      // 不是 JSON：当作"调用成功"（真机代理偶尔回纯文本）。
      return { ok: true };
    }
  }
  return { ok: true };
}

/** 保活开关是不是开着（缺省＝关；读不到/抛异常一律按关）。 */
export function isKeepAliveEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEEP_ALIVE_STORAGE_KEY) === "1";
  } catch {
    // 隐私模式 localStorage 会抛：读不到旗子按关（缺省即关，不猜）。
    return false;
  }
}

/**
 * 写保活开关并广播。设置页用；广播出去之后本模块会立刻把常驻通知收到对应状态。
 * 写盘失败不抛：开关写不进去时，下一轮 startTurn 那道闸会按读到的旧值走。
 */
export function setKeepAliveEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(KEEP_ALIVE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // 写不进去就当没写成：调用方拿到的是"已尽力"的结果，不是一个假成功。
  }
  dispatchKeepAliveEvent(enabled);
}

function dispatchKeepAliveEvent(enabled: boolean): void {
  try {
    const Ctor = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent;
    const event =
      typeof Ctor === "function"
        ? new Ctor(KEEP_ALIVE_EVENT, { detail: { enabled } })
        : ({ type: KEEP_ALIVE_EVENT, detail: { enabled } } as unknown as Event);
    globalThis.dispatchEvent?.(event);
  } catch {
    // 事件面失败不影响返回值：这一层只负责"让别的消费者知道"。
  }
}

/** 真去调桥开/关常驻通知（前提条件由调用方判）。返回值＝常驻通知此刻是不是开着。 */
function applyKeepAlive(enabled: boolean): boolean {
  const b = bridge();
  if (!b) return false;
  try {
    if (!enabled) {
      // 没开着就别去收：省一次跨桥调用，也让"没开过"和"开过又关了"在桥那边可区分。
      if (!keepAliveActive) return false;
      const result = parseBridgeResult(b.setKeepAlive?.(false));
      // 桥说没停成：留着"还开着"的记忆，下一次收口再试一次。
      if (!result.ok) return keepAliveActive;
      keepAliveActive = false;
      return false;
    }
    if (!bridgeHasPermission(b)) return false;
    const result = parseBridgeResult(b.setKeepAlive?.(true));
    if (!result.ok) return keepAliveActive;
    keepAliveActive = true;
    return true;
  } catch {
    // 桥抛异常＝这一层调用失败：吞掉，别把一轮对话带走。
    return keepAliveActive;
  }
}

/**
 * 开关变化事件的处理：
 *   - enabled=true：已授权才把常驻通知拉起来；还没授权就静默（等权限申请完，
 *     由 requestNotifyPermission 那条路补上）。
 *   - enabled=false：立刻收掉常驻通知（有没有权限都要收——用户明确关了）。
 */
function onKeepAliveChanged(event: Event): void {
  try {
    const detail = (event as CustomEvent<{ enabled?: unknown }>).detail;
    const enabled = detail?.enabled === true;
    const b = bridge();
    if (!b) return;
    if (!enabled) {
      applyKeepAlive(false);
      return;
    }
    if (!bridgeHasPermission(b)) return;
    applyKeepAlive(true);
  } catch {
    // 开关事件面失败不影响别的：保活只是"锦上添花"，出错提醒另有各路。
  }
}

/**
 * 挂上保活开关的监听。模块加载时自动挂一次（页面启动就有，不等用户第一次切开关）。
 * 没有 window 事件面（Node 自检）时什么都不做——静默降级的一部分。
 */
export function installKeepAliveListener(): void {
  if (keepAliveListenerInstalled) return;
  const target = globalThis as unknown as {
    addEventListener?: (type: string, listener: (event: Event) => void) => void;
  };
  if (typeof target.addEventListener !== "function") return;
  try {
    target.addEventListener(KEEP_ALIVE_EVENT, onKeepAliveChanged);
    keepAliveListenerInstalled = true;
  } catch {
    // 挂不上就不挂：保活开关退化成"只认 localStorage 里的值"，不影响出错提醒。
  }
}
installKeepAliveListener();

/**
 * 发一条通知（前提：用户已授权）。
 * 返回值＝这条通知真的发出去了（false＝没桥 / 没权限 / 桥抛异常）。
 * 任何异常都在这一层吞掉：通知失败绝不能影响对话。
 */
export function notifyIfPermitted(
  id: string,
  title: string,
  text: string,
  ongoing = false,
): boolean {
  try {
    const b = bridge();
    if (!b) return false;
    // 有桥但没授权：静默跳过，不主动弹权限框（权限由设置页显式触发）。
    if (!bridgeHasPermission(b)) return false;
    if (typeof b.notify !== "function") return false;
    return parseBridgeResult(b.notify(id, title, text, ongoing)).ok;
  } catch {
    return false;
  }
}

/**
 * 开/关常驻通知（会话忙 → true，会话空闲 → false）。
 * 闸门有两道：
 *   1. 用户开关（localStorage `zcode-mobile.keepAlive`）：关着就只收不启——
 *      "之前开着就收掉"，否则用户关了开关还留着一个常驻通知在通知栏里。
 *   2. 通知权限：开常驻通知必须有权限，没权限就静默跳过（不弹框）。
 * 返回值＝常驻通知此刻是不是真的开着（false = 没桥 / 没权限 / 开关关着 / 已收掉）。
 */
export function setKeepAliveIfPermitted(enabled: boolean): boolean {
  try {
    const b = bridge();
    if (!b) return false;
    const userEnabled = isKeepAliveEnabled();
    if (!enabled || !userEnabled) {
      // 请求关，或用户开关没开：能收就收（收的那一下不需要权限）。
      return applyKeepAlive(false);
    }
    return applyKeepAlive(true);
  } catch {
    return false;
  }
}

/**
 * 显式请求通知权限（给设置页用）。返回＝用户是否授权。
 * 授权刚拿到时，若保活开关是开的，此刻就把常驻通知拉起来——否则开关流程已经过去了，
 * 用户会以为"开了开关没反应"。
 */
export function requestNotifyPermission(): boolean {
  const b = bridge();
  if (!b) return false;
  permissionRequestedThisSession = true;
  try {
    const result = parseBridgeResult(b.requestPermission?.());
    if (result.granted === true) {
      if (isKeepAliveEnabled()) applyKeepAlive(true);
    }
    return result.granted === true;
  } catch {
    return false;
  }
}

/** 本会话问过一次权限没有（问过就不再问）。 */
export function notifyPermissionRequestedThisSession(): boolean {
  return permissionRequestedThisSession;
}

/**
 * 把一句错误收拾成能进通知栏的一行摘要：
 *   - 去掉控制字符（换行、制表、残留的 ANSI 转义），压成一行；
 *   - 截到前 N 字（默认 200），免得一条通知顶半屏。
 */
export function summarizeForNotification(raw: unknown, maxLength = 200): string {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (raw === undefined || raw === null) text = "";
  else if (raw instanceof Error) text = raw.message || String(raw);
  else text = String(raw);
  // ANSI 颜色残留先摘掉（\u001b[31m 之类），不然去掉控制字符后会剩下 "[31m"。
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  const head = maxLength > 1 ? cleaned.slice(0, maxLength - 1) : cleaned.slice(0, maxLength);
  return `${head}…`;
}
