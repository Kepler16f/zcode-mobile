/** 移动宿主的 OAuth 短期事务存储。具体凭据由 Keystore 保护。 */
export interface PendingOAuthStore {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface PendingOAuthOwner {
  exportPendingOAuth(): unknown | null;
  restorePendingOAuth(value: unknown): boolean;
}

const PENDING_KEY = "mobile:oauth:pending:v1";
const MUTATING_METHODS = new Set([
  "startOAuth", "startOAuthWithPolling", "pollPendingOAuth", "handleCallback",
  "cancelPending", "logout", "logoutAll",
]);
const START_METHODS = new Set(["startOAuth", "startOAuthWithPolling"]);

/**
 * 原服务持有唯一真实状态；此层只把当前快照保存到受保护存储。
 * 修复原因：系统可在浏览器授权期间回收 WebView，原来的内存 state 丢失后回调恒被拒绝。
 */
export function withPendingOAuthPersistence<T extends PendingOAuthOwner>(service: T, store: PendingOAuthStore): T {
  let restored: Promise<void> | undefined;
  let encodedInStore: string | null = null;
  let writes: Promise<void> = Promise.resolve();

  function ensureRestored(): Promise<void> {
    return restored ??= (async () => {
      const encoded = await store.load(PENDING_KEY);
      encodedInStore = encoded;
      if (!encoded) return;
      let valid = false;
      try {
        valid = service.restorePendingOAuth(JSON.parse(encoded) as unknown);
      } catch {
        // 损坏记录只能丢弃，不能把未经校验的数据作为授权依据。
      }
      if (!valid) {
        await store.delete(PENDING_KEY);
        encodedInStore = null;
      }
    })();
  }

  function enqueueWrite(action: () => Promise<void>): Promise<void> {
    const next = writes.catch(() => undefined).then(action);
    writes = next;
    return next;
  }

  function saveCurrent(): Promise<void> {
    return enqueueWrite(async () => {
      // 在队列真正执行时读取 owner，避免旧网络请求的结束顺序覆盖较新的事务。
      const snapshot = service.exportPendingOAuth();
      const encoded = snapshot === null ? null : JSON.stringify(snapshot);
      if (encoded === encodedInStore) return;
      if (encoded === null) await store.delete(PENDING_KEY);
      else await store.save(PENDING_KEY, encoded);
      encodedInStore = encoded;
    });
  }

  return new Proxy(service, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (typeof prop !== "string" || !MUTATING_METHODS.has(prop)) return value.bind(target);
      return async (...args: unknown[]) => {
        await ensureRestored();
        if (START_METHODS.has(prop)) {
          // 开新授权前先清掉旧快照，避免 init 网络请求中途被回收后复活旧事务。
          await enqueueWrite(async () => {
            await store.delete(PENDING_KEY);
            encodedInStore = null;
          });
        }
        try {
          return await value.apply(target, args);
        } finally {
          await saveCurrent();
        }
      };
    },
  });
}
