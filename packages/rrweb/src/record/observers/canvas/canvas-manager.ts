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
import { isBlocked, onRequestAnimationFrame } from '../../../utils';
import { CanvasContext } from '@rrweb/types';
import initCanvas2DMutationObserver from './2d';
import initCanvasContextObserver from './canvas';
import initCanvasWebGLMutationObserver from './webgl';
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
}

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
      last: string | null;
      done: Map<number, ImageBitmapDataURLWorkerResponse | null>;
    }
  >();
  /** Full snapshot pixel requests waiting for the worker, by token. */
  private pixelRequests = new Map<number, (dataURL: string | null) => void>();
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
    this.snapshotInProgressMap = new Map();
    this.pixelRequests.clear();
  }

  public capturePixels(
    canvas: HTMLCanvasElement,
    dataURLOptions: DataURLOptions,
    fill: (dataURL: string | null) => void,
  ): boolean {
    const worker = this.worker;
    if (!worker || !canvas.width || !canvas.height) return false;
    const token = ++this.pixelToken;
    const { width, height } = canvas;
    this.pixelRequests.set(token, fill);
    // the ImageBitmap is the canvas as of this call; encoding happens in
    // the worker, which answers in order with the frames
    createImageBitmap(canvas)
      .then((bitmap) => {
        if (this.worker !== worker) return bitmap.close();
        worker.postMessage(
          { id: -1, initial: token, bitmap, width, height, dataURLOptions },
          [bitmap],
        );
      })
      .catch(() => this.answerPixels(token, null));
    return true;
  }

  private answerPixels(token: number, dataURL: string | null) {
    const fill = this.pixelRequests.get(token);
    if (!fill) return;
    this.pixelRequests.delete(token);
    fill(dataURL);
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
        this.restoreHandlers.push(() => {
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
    while (f.done.has(f.emit)) {
      const d = f.done.get(f.emit)!;
      f.done.delete(f.emit);
      f.emit++;
      if (!d || !('base64' in d)) continue;
      // the first frame of a transparent canvas: nothing to draw (as upstream)
      if (f.last === null && d.transparent) {
        f.last = d.base64;
        continue;
      }
      if (d.base64 === f.last) continue; // byte-identical to the previous frame
      f.last = d.base64;
      this.emitFrame(d);
    }
  }

  private emitFrame(data: ImageBitmapDataURLWorkerResponse) {
    if (!('base64' in data)) return;
    const { id, base64, type, width, height } = data;
    this.mutationCb({
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
    });
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
        this.captureSequenced(canvas, id, dataURLOptions, maxCanvasSize);
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

  private captureSequenced(
    canvas: HTMLCanvasElement,
    id: number,
    dataURLOptions: DataURLOptions,
    maxCanvasSize: MaxCanvasSize | null | undefined,
  ) {
    let f = this.frames.get(id);
    if (!f) {
      f = { next: 0, emit: 0, last: null, done: new Map() };
      this.frames.set(id, f);
    }
    const seq = f.next++;
    const { width, height } = canvas;
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
