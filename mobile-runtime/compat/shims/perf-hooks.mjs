export const performance = globalThis.performance ?? { now: () => Date.now() };
export const PerformanceObserver = globalThis.PerformanceObserver ?? class { observe() {} disconnect() {} };
