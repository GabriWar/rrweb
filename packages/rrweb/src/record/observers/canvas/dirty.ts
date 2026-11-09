import type { IWindow, listenerHandler } from '@rrweb/types';
import { patch } from '@rrweb/utils';

/**
 * Panopticon item 8 review: which canvases changed since their last frame.
 * Every call that can change a canvas's pixels marks it (`mark(ctx)` with
 * the context, or `markCanvas` for the element), so the canvas manager
 * reads back only canvases that changed, losing nothing:
 *
 * - every method of CanvasRenderingContext2D, WebGLRenderingContext and
 *   WebGL2RenderingContext except the pure ones (get / is / measure /
 *   create prefixes), plus every function of every WebGL extension object
 *   getExtension returns (instanced and multi draws live there);
 * - ImageBitmapRenderingContext.transferFromImageBitmap;
 * - the canvas's width / height setters (they clear the bitmap, even set
 *   to the same value);
 * - getContext itself (a new context);
 * - webglcontextlost / webglcontextrestored / contextlost / contextrestored.
 *
 * A canvas is `known` once one of these is seen on it after install. A
 * canvas that is not known (its context predates the recorder and it has
 * not drawn since, a WebGPU context, a canvas transferred to an
 * OffscreenCanvas and drawn in a worker) cannot be watched and keeps being
 * read back on every frame (exact repeats dropped), as before.
 */
export default function initCanvasDirtyObserver(
  win: IWindow,
  mark: (ctx: { canvas: unknown }) => void,
  markCanvas: (canvas: unknown) => void,
): listenerHandler {
  const handlers: listenerHandler[] = [];
  const PURE = /^(get|is|measure|create)/;
  const wrapped = new WeakSet<object>();

  const wrapExtension = (ctx: { canvas: unknown }, ext: unknown) => {
    if (!ext || typeof ext !== 'object' || wrapped.has(ext)) return;
    wrapped.add(ext);
    const proto = Object.getPrototypeOf(ext) as object | null;
    const names = new Set([
      ...Object.getOwnPropertyNames(ext),
      ...(proto ? Object.getOwnPropertyNames(proto) : []),
    ]);
    for (const name of names) {
      if (name === 'constructor') continue;
      try {
        const fn = (ext as Record<string, unknown>)[name];
        if (typeof fn !== 'function') continue;
        Object.defineProperty(ext, name, {
          configurable: true,
          writable: true,
          value: function (this: unknown) {
            mark(ctx);
            // eslint-disable-next-line prefer-rest-params
            return (fn as (...a: unknown[]) => unknown).apply(
              this,
              arguments as never,
            );
          },
        });
      } catch {
        // a property the extension does not let us redefine
      }
    }
  };

  const patchProto = (proto: object | undefined, gl: boolean) => {
    if (!proto) return;
    for (const prop of Object.getOwnPropertyNames(proto)) {
      if (prop === 'constructor' || prop === 'canvas') continue;
      if (PURE.test(prop) && !(gl && prop === 'getExtension')) continue;
      let fn: unknown;
      try {
        fn = (proto as Record<string, unknown>)[prop];
      } catch {
        continue; // an accessor that throws on the prototype
      }
      if (typeof fn !== 'function') continue;
      try {
        handlers.push(
          patch(proto as Record<string, unknown>, prop, function (original) {
            if (gl && prop === 'getExtension')
              return function (this: { canvas: unknown }) {
                // eslint-disable-next-line prefer-rest-params
                const ext = (original as (...a: unknown[]) => unknown).apply(
                  this,
                  arguments as never,
                );
                wrapExtension(this, ext);
                return ext;
              };
            return function (this: { canvas: unknown }) {
              mark(this);
              // eslint-disable-next-line prefer-rest-params
              return (original as (...a: unknown[]) => unknown).apply(
                this,
                arguments as never,
              );
            };
          }),
        );
      } catch {
        // not patchable
      }
    }
  };

  const w = win as unknown as Record<string, { prototype: object } | undefined>;
  patchProto(w.CanvasRenderingContext2D?.prototype, false);
  patchProto(w.WebGLRenderingContext?.prototype, true);
  patchProto(w.WebGL2RenderingContext?.prototype, true);
  const bitmap = w.ImageBitmapRenderingContext?.prototype;
  if (bitmap && 'transferFromImageBitmap' in bitmap) {
    handlers.push(
      patch(
        bitmap as Record<string, unknown>,
        'transferFromImageBitmap',
        function (original) {
          return function (this: { canvas: unknown }) {
            mark(this);
            // eslint-disable-next-line prefer-rest-params
            return (original as (...a: unknown[]) => unknown).apply(
              this,
              arguments as never,
            );
          };
        },
      ),
    );
  }

  const canvasProto = w.HTMLCanvasElement?.prototype;
  if (canvasProto) {
    handlers.push(
      patch(
        canvasProto as Record<string, unknown>,
        'getContext',
        function (original) {
          return function (this: unknown) {
            // eslint-disable-next-line prefer-rest-params
            const ctx = (original as (...a: unknown[]) => unknown).apply(
              this,
              arguments as never,
            );
            if (ctx) markCanvas(this);
            return ctx;
          };
        },
      ),
    );
    for (const key of ['width', 'height']) {
      const d = Object.getOwnPropertyDescriptor(canvasProto, key);
      if (!d || !d.set || !d.get) continue;
      const { get, set } = d;
      try {
        Object.defineProperty(canvasProto, key, {
          configurable: true,
          enumerable: d.enumerable,
          get,
          set(this: unknown, v: unknown) {
            set.call(this, v);
            markCanvas(this);
          },
        });
        handlers.push(() => Object.defineProperty(canvasProto, key, d));
      } catch {
        // not redefinable
      }
    }
  }

  const onContext = (e: Event) => markCanvas(e.target);
  const types = [
    'webglcontextlost',
    'webglcontextrestored',
    'contextlost',
    'contextrestored',
  ];
  try {
    for (const t of types) win.document.addEventListener(t, onContext, true);
    handlers.push(() => {
      for (const t of types)
        win.document.removeEventListener(t, onContext, true);
    });
  } catch {
    // a window whose document we cannot reach
  }

  return () => handlers.forEach((h) => h());
}
