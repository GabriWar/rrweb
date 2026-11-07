/**
 * jsdom shim for the Panopticon fork tests. rrweb-snapshot takes
 * "untainted" setTimeout/rAF from a throwaway hidden iframe it removes
 * right away; Chromium keeps such timers alive, jsdom stops a removed
 * frame's timers. Hand the throwaway iframe the main window's timers so
 * the code under test schedules exactly as in a browser.
 */
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
          ? (window as unknown as Record<string, unknown>)[key]
          : Reflect.get(target, key),
    });
  },
});
