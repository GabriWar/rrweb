/**
 * The fork's replayer schedules through untainted timers taken from a hidden
 * throwaway iframe (rrweb/src/utils.ts getImplementation), so vitest's fake
 * timers, which replace the main window's, never drive replay playback.
 * Hidden iframes hand out the main window's timers, looked up at call time,
 * so faked timers apply exactly as the real ones would in a browser. Same
 * idea as the recorder tests' test-panopticon.setup.ts.
 */
// node-environment tests (umd, vite config) have no DOM
if (typeof HTMLIFrameElement !== 'undefined') {
  const getter = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    'contentWindow',
  )!.get!;
  const TIMERS = new Set([
    'setTimeout',
    'clearTimeout',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]);
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get(this: HTMLIFrameElement) {
      const w = getter.call(this) as Window | null;
      if (!w || !this.hidden) return w;
      return new Proxy(w, {
        get: (target, key) =>
          typeof key === 'string' && TIMERS.has(key)
            ? (...args: unknown[]) =>
                (
                  window as unknown as Record<
                    string,
                    (...a: unknown[]) => unknown
                  >
                )[key](...args)
            : Reflect.get(target, key),
      });
    },
  });
}
