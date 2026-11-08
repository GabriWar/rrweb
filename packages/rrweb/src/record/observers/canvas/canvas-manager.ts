import type { Mirror } from 'rrweb-snapshot';
import type {
  blockClass,
  canvasManagerMutationCallback,
  canvasMutationCallback,
  canvasMutationCommand,
  canvasMutationWithType,
  IWindow,
  listenerHandler,
  CanvasArg,
  DataURLOptions,
  ImageBitmapDataURLWorkerResponse,
} from '@rrweb/types';
import {
  isBlocked,
  nowTimestamp,
  onRequestAnimationFrame,
} from '../../../utils';
import { CanvasContext } from '@rrweb/types';
import initCanvas2DMutationObserver from './2d';
import initCanvasContextObserver from './canvas';
import initCanvasWebGLMutationObserver from './webgl';
import initCanvasDirtyObserver from './dirty';
import { getImageBitmapDataUrlWorkerURL } from 'rrweb-worker';
import { callbackWrapper, registerErrorHandler } from '../../error-handler';
import type { ErrorHandler } from '../../../types';

export type RafStamps = { latestId: number; invokeId: number | null };

type pendingCanvasMutationsMap = Map<
  HTMLCanvasElement,
  canvasMutationWithType[]
>;
type MaxCanvasSize = [number, number];
type SnapshotOptions = {
  skipRequestAnimationFrame?: boolean;
};

export interface CanvasManagerInterface {
  reset(): void;
  freeze(): void;
  unfreeze(): void;
  lock(): void;
  unlock(): void;
  snapshot(canvasElement?: HTMLCanvasElement, options?: SnapshotOptions): void;
  addWindow(win: IWindow): void;
  addShadowRoot(shadowRoot: ShadowRoot): void;
  resetShadowRoots(): void;
  /**
   * Panopticon item 8: take a full snapshot canvas's pixels off the main
   * thread (rrweb-snapshot CanvasPixelsHook). Returns false when this
   * manager cannot (no worker): the snapshot then reads them itself.
   */
  capturePixels?(
    canvas: HTMLCanvasElement,
    dataURLOptions: DataURLOptions,
    fill: (dataURL: string | null) => void,
  ): boolean;
  /**
   * Panopticon item 8 review: answer every capturePixels request still on
   * its way, synchronously, with the pixels as of the request (a copy taken
   * then). A snapshot finished early (unload) never goes out without them.
   */
  flushPixels?(): void;
}

/**
 * Panopticon item 8 review: backpressure. A canvas whose frames the workers
 * have not answered yet is not read back again while this many of its
 * frames, or this many bitmap bytes over all canvases, are on their way;
 * it stays marked changed, so the next frame read carries every draw.
 * Reached only when the encoder cannot keep up with the page; it bounds
 * memory instead of growing until the tab dies.
 */
export const MAX_FRAMES_IN_FLIGHT = 8;
export const MAX_BITMAP_BYTES_IN_FLIGHT = 256 * 1024 * 1024;

export interface CanvasManagerConstructorOptions {
  recordCanvas: boolean;
  enableManualSnapshot?: boolean;
  mutationCb: canvasMutationCallback;
  win: IWindow;
  blockClass: blockClass;
  blockSelector: string | null;
  unblockSelector: string | null;
  maxCanvasSize?: MaxCanvasSize | null;
  mirror: Mirror;
  dataURLOptions: DataURLOptions;
  errorHandler?: ErrorHandler;
  sampling?: 'all' | number;
}

export class CanvasManagerNoop implements CanvasManagerInterface {
  public reset() {
    // noop
  }
  public freeze() {
    // noop
  }
  public unfreeze() {
    // noop
  }
  public lock() {
    // noop
  }
  public unlock() {
    // noop
  }
  public snapshot() {
    // noop
  }
  public addWindow() {
    // noop
  }

  public addShadowRoot() {
    // noop
  }

  public resetShadowRoots() {
    // noop
  }
}

export class CanvasManager implements CanvasManagerInterface {
  private pendingCanvasMutations: pendingCanvasMutationsMap = new Map();
  private rafStamps: RafStamps = { latestId: 0, invokeId: null };
  private options: CanvasManagerConstructorOptions;
  private mirror: Mirror;

  private shadowDoms = new Set<WeakRef<ShadowRoot>>();
  private windowsSet = new WeakSet<IWindow>();
  private windows: WeakRef<IWindow>[] = [];

  private mutationCb: canvasMutationCallback;
  private restoreHandlers: listenerHandler[] = [];
  private frozen = false;
  private locked = false;

  private snapshotInProgressMap: Map<number, boolean> = new Map();
  private worker: Worker | null = null;
  /**
   * Panopticon item 8: every animation frame is captured (no frame skipped
   * while an earlier one is still being encoded). Frames are spread over a
   * small pool of workers; per canvas they are emitted in capture order and
   * a frame is dropped only when its PNG equals the previous one's exactly.
   */
  private pool: Worker[] = [];
  private poolLoad: number[] = [];
  private frames = new Map<
    number,
    {
      next: number;
      emit: number;
      /** the previous frame: sha-256 of its bytes (base64 only where the worker has no WebCrypto) */
      last: string | null;
      done: Map<number, ImageBitmapDataURLWorkerResponse | null>;
      /** capture instant of each frame on its way (nowTimestamp) */
      at: Map<number, number>;
      /** bitmap bytes of each frame not answered yet */
      bytes: Map<number, number>;
    }
  >();
  /**
   * Full snapshot pixel requests waiting for the worker, by token, with a
   * copy of the canvas as of the request for flushPixels.
   */
  private pixelRequests = new Map<
    number,
    {
      fill: (dataURL: string | null) => void;
      copy: HTMLCanvasElement | null;
      options: DataURLOptions;
      worker: number;
    }
  >();
  /** Canvases changed since their last frame read (dirty.ts), and the ones watched at all. */
  private dirty = new WeakSet<object>();
  private known = new WeakSet<object>();
  private lastMarked: unknown = null;
  private bitmapBytes = 0;
  /** Bench only: in-flight and backpressure counters. */
  public stats = {
    framesInFlightPeak: 0,
    bitmapBytesPeak: 0,
    deferred: 0,
    unchangedSkipped: 0,
  };
  private pixelToken = 0;

  private lastSnapshotTime = 0;

  public reset() {
    this.pendingCanvasMutations.clear();
    this.restoreHandlers.forEach((handler) => {
      try {
        handler();
      } catch (e) {
        //
      }
    });
    this.restoreHandlers = [];
    this.windowsSet = new WeakSet();
    this.windows = [];
    this.shadowDoms = new Set();
    this.worker?.terminate();
    this.worker = null;
    this.pool.forEach((w) => w.terminate());
    this.pool = [];
    this.poolLoad = [];
    this.frames.clear();
    this.bitmapBytes = 0;
    this.snapshotInProgressMap = new Map();
    this.pixelRequests.clear();
  }

  private markDirty = (ctx: { canvas: unknown }) => {
    // one context draws many times a frame: only its first call does work
    if (ctx === this.lastMarked) return;
    this.lastMarked = ctx;
    const canvas = ctx && ctx.canvas;
    if (canvas && typeof canvas === 'object') {
      this.dirty.add(canvas);
      this.known.add(canvas);
    }
  };

  private markCanvasDirty = (canvas: unknown) => {
    if (canvas && typeof canvas === 'object') {
      this.dirty.add(canvas);
      this.known.add(canvas);
    }
  };

  public capturePixels(
    canvas: HTMLCanvasElement,
    dataURLOptions: DataURLOptions,
    fill: (dataURL: string | null) => void,
  ): boolean {
    const pool = this.pool;
    if (!pool.length || !canvas.width || !canvas.height) return false;
    const token = ++this.pixelToken;
    const { width, height } = canvas;
    // its own place in the pool: the least loaded worker, counted
    let w = 0;
    for (let i = 1; i < this.poolLoad.length; i++)
      if (this.poolLoad[i] < this.poolLoad[w]) w = i;
    this.poolLoad[w]++;
    // the canvas as of now, for a snapshot finished before the worker answers
    let copy: HTMLCanvasElement | null = null;
    try {
      copy = canvas.ownerDocument.createElement('canvas');
      copy.width = width;
      copy.height = height;
      copy.getContext('2d')?.drawImage(canvas, 0, 0);
    } catch {
      copy = null;
    }
    this.pixelRequests.set(token, {
      fill,
      copy,
      options: dataURLOptions,
      worker: w,
    });
    // the ImageBitmap is the canvas as of this call; encoding happens in
    // the worker
    createImageBitmap(canvas)
      .then((bitmap) => {
        if (this.pool !== pool) return bitmap.close();
        pool[w].postMessage(
          { id: -1, initial: token, bitmap, width, height, dataURLOptions },
          [bitmap],
        );
      })
      .catch(() => this.answerPixels(token, null));
    return true;
  }

  public flushPixels() {
    for (const [token, r] of [...this.pixelRequests]) {
      let url: string | null = null;
      try {
        if (r.copy) {
          url = r.copy.toDataURL(r.options.type, r.options.quality);
          // a blank canvas has no pixels to record, as the worker decides
          const blank = r.copy.ownerDocument.createElement('canvas');
          blank.width = r.copy.width;
          blank.height = r.copy.height;
          if (url === blank.toDataURL(r.options.type, r.options.quality))
            url = null;
        }
      } catch {
        url = null;
      }
      this.answerPixels(token, url);
    }
  }

  private answerPixels(token: number, dataURL: string | null) {
    const r = this.pixelRequests.get(token);
    if (!r) return;
    this.pixelRequests.delete(token);
    this.poolLoad[r.worker] = Math.max(0, (this.poolLoad[r.worker] || 0) - 1);
    r.fill(dataURL);
  }

  public freeze() {
    this.frozen = true;
  }

  public unfreeze() {
    this.frozen = false;
  }

  public lock() {
    this.locked = true;
  }

  public unlock() {
    this.locked = false;
  }

  constructor(options: CanvasManagerConstructorOptions) {
    const {
      enableManualSnapshot,
      sampling = 'all',
      win,
      recordCanvas,
      errorHandler,
    } = options;
    options.sampling = sampling;
    this.mutationCb = options.mutationCb;
    this.mirror = options.mirror;
    this.options = options;

    if (errorHandler) {
      registerErrorHandler(errorHandler);
    }
    if (
      (recordCanvas && typeof sampling === 'number') ||
      enableManualSnapshot
    ) {
      this.worker = this.initFPSWorker(0);
      this.pool = [this.worker];
      this.poolLoad = [0];
      // the encoder must keep up with every frame: more workers where the
      // device has the cores (they run beside the page, not on its thread)
      const cores =
        (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
      const extra = Math.min(2, Math.max(0, cores - 2));
      for (let i = 1; i <= extra; i++) {
        this.pool.push(this.initFPSWorker(i));
        this.poolLoad.push(0);
      }
    }
    this.addWindow(win);

    if (enableManualSnapshot) {
      return;
    }

    callbackWrapper(() => {
      if (recordCanvas && sampling === 'all') {
        this.startRAFTimestamping();
        this.startPendingCanvasMutationFlusher();
      }
      if (recordCanvas && typeof sampling === 'number') {
        this.initCanvasFPSObserver();
      }
    })();
  }

  public addWindow(win: IWindow) {
    const {
      sampling = 'all',
      blockClass,
      blockSelector,
      unblockSelector,
      recordCanvas,
      enableManualSnapshot,
    } = this.options;
    if (this.windowsSet.has(win)) return;

    if (enableManualSnapshot) {
      this.windowsSet.add(win);
      this.windows.push(new WeakRef(win));
      return;
    }

    callbackWrapper(() => {
      if (recordCanvas && sampling === 'all') {
        this.initCanvasMutationObserver(
          win,
          blockClass,
          blockSelector,
          unblockSelector,
        );
      }
      if (recordCanvas && typeof sampling === 'number') {
        const canvasContextReset = initCanvasContextObserver(
          win,
          blockClass,
          blockSelector,
          unblockSelector,
          true,
        );
        const dirtyReset = initCanvasDirtyObserver(
          win,
          this.markDirty,
          this.markCanvasDirty,
        );
        // patches chain: undone in the reverse order
        this.restoreHandlers.push(() => {
          dirtyReset();
          canvasContextReset();
        });
      }
    })();
    this.windowsSet.add(win);
    this.windows.push(new WeakRef(win));
  }

  public addShadowRoot(shadowRoot: ShadowRoot) {
    this.shadowDoms.add(new WeakRef(shadowRoot));
  }

  public resetShadowRoots() {
    this.shadowDoms = new Set();
  }

  public snapshot(
    canvasElement?: HTMLCanvasElement,
    options?: SnapshotOptions,
  ): void {
    if (options?.skipRequestAnimationFrame) {
      this.takeSnapshot(performance.now(), canvasElement);
      return;
    }
    onRequestAnimationFrame((timestamp) =>
      this.takeSnapshot(timestamp, canvasElement),
    );
  }

  private initFPSWorker(index: number): Worker {
    const worker = new Worker(getImageBitmapDataUrlWorkerURL());
    worker.onmessage = (e) => {
      if ((e.data as { seq?: number }).seq !== undefined)
        this.poolLoad[index] = Math.max(0, (this.poolLoad[index] || 0) - 1);
      const benchStart =
        typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__
          ? performance.now()
          : 0;
      try {
        this.onWorkerFrame(e);
      } finally {
        if (typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__) {
          performance.measure('pano:rec:canvas', {
            start: benchStart,
            end: performance.now(),
          });
        }
      }
    };
    return worker;
  }

  private onWorkerFrame(e: MessageEvent) {
    const data = e.data as ImageBitmapDataURLWorkerResponse;
    if (data.initial !== undefined) {
      this.answerPixels(
        data.initial,
        'base64' in data ? `data:${data.type};base64,${data.base64}` : null,
      );
      return;
    }
    const { id } = data;
    if (data.seq !== undefined) return this.onSequencedFrame(id, data.seq, data);
    this.snapshotInProgressMap.set(id, false);

    if (!('base64' in data)) return;
    this.emitFrame(data);
  }

  /** Frames of one canvas in capture order; exact repeats dropped. */
  private onSequencedFrame(
    id: number,
    seq: number,
    data: ImageBitmapDataURLWorkerResponse | null,
  ) {
    const f = this.frames.get(id);
    if (!f) return;
    f.done.set(seq, data);
    const b = f.bytes.get(seq);
    if (b !== undefined) {
      this.bitmapBytes -= b;
      f.bytes.delete(seq);
    }
    while (f.done.has(f.emit)) {
      const d = f.done.get(f.emit)!;
      const at = f.at.get(f.emit);
      f.done.delete(f.emit);
      f.at.delete(f.emit);
      f.emit++;
      if (!d || !('base64' in d)) continue;
      // exact: sha-256 of the bytes (the worker's), else the bytes themselves
      const key = d.hash || d.base64;
      // the first frame of a transparent canvas: nothing to draw (as upstream)
      if (f.last === null && d.transparent) {
        f.last = key;
        continue;
      }
      if (key === f.last) continue; // byte-identical to the previous frame
      f.last = key;
      this.emitFrame(d, at);
    }
  }

  /** `at`: when the frame was read (its event's timestamp); now when unknown. */
  private emitFrame(data: ImageBitmapDataURLWorkerResponse, at?: number) {
    if (!('base64' in data)) return;
    const { id, base64, type, width, height } = data;
    this.mutationCb(
      {
        id,
        type: CanvasContext['2D'],
        commands: [
          {
            property: 'clearRect', // wipe canvas
            args: [0, 0, width, height],
          },
          {
            property: 'drawImage', // draws (semi-transparent) image
            args: [
              {
                rr_type: 'ImageBitmap',
                args: [
                  {
                    rr_type: 'Blob',
                    data: [{ rr_type: 'ArrayBuffer', base64 }],
                    type,
                  },
                ],
              } as CanvasArg,
              0,
              0,
              // The below args are needed if we enforce a max size, we want to
              // retain the original size when drawing the image (which should be smaller)
              width,
              height,
            ],
          },
        ],
      },
      at,
    );
  }

  private processMutation: canvasManagerMutationCallback = (
    target,
    mutation,
  ) => {
    const newFrame =
      this.rafStamps.invokeId &&
      this.rafStamps.latestId !== this.rafStamps.invokeId;
    if (newFrame || !this.rafStamps.invokeId)
      this.rafStamps.invokeId = this.rafStamps.latestId;

    if (!this.pendingCanvasMutations.has(target)) {
      this.pendingCanvasMutations.set(target, []);
    }

    this.pendingCanvasMutations.get(target)!.push(mutation);
  };

  private initCanvasFPSObserver() {
    let rafId: number;

    if (!this.windows.length && !this.shadowDoms.size) {
      // If these are empty, then we won't be able to find any canvases to snapshot, so nothing to do here.
      return;
    }

    const rafCallback = (timestamp: DOMHighResTimeStamp) => {
      this.takeSnapshot(timestamp);
      rafId = onRequestAnimationFrame(rafCallback);
    };

    rafId = onRequestAnimationFrame(rafCallback);

    this.restoreHandlers.push(() => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    });
  }

  private initCanvasMutationObserver(
    win: IWindow,
    blockClass: blockClass,
    blockSelector: string | null,
    unblockSelector: string | null,
  ): void {
    const canvasContextReset = initCanvasContextObserver(
      win,
      blockClass,
      blockSelector,
      unblockSelector,
      false,
    );
    const canvas2DReset = initCanvas2DMutationObserver(
      this.processMutation.bind(this),
      win,
      blockClass,
      blockSelector,
      unblockSelector,
    );

    const canvasWebGL1and2Reset = initCanvasWebGLMutationObserver(
      this.processMutation.bind(this),
      win,
      blockClass,
      blockSelector,
      unblockSelector,
      this.mirror,
    );

    this.restoreHandlers.push(() => {
      canvasContextReset();
      canvas2DReset();
      canvasWebGL1and2Reset();
    });
  }

  /**
   * Returns all `canvas` elements that are not blocked by the given selectors. Searches all windows and shadow roots.
   */
  private getCanvasElements(
    blockClass: blockClass,
    blockSelector: string | null,
    unblockSelector: string | null,
  ): HTMLCanvasElement[] {
    const matchedCanvas: HTMLCanvasElement[] = [];

    const searchCanvas = (root: Document | ShadowRoot) => {
      root.querySelectorAll('canvas').forEach((canvas) => {
        if (
          !isBlocked(canvas, blockClass, blockSelector, unblockSelector, true)
        ) {
          matchedCanvas.push(canvas);
        }
      });
    };

    for (const item of this.windows) {
      const window = item.deref();
      let _document: Document | false | undefined;

      try {
        _document = window && window.document;
      } catch {
        // Accessing `window.document` can throw a security error:
        // "Failed to read a named property 'document' from 'Window': An
        // attempt was made to break through the security policy of the user
        // agent."
      }

      if (_document) {
        // This is not included in the `try` block above in case `searchCanvas()` throws
        searchCanvas(_document);
      }
    }

    // Search in shadow roots
    for (const item of this.shadowDoms) {
      const shadowRoot = item.deref();
      if (shadowRoot) {
        searchCanvas(shadowRoot);
      }
    }

    return matchedCanvas;
  }

  /**
   * Takes a snapshot of the provided canvas element, or will search all windows/shadow roots for canvases. Will self-throttle based on `options.sampling`.
   *
   * @returns `true` if the snapshot was taken, `false` if it was throttled.
   */
  private takeSnapshot(
    timestamp: DOMHighResTimeStamp,
    canvasElement?: HTMLCanvasElement,
  ) {
    const benchStart =
      typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__
        ? performance.now()
        : 0;
    try {
      return this.takeSnapshotNow(timestamp, canvasElement);
    } finally {
      if (typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__) {
        performance.measure('pano:rec:canvas', {
          start: benchStart,
          end: performance.now(),
        });
      }
    }
  }

  private takeSnapshotNow(
    timestamp: DOMHighResTimeStamp,
    canvasElement?: HTMLCanvasElement,
  ) {
    const {
      sampling,
      blockClass,
      blockSelector,
      unblockSelector,
      dataURLOptions,
      maxCanvasSize,
    } = this.options;
    const fps = sampling === 'all' ? 2 : sampling || 2;
    const timeBetweenSnapshots = 1000 / fps;
    const shouldThrottle =
      this.lastSnapshotTime &&
      timestamp - this.lastSnapshotTime < timeBetweenSnapshots;

    if (shouldThrottle) {
      return false;
    }

    this.lastSnapshotTime = timestamp;
    const canvases = canvasElement
      ? [canvasElement]
      : this.getCanvasElements(blockClass, blockSelector, unblockSelector);
    // draws from here on mark their canvas again (markDirty)
    this.lastMarked = null;
    // a canvas that left the page takes its last frame's key with it
    if (!canvasElement && this.frames.size > canvases.length) {
      const live = new Set(canvases.map((c) => this.mirror.getId(c)));
      for (const [id, f] of this.frames)
        if (!live.has(id) && f.next === f.emit) this.frames.delete(id);
    }

    // Process all canvases concurrently
    canvases.forEach((canvas) => {
      const id = this.mirror.getId(canvas);

      // Check if canvas is valid and not already being processed (only
      // without a pool: the sequenced path never skips a frame)
      if (
        !this.mirror.hasNode(canvas) ||
        !canvas.width ||
        !canvas.height ||
        (!this.pool.length && this.snapshotInProgressMap.get(id))
      ) {
        return;
      }
      if (this.pool.length) {
        // the frame loop reads a watched canvas only when it changed; an
        // explicit snapshot(canvas) always reads it
        if (
          !canvasElement &&
          this.known.has(canvas) &&
          !this.dirty.has(canvas)
        ) {
          this.stats.unchangedSkipped++;
          return;
        }
        if (this.captureSequenced(canvas, id, dataURLOptions, maxCanvasSize))
          this.dirty.delete(canvas);
        return;
      }

      this.snapshotInProgressMap.set(id, true);

      // Note: we intentionally do NOT clear the WebGL color buffer here to force
      // the drawing buffer back into memory. Doing so wipes the application's own
      // live canvas on every snapshot, which for on-demand-rendered canvases
      // (maps, 3D viewers, charts) causes visible blinking. Buffer preservation
      // is handled by forcing `preserveDrawingBuffer: true` in the getContext
      // patch; when that is not possible, a blank snapshot is preferable to
      // corrupting the host application's rendering.
      // See: https://github.com/getsentry/sentry-javascript/issues/20178

      createImageBitmap(canvas)
        .then((bitmap) => {
          this.worker?.postMessage(
            {
              id,
              bitmap,
              width: canvas.width,
              height: canvas.height,
              dataURLOptions,
              maxCanvasSize,
            },
            [bitmap],
          );
        })
        .catch((error) => {
          callbackWrapper(() => {
            this.snapshotInProgressMap.delete(id);
            throw error;
          })();
        });
    });

    return true;
  }

  /** Read one frame of a canvas into the pool; false when backpressure defers it. */
  private captureSequenced(
    canvas: HTMLCanvasElement,
    id: number,
    dataURLOptions: DataURLOptions,
    maxCanvasSize: MaxCanvasSize | null | undefined,
  ): boolean {
    let f = this.frames.get(id);
    if (!f) {
      f = {
        next: 0,
        emit: 0,
        last: null,
        done: new Map(),
        at: new Map(),
        bytes: new Map(),
      };
      this.frames.set(id, f);
    }
    const { width, height } = canvas;
    const bytes = width * height * 4;
    if (
      f.next - f.emit >= MAX_FRAMES_IN_FLIGHT ||
      (this.bitmapBytes > 0 &&
        this.bitmapBytes + bytes > MAX_BITMAP_BYTES_IN_FLIGHT)
    ) {
      this.stats.deferred++;
      return false;
    }
    const seq = f.next++;
    f.at.set(seq, nowTimestamp());
    f.bytes.set(seq, bytes);
    this.bitmapBytes += bytes;
    let inFlight = 0;
    for (const x of this.frames.values()) inFlight += x.next - x.emit;
    if (inFlight > this.stats.framesInFlightPeak)
      this.stats.framesInFlightPeak = inFlight;
    if (this.bitmapBytes > this.stats.bitmapBytesPeak)
      this.stats.bitmapBytesPeak = this.bitmapBytes;
    const pool = this.pool;
    let w = 0;
    for (let i = 1; i < this.poolLoad.length; i++)
      if (this.poolLoad[i] < this.poolLoad[w]) w = i;
    this.poolLoad[w]++;
    createImageBitmap(canvas)
      .then((bitmap) => {
        if (this.pool !== pool) return bitmap.close();
        pool[w].postMessage(
          { id, seq, bitmap, width, height, dataURLOptions, maxCanvasSize },
          [bitmap],
        );
      })
      .catch(() => {
        if (this.pool !== pool) return;
        this.poolLoad[w] = Math.max(0, this.poolLoad[w] - 1);
        this.onSequencedFrame(id, seq, null);
      });
    return true;
  }

  private startPendingCanvasMutationFlusher() {
    onRequestAnimationFrame(() => this.flushPendingCanvasMutations());
  }

  private startRAFTimestamping() {
    const setLatestRAFTimestamp = (timestamp: DOMHighResTimeStamp) => {
      this.rafStamps.latestId = timestamp;
      onRequestAnimationFrame(setLatestRAFTimestamp);
    };
    onRequestAnimationFrame(setLatestRAFTimestamp);
  }

  flushPendingCanvasMutations() {
    this.pendingCanvasMutations.forEach(
      (_values: canvasMutationCommand[], canvas: HTMLCanvasElement) => {
        const id = this.mirror.getId(canvas);
        this.flushPendingCanvasMutationFor(canvas, id);
      },
    );
    onRequestAnimationFrame(() => this.flushPendingCanvasMutations());
  }

  flushPendingCanvasMutationFor(canvas: HTMLCanvasElement, id: number) {
    if (this.frozen || this.locked) {
      return;
    }

    const valuesWithType = this.pendingCanvasMutations.get(canvas);
    if (!valuesWithType || id === -1) return;

    const values = valuesWithType.map((value) => {
      const { type, ...rest } = value;
      return rest;
    });
    const { type } = valuesWithType[0];

    this.mutationCb({ id, type, commands: values });

    this.pendingCanvasMutations.delete(canvas);
  }
}
