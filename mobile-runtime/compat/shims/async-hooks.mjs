// 端侧没有 worker/线程，AsyncLocalStorage 用显式栈实现：
// run() 期间的 await 靠 microtask 连续，不保证跨 setTimeout 的隔离性 —— 这是已知折损，
// 它目前只承载 tracing/span 上下文，不影响正确性。
let current = undefined;

class AsyncNode {
  constructor(store, parent) {
    this.store = store;
    this.parent = parent;
  }
}

export class AsyncLocalStorage {
  constructor() {
    this._stack = [];
  }
  getStore() {
    return this._stack[this._stack.length - 1];
  }
  run(store, cb, ...args) {
    this._stack.push(store);
    try {
      return cb(...args);
    } finally {
      this._stack.pop();
    }
  }
  exit(cb, ...args) {
    const saved = this._stack.splice(0);
    try {
      return cb(...args);
    } finally {
      this._stack.push(...saved);
    }
  }
  get active() {
    return this._stack.length > 0;
  }
}
