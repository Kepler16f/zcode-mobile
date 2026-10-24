// 端侧系统面（§1.5.17）。
//
// 为什么必须自己写而不是搬工厂：`createSystemService()`（services/src/system/systemService.ts:344）
// 的 `info()` 直接调 `os.homedir()` 与 `process.platform`，`probeIntranet()` 走 `net.Socket` ——
// 三样在 WebView 里都没有，硬搬就是把 Node 依赖拖进包里。而它的接口只有三个方法，
// 其中两个端侧能给出**真答案**，第三个给不了，就明说给不了。
//
// 这一面挡住的是一个用户可见功能：`DirectoryBrowser.tsx:74` 拿 `info().homedir` 当起始目录，
// 而这一面是 stub 时"调用即抛"，手机上选不了工作区 —— 报错文案还是"获取系统信息失败"，
// 看上去像权限问题，其实是我们没接。
import type {
  IntegratedTerminalShellOption,
  IntranetProbeRequest,
  IntranetProbeResult,
  SystemInfo,
} from "@zcode/shared";
import type { ISystemService } from "@zcode/services";
import * as vfs from "../compat/vfs.mjs";

/**
 * vfs 里的"家"。返回的是**虚拟路径**，不是真实绝对路径：`fileService.readdir` 也走同一套 vfs，
 * 给它 `/data/user/0/...` 那种真路径只会 ENOENT，然后屏幕上又是一个看不出原因的"读取失败"。
 * `/work` 是这棵树里放用户文件的那一层（`compat/vfs-native.mjs:26` 的相对路径约定也是它）。
 */
const WORKSPACE_HOME = "/work";

export function createMobileSystemService(): ISystemService {
  return {
    async info(): Promise<SystemInfo> {
      // 先把这一层建出来。空磁盘上连 `/` 都还不可列（memory 盘的 readdir 对不存在的路径是
      // ENOENT，不是空列表），直接把它当起始目录，UI 会得到一句"读取失败"和一个空界面 ——
      // 而此刻用户还没做过任何事，看不出是我们的锅。recursive 建已存在的目录不抛，重复调用安全。
      try {
        vfs.mkdir(WORKSPACE_HOME, { recursive: true });
      } catch {
        // 建不出来也照样把路径给出去：真正的错误留给目录浏览器那一次 readdir 去报，
        // 那里有能显示的界面，info() 这层只会把一个字符串塞进屏幕。
      }
      // platform 只用于文案与少数分支判断；端侧如实报 android，不冒充 linux 去继承桌面行为。
      return { homedir: WORKSPACE_HOME, platform: "android" };
    },

    /**
     * 空列表而不是错误：`/system/bin/sh` 在这台机器上确实能起（真机自检 L1 已证），
     * 但集成终端要的是 PTY（create/resize/write + onDynamicData/onDynamicExit），
     * `zcodeExec` 的管道给不了 resize 和交互回显。terminalService 还没接之前，
     * 这里列出一个"选了就用不了的 shell"比留空更坏。
     */
    async listIntegratedTerminalShells(): Promise<IntegratedTerminalShellOption[]> {
      return [];
    },

    /**
     * 明确做不到，不假装探测成功。返回类型 `IntranetProbeResult` 里没有"不支持"这一支
     * （strategy 只有 tcp-connect/service-http/mixed），伪造一个 `isIntranet:false` 的结果
     * 会被调用方当成"探测过了，结论是不在内网"，那比抛错更误导。
     */
    async probeIntranet(_request: IntranetProbeRequest): Promise<IntranetProbeResult> {
      throw new Error("端侧不做内网探测：需要原始 TCP socket，WebView 里没有这个能力（不是权限问题）");
    },
  };
}
