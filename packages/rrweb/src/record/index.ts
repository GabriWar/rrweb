import {
  snapshot,
  snapshotSliced,
  setAssetHook,
  setCanvasPixelsHook,
  applyDeferredAssetHooks,
  setAssetDeferral,
  freezeDocument,
  type FrozenDocument,
  slimDOMDefaults,
  type MaskInputOptions,
  createMirror,
} from 'rrweb-snapshot';
import { getIFrameContentWindow } from 'rrdom';
import { initObservers, mutationBuffers } from './observer';
import {
  flushCoalescedMutations,
  hasCoalescedMutations,
  setMutationCoalescing,
} from './mutation';
import {
  on,
  getWindowWidth,
  getWindowHeight,
  getWindowScroll,
  polyfill,
  hasShadowRoot,
  isSerializedIframe,
  isSerializedStylesheet,
  nowTimestamp,
} from '../utils';
import type { recordOptions } from '../types';
import {
  EventType,
  type annotationData,
  type eventWithoutTime,
  type eventWithTime,
  IncrementalSource,
  type listenerHandler,
  type mutationCallbackParam,
  type scrollCallback,
  type canvasMutationParam,
  type adoptedStyleSheetParam,
  type IWindow,
  type serializedElementNodeWithId,
  type serializedNodeWithId,
} from '@rrweb/types';
import type { CrossOriginIframeMessageEventContent } from '../types';
import {
  IframeManager,
  IframeManagerInterface,
  IframeManagerNoop,
  SameOriginIframeManager,
} from './iframe-manager';
import {
  ShadowDomManager,
  ShadowDomManagerInterface,
  ShadowDomManagerNoop,
} from './shadow-dom-manager';
import {
  CanvasManagerConstructorOptions,
  CanvasManagerInterface,
  CanvasManagerNoop,
} from './observers/canvas/canvas-manager';
import { StylesheetManager } from './stylesheet-manager';
import ProcessedNodeManager from './processed-node-manager';
import {
  callbackWrapper,
  registerErrorHandler,
  unregisterErrorHandler,
} from './error-handler';
import dom from '@rrweb/utils';

export type { CanvasManagerConstructorOptions } from './observers/canvas/canvas-manager';

declare global {
  const __RRWEB_EXCLUDE_SHADOW_DOM__: boolean;
  const __RRWEB_EXCLUDE_IFRAME__: boolean;
  /**
   * Panopticon: drop cross-origin iframe recording (the postMessage bridge,
   * event id transforms and CrossOriginIframeMirror). Same-origin iframes
   * and shadow DOM are unaffected.
   */
  const __RRWEB_EXCLUDE_CROSS_ORIGIN_IFRAME__: boolean;
  /**
   * Panopticon replay gate: compile `pano:rec:*` performance measures in.
   * Production builds define it false, so the guarded code is dropped.
   */
  const __PANO_BENCH__: boolean;
}

let wrappedEmit!: (
  e: eventWithoutTime,
  isCheckout?: boolean,
  timestamp?: number,
) => void;

// These are stored in module scope because we access them in other exported methods
let _wrappedEmit:
  | undefined
  | ((e: eventWithTime, isCheckout?: boolean) => void);
let _takeFullSnapshot: undefined | ((isCheckout?: boolean) => void);
let _freezeCanvas: undefined | (() => void);

// Multiple tools (i.e. MooTools, Prototype.js) override Array.from and drop support for the 2nd parameter
// Try to pull a clean implementation from a newly created iframe
try {
  if (Array.from([1], (x) => x * 2)[0] !== 2) {
    const cleanFrame = document.createElement('iframe');
    document.body.appendChild(cleanFrame);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Array.from is static and doesn't rely on binding
    Array.from = cleanFrame.contentWindow?.Array.from || Array.from;
    document.body.removeChild(cleanFrame);
  }
} catch (err) {
  console.debug('Unable to override Array.from', err);
}

const mirror = createMirror();

/** Sliced snapshot (RR-017): wall-time cap after which the rest runs at once. */
const SLICE_MAX_WALL_MS = 5000;
let activeSlicing: { cancelled: boolean; finish: () => void } | null = null;
/** Rejection that ends a sliced snapshot whose recording was stopped. */
const SLICE_CANCELLED = new Error('rrweb: snapshot cancelled by stop()');

/**
 * Give the page a turn: scheduler.yield() where available, else a
 * user-visible scheduler.postTask(), else a MessageChannel message. Never
 * setTimeout (4 ms clamping) or requestIdleCallback (starves on busy pages).
 */
function yieldToPage(): Promise<void> {
  const s = (
    globalThis as unknown as {
      scheduler?: {
        yield?: () => Promise<void>;
        postTask?: (cb: () => void, o: { priority: string }) => Promise<void>;
      };
    }
  ).scheduler;
  if (s && typeof s.yield === 'function') return s.yield();
  if (s && typeof s.postTask === 'function')
    return s.postTask(() => undefined, { priority: 'user-visible' });
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

function record<T = eventWithTime>(
  options: recordOptions<T> = {},
): listenerHandler | undefined {
  const {
    emit,
    checkoutEveryNms,
    checkoutEveryNth,
    blockClass = 'rr-block',
    blockSelector = null,
    unblockSelector = null,
    ignoreClass = 'rr-ignore',
    ignoreSelector = null,
    maskAllText = false,
    maskTextClass = 'rr-mask',
    unmaskTextClass = null,
    maskTextSelector = null,
    unmaskTextSelector = null,
    inlineStylesheet = true,
    maskAllInputs,
    maskInputOptions: _maskInputOptions,
    slimDOMOptions: _slimDOMOptions,
    maskAttributeFn,
    maskInputFn,
    maskTextFn,
    maxCanvasSize = null,
    packFn,
    sampling = {},
    dataURLOptions = {},
    mousemoveWait,
    recordDOM = true,
    recordCanvas = false,
    recordCrossOriginIframes: _recordCrossOriginIframes = false,
    recordAfter = options.recordAfter === 'DOMContentLoaded'
      ? options.recordAfter
      : 'load',
    userTriggeredOnInput = false,
    collectFonts = false,
    inlineImages = false,
    plugins,
    keepIframeSrcFn = () => false,
    ignoreCSSAttributes = new Set([]),
    errorHandler,
    onMutation,
    getCanvasManager,
    coalesceMutations = false,
    snapshotSliceMs = 0,
    assetHook,
  } = options;

  registerErrorHandler(errorHandler);
  // RR-030: every serialization of this recording goes through the hook
  setAssetHook(assetHook || null);

  const excludeCrossOriginIframes =
    typeof __RRWEB_EXCLUDE_CROSS_ORIGIN_IFRAME__ === 'boolean' &&
    __RRWEB_EXCLUDE_CROSS_ORIGIN_IFRAME__;
  const recordCrossOriginIframes =
    !excludeCrossOriginIframes && _recordCrossOriginIframes;

  const inEmittingFrame = recordCrossOriginIframes
    ? window.parent === window
    : true;

  let passEmitsToParent = false;
  if (!inEmittingFrame) {
    try {
      // throws if parent is cross-origin
      if (window.parent.document) {
        passEmitsToParent = false; // if parent is same origin we collect iframe events from the parent
      }
    } catch (e) {
      passEmitsToParent = true;
    }
  }

  // runtime checks for user options
  if (inEmittingFrame && !emit) {
    throw new Error('emit function is required');
  }
  if (!inEmittingFrame && !passEmitsToParent) {
    return () => {
      /* no-op since in this case we don't need to record anything from this frame in particular */
    };
  }
  // move departed options to new options
  if (mousemoveWait !== undefined && sampling.mousemove === undefined) {
    sampling.mousemove = mousemoveWait;
  }

  // reset mirror in case `record` this was called earlier
  mirror.reset();

  const maskInputOptions: MaskInputOptions =
    maskAllInputs === true
      ? {
          color: true,
          date: true,
          'datetime-local': true,
          email: true,
          month: true,
          number: true,
          range: true,
          search: true,
          tel: true,
          text: true,
          time: true,
          url: true,
          week: true,
          textarea: true,
          select: true,
          radio: true,
          checkbox: true,
        }
      : _maskInputOptions !== undefined
      ? _maskInputOptions
      : {};

  const slimDOMOptions = slimDOMDefaults(_slimDOMOptions);

  polyfill();

  setMutationCoalescing(coalesceMutations);

  let lastFullSnapshotEvent: eventWithTime;
  let incrementalSnapshotCount = 0;

  const eventProcessor = (e: eventWithTime): T => {
    for (const plugin of plugins || []) {
      if (plugin.eventProcessor) {
        e = plugin.eventProcessor(e);
      }
    }
    if (
      packFn &&
      // Disable packing events which will be emitted to parent frames.
      !passEmitsToParent
    ) {
      e = packFn(e) as unknown as eventWithTime;
    }
    return e as unknown as T;
  };
  // Sliced full snapshot in progress (snapshotSliceMs): every event recorded
  // meanwhile waits here, stamped, and goes out right after the FullSnapshot.
  type SliceState = {
    queue: Array<[eventWithTime, boolean | undefined]>;
    cancelled: boolean;
    finish: () => void;
  };
  let slicing: SliceState | null = null;
  // Panopticon: set by the stop function. Nothing this recording set up
  // (observers, snapshot load hooks, a sliced snapshot still walking) may
  // emit or serialize after stop().
  let stopped = false;

  wrappedEmit = (
    r: eventWithoutTime,
    isCheckout?: boolean,
    timestamp?: number,
  ) => {
    if (stopped) return;
    // Mutations buffered for this frame go out before anything recorded
    // after them (coalesceMutations); the flush re-enters with its own event.
    if (hasCoalescedMutations()) flushCoalescedMutations();
    const e = r as eventWithTime;
    // Panopticon: an event recorded later than it happened (a canvas frame
    // encoded by a worker) keeps the instant it happened
    e.timestamp = timestamp ?? nowTimestamp();
    if (slicing) {
      slicing.queue.push([e, isCheckout]);
      return;
    }
    dispatch(e, isCheckout);
  };

  const dispatch = (e: eventWithTime, isCheckout?: boolean) => {
    if (stopped) return;
    if (
      e.type !== EventType.FullSnapshot &&
      !(
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.Mutation
      )
    ) {
      // we've got a user initiated event so if we've been frozen we first need
      // to apply all DOM changes that have been buffering during paused state
      canvasManager.unfreeze();
      for (const buf of mutationBuffers) {
        if (buf.isFrozen()) {
          buf.unfreeze();
        } else {
          break; // just need to check one as they all get frozen together
        }
      }
    }

    if (inEmittingFrame) {
      emit?.(eventProcessor(e), isCheckout);
    } else if (passEmitsToParent) {
      const message: CrossOriginIframeMessageEventContent<T> = {
        type: 'rrweb',
        event: eventProcessor(e),
        origin: window.location.origin,
        isCheckout,
      };
      window.parent.postMessage(message, '*');
    }

    if (e.type === EventType.FullSnapshot) {
      lastFullSnapshotEvent = e;
      incrementalSnapshotCount = 0;
    } else if (e.type === EventType.IncrementalSnapshot) {
      // attach iframe should be considered as full snapshot
      if (
        e.data.source === IncrementalSource.Mutation &&
        e.data.isAttachIframe
      ) {
        return;
      }

      incrementalSnapshotCount++;
      const exceedCount =
        checkoutEveryNth && incrementalSnapshotCount >= checkoutEveryNth;
      const exceedTime =
        checkoutEveryNms &&
        lastFullSnapshotEvent &&
        e.timestamp - lastFullSnapshotEvent.timestamp > checkoutEveryNms;
      if (exceedCount || exceedTime) {
        takeFullSnapshot(true);
      }
    }
  };
  _wrappedEmit = wrappedEmit;

  // These emit through this recording's own closure: a later record() call
  // replaces the module-level wrappedEmit, and a stale hook of this one
  // must not leak into it.
  const ownEmit = wrappedEmit;
  const wrappedMutationEmit = (m: mutationCallbackParam) => {
    ownEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Mutation,
        ...m,
      },
    });
  };
  const wrappedScrollEmit: scrollCallback = (p) =>
    ownEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Scroll,
        ...p,
      },
    });
  const wrappedCanvasMutationEmit = (p: canvasMutationParam) =>
    ownEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.CanvasMutation,
        ...p,
      },
    });

  const wrappedAdoptedStyleSheetEmit = (a: adoptedStyleSheetParam) =>
    ownEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.AdoptedStyleSheet,
        ...a,
      },
    });

  const stylesheetManager = new StylesheetManager({
    mutationCb: wrappedMutationEmit,
    adoptedStyleSheetCb: wrappedAdoptedStyleSheetEmit,
  });

  const iframeManager: IframeManagerInterface =
    typeof __RRWEB_EXCLUDE_IFRAME__ === 'boolean' && __RRWEB_EXCLUDE_IFRAME__
      ? new IframeManagerNoop()
      : excludeCrossOriginIframes
      ? new SameOriginIframeManager({
          mirror,
          mutationCb: wrappedMutationEmit,
          stylesheetManager: stylesheetManager,
        })
      : new IframeManager({
          mirror,
          mutationCb: wrappedMutationEmit,
          stylesheetManager: stylesheetManager,
          recordCrossOriginIframes,
          wrappedEmit,
        });

  /**
   * Exposes mirror to the plugins
   */
  for (const plugin of plugins || []) {
    if (plugin.getMirror)
      plugin.getMirror({
        nodeMirror: mirror,
        crossOriginIframeMirror: iframeManager.crossOriginIframeMirror,
        crossOriginIframeStyleMirror:
          iframeManager.crossOriginIframeStyleMirror,
      });
  }

  const processedNodeManager = new ProcessedNodeManager();

  const canvasManager: CanvasManagerInterface = _getCanvasManager(
    getCanvasManager,
    {
      mirror,
      win: window,
      mutationCb: (p: canvasMutationParam, timestamp?: number) =>
        wrappedEmit(
          {
            type: EventType.IncrementalSnapshot,
            data: {
              source: IncrementalSource.CanvasMutation,
              ...p,
            },
          },
          undefined,
          timestamp,
        ),
      recordCanvas,
      blockClass,
      blockSelector,
      unblockSelector,
      maxCanvasSize,
      sampling: sampling['canvas'],
      dataURLOptions,
      errorHandler,
    },
  );
  _freezeCanvas = () => canvasManager.freeze();

  const shadowDomManager: ShadowDomManagerInterface =
    typeof __RRWEB_EXCLUDE_SHADOW_DOM__ === 'boolean' &&
    __RRWEB_EXCLUDE_SHADOW_DOM__
      ? new ShadowDomManagerNoop()
      : new ShadowDomManager({
          mutationCb: wrappedMutationEmit,
          scrollCb: wrappedScrollEmit,
          bypassOptions: {
            onMutation,
            blockClass,
            blockSelector,
            unblockSelector,
            maskAllText,
            maskTextClass,
            unmaskTextClass,
            maskTextSelector,
            unmaskTextSelector,
            inlineStylesheet,
            maskInputOptions,
            dataURLOptions,
            maskAttributeFn,
            maskTextFn,
            maskInputFn,
            recordCanvas,
            inlineImages,
            sampling,
            slimDOMOptions,
            iframeManager,
            stylesheetManager,
            canvasManager,
            keepIframeSrcFn,
            processedNodeManager,
            ignoreCSSAttributes,
          },
          mirror,
        });

  const takeFullSnapshot = (isCheckout = false) => {
    if (!recordDOM) {
      return;
    }
    if (snapshotSliceMs > 0 && takeFullSnapshotSliced(isCheckout)) return;
    takeFullSnapshotNow(isCheckout);
  };
  /** The full snapshot in one synchronous step (or waiting for canvas pixels only). */
  const takeFullSnapshotNow = (isCheckout = false) => {
    if (!recordDOM) return;
    // Panopticon item 8: with canvas frames recorded by the worker, the
    // snapshot's canvases are captured as ImageBitmaps and encoded there
    // (same PNG bytes as toDataURL); Meta and FullSnapshot wait for them,
    // with every event recorded meanwhile queued behind them.
    const pixels =
      !slicing && recordCanvas && canvasManager.capturePixels
        ? { pending: 0, done: null as null | (() => void) }
        : null;
    if (pixels) {
      const meta = {
        type: EventType.Meta,
        data: {
          href: window.location.href,
          width: getWindowWidth(),
          height: getWindowHeight(),
        },
        timestamp: nowTimestamp(),
      } as eventWithTime;
      // values for the asset hook wait for the Meta (dispatchSnapshot)
      setAssetDeferral(true);
      const prevHook = setCanvasPixelsHook((canvas, options, fill) => {
        const taken = canvasManager.capturePixels!(canvas, options, (url) => {
          fill(url);
          pixels.pending--;
          if (pixels.pending === 0) pixels.done?.();
        });
        if (taken) pixels.pending++;
        return taken;
      });
      let node: serializedNodeWithId | null;
      try {
        node = serializeFullSnapshot();
      } finally {
        setCanvasPixelsHook(prevHook);
      }
      const full = node
        ? ({
            type: EventType.FullSnapshot,
            data: { node, initialOffset: getWindowScroll(window) },
            timestamp: nowTimestamp(),
          } as eventWithTime)
        : null;
      if (!pixels.pending) {
        dispatchSnapshot(meta, full, isCheckout, []);
        afterSnapshot(node);
        return;
      }
      holdForPixels(meta, full, isCheckout, pixels, node);
      return;
    }
    wrappedEmit(
      {
        type: EventType.Meta,
        data: {
          href: window.location.href,
          width: getWindowWidth(),
          height: getWindowHeight(),
        },
      },
      isCheckout,
    );

    // When we take a full snapshot, old tracked StyleSheets need to be removed.
    stylesheetManager.reset();

    shadowDomManager.init();

    canvasManager.lock();
    mutationBuffers.forEach((buf) => buf.lock()); // don't allow any mirror modifications during snapshotting
    const benchStart =
      typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__
        ? performance.now()
        : 0;
    const node = snapshot(document, snapshotOptions());

    if (typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__) {
      performance.measure('pano:rec:snapshot', {
        start: benchStart,
        end: performance.now(),
      });
    }

    if (!node) {
      return console.warn('Failed to snapshot the document');
    }

    wrappedEmit({
      type: EventType.FullSnapshot,
      data: {
        node,
        initialOffset: getWindowScroll(window),
      },
    });
    canvasManager.unlock();
    mutationBuffers.forEach((buf) => buf.unlock()); // generate & emit any mutations that happened during snapshotting, as can now apply against the newly built mirror

    // Some old browsers don't support adoptedStyleSheets.
    if (document.adoptedStyleSheets && document.adoptedStyleSheets.length > 0)
      stylesheetManager.adoptStyleSheets(
        document.adoptedStyleSheets,
        mirror.getId(document),
      );
  };
  /** The synchronous snapshot with buffers locked, as takeFullSnapshot does it. */
  const serializeFullSnapshot = (): serializedNodeWithId | null => {
    stylesheetManager.reset();
    shadowDomManager.init();
    canvasManager.lock();
    mutationBuffers.forEach((buf) => buf.lock());
    const benchStart =
      typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__
        ? performance.now()
        : 0;
    const node = snapshot(document, snapshotOptions());
    if (typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__) {
      performance.measure('pano:rec:snapshot', {
        start: benchStart,
        end: performance.now(),
      });
    }
    return node;
  };
  /** Meta + FullSnapshot in one synchronous step, then what queued behind. */
  const dispatchSnapshot = (
    meta: eventWithTime,
    full: eventWithTime | null,
    isCheckout: boolean,
    queue: Array<[eventWithTime, boolean | undefined]>,
  ) => {
    if (hasCoalescedMutations()) flushCoalescedMutations();
    dispatch(meta, isCheckout);
    // after the Meta (which starts a new side table in the recorder),
    // before the event that carries them
    applyDeferredAssetHooks();
    setAssetDeferral(false);
    if (!full) console.warn('Failed to snapshot the document');
    else dispatch(full);
    for (const [e, c] of queue) dispatch(e, c);
  };
  /** What the synchronous path does once its FullSnapshot is out. */
  const afterSnapshot = (node: serializedNodeWithId | null) => {
    canvasManager.unlock();
    mutationBuffers.forEach((buf) => buf.unlock());
    if (
      node &&
      document.adoptedStyleSheets &&
      document.adoptedStyleSheets.length > 0
    )
      stylesheetManager.adoptStyleSheets(
        document.adoptedStyleSheets,
        mirror.getId(document),
      );
  };
  /**
   * The snapshot is complete as of its start, only its canvas pixels are
   * still being encoded: observers run (buffers unlocked, so mutations keep
   * their own times) and every event is queued until the last pixels land.
   * flushMutations() (unload) cannot wait for the worker: it sends what is
   * there, canvases whose pixels are still on their way without them, the
   * same as a canvas the recorder cannot read. stop() drops the snapshot.
   */
  const holdForPixels = (
    meta: eventWithTime,
    full: eventWithTime | null,
    isCheckout: boolean,
    pixels: { pending: number; done: null | (() => void) },
    node: serializedNodeWithId | null,
  ) => {
    let completed = false;
    const state: SliceState = {
      queue: [],
      cancelled: false,
      // an early finish (unload) takes the pixels still being encoded
      // from the copies made when they were asked for
      finish: () => {
        canvasManager.flushPixels?.();
        complete();
      },
    };
    const complete = () => {
      if (completed || state.cancelled) return;
      completed = true;
      if (slicing === state) slicing = null;
      if (activeSlicing === state) activeSlicing = null;
      dispatchSnapshot(meta, full, isCheckout, state.queue);
    };
    slicing = state;
    activeSlicing = state;
    pixels.done = complete;
    afterSnapshot(node);
  };
  const snapshotOptions = () => ({
    mirror,
    blockClass,
    blockSelector,
    unblockSelector,
    maskAllText,
    maskTextClass,
    unmaskTextClass,
    maskTextSelector,
    unmaskTextSelector,
    inlineStylesheet,
    maskAllInputs: maskInputOptions,
    maskAttributeFn,
    maskInputFn,
    maskTextFn,
    slimDOM: slimDOMOptions,
    dataURLOptions,
    recordCanvas,
    inlineImages,
    onSerialize: (n: Node) => {
      if (stopped) return;
      if (isSerializedIframe(n, mirror)) {
        iframeManager.addIframe(n as HTMLIFrameElement);
      }
      if (isSerializedStylesheet(n, mirror)) {
        stylesheetManager.trackLinkElement(n as HTMLLinkElement);
      }
      if (hasShadowRoot(n)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        shadowDomManager.addShadowRoot(dom.shadowRoot(n as Node)!, document);
      }
    },
    onIframeLoad: (
      iframe: HTMLIFrameElement,
      childSn: serializedElementNodeWithId,
    ) => {
      if (stopped) return;
      iframeManager.attachIframe(iframe, childSn);
      const contentWindow = getIFrameContentWindow(iframe);
      if (contentWindow) {
        canvasManager.addWindow(contentWindow as IWindow);
      }
      shadowDomManager.observeAttachShadow(iframe);
    },
    onStylesheetLoad: (
      linkEl: HTMLLinkElement,
      childSn: serializedElementNodeWithId,
    ) => {
      if (stopped) return;
      stylesheetManager.attachLinkElement(linkEl, childSn);
    },
    onBlockedImageLoad: (
      _imageEl: HTMLImageElement,
      serializedNode: serializedElementNodeWithId,
      { width, height }: DOMRect,
    ) => {
      if (stopped) return;
      wrappedMutationEmit({
        adds: [],
        removes: [],
        texts: [],
        attributes: [
          {
            id: serializedNode.id,
            attributes: {
              style: {
                width: `${width}px`,
                height: `${height}px`,
              },
            },
          },
        ],
      });
    },
    keepIframeSrcFn,
    ignoreCSSAttributes,
  });

  /**
   * Panopticon RR-017 / item 8: the full snapshot serialized in slices of at
   * most snapshotSliceMs, yielding to the page in between, so a large DOM
   * never blocks the main thread in one long task, and losing nothing: the
   * page is frozen when the snapshot starts (rrweb-snapshot freezeDocument:
   * an inert copy plus what a copy does not carry, every id given and every
   * node in the mirror), the walk serializes the copy, and the observers run
   * from that instant with the buffers unlocked, so every change after it is
   * recorded with its own time against those ids. The stream is the
   * synchronous one: Meta and FullSnapshot as of the start (dispatched
   * together, in one synchronous step, once the walk and its canvas pixels
   * are done), then every event recorded meanwhile, in order.
   *
   * The walk finishes synchronously (same output) when flushMutations() is
   * called (the recorder's unload and buffer-to-session paths). stop()
   * cancels it: nothing of it is emitted. Returns false when the page cannot
   * be frozen (see freezeDocument): the caller takes the synchronous one.
   */
  const takeFullSnapshotSliced = (
    isCheckout: boolean,
    beforeLock?: () => void,
  ): boolean => {
    if (slicing) return true; // a checkout asked for mid-slice: this one covers it
    const bench = typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__;
    const start = performance.now();
    const meta = {
      type: EventType.Meta,
      data: {
        href: window.location.href,
        width: getWindowWidth(),
        height: getWindowHeight(),
      },
      timestamp: nowTimestamp(),
    } as eventWithTime;
    const initialOffset = getWindowScroll(window);
    stylesheetManager.reset();
    shadowDomManager.init();
    const prevHook = setCanvasPixelsHook(
      recordCanvas && canvasManager.capturePixels
        ? (canvas, o, fill) => canvasManager.capturePixels!(canvas, o, fill)
        : null,
    );
    // values for the asset hook wait for the Meta (dispatchSnapshot)
    setAssetDeferral(true);
    let frozen: FrozenDocument | null;
    try {
      frozen = freezeDocument(document, snapshotOptions());
    } catch (err) {
      setAssetDeferral(false);
      throw err;
    } finally {
      setCanvasPixelsHook(prevHook);
    }
    if (!frozen) {
      setAssetDeferral(false);
      return false;
    }
    const f = frozen;
    beforeLock?.();

    let node: serializedNodeWithId | null | undefined;
    let finishNow: (() => serializedNodeWithId | null) | undefined;
    let completed = false;
    const state: SliceState = {
      queue: [],
      cancelled: false,
      finish: () => {
        if (completed || state.cancelled) return;
        if (node === undefined) node = finishNow?.() ?? null;
        // pixels still being encoded come from the copies made when they
        // were asked for, so the snapshot never goes out without them
        canvasManager.flushPixels?.();
        complete();
      },
    };
    slicing = state;
    activeSlicing = state;
    let sliceStart = start;
    // a slice is open while the walk runs; the wait for canvas pixels
    // after the last slice is not main-thread work
    let sliceOpen = true;
    const endSlice = () => {
      if (!sliceOpen) return;
      sliceOpen = false;
      if (bench)
        performance.measure('pano:rec:snapshot', {
          start: sliceStart,
          end: performance.now(),
        });
    };
    const complete = () => {
      if (completed) return;
      completed = true;
      endSlice();
      if (bench)
        performance.measure('pano:rec:snapshot-wall', {
          start,
          end: performance.now(),
        });
      if (slicing === state) slicing = null;
      if (activeSlicing === state) activeSlicing = null;
      if (state.cancelled) {
        setAssetDeferral(false);
        return;
      }
      dispatchSnapshot(
        meta,
        node
          ? ({
              type: EventType.FullSnapshot,
              data: { node, initialOffset },
              timestamp: meta.timestamp,
            } as eventWithTime)
          : null,
        isCheckout,
        state.queue,
      );
    };
    f.onPixels = () => {
      if (node !== undefined) complete();
    };
    void snapshotSliced(
      document,
      snapshotOptions(),
      {
        // Starvation guard: past 5 s of wall time the rest runs in one go.
        // A stopped recording ends the walk at the next node instead.
        shouldYield: () => {
          if (state.cancelled) return true;
          const now = performance.now();
          return (
            now - sliceStart >= snapshotSliceMs &&
            now - start < SLICE_MAX_WALL_MS
          );
        },
        yieldSlice: () => {
          endSlice();
          if (state.cancelled) return Promise.reject(SLICE_CANCELLED);
          return yieldToPage().then(() => {
            // stop() ran while the page had its turn: not one more node
            if (state.cancelled) throw SLICE_CANCELLED;
            sliceStart = performance.now();
            sliceOpen = true;
          });
        },
        control: (fn) => {
          finishNow = fn;
        },
      },
      f,
    )
      .catch((err) => {
        if (err !== SLICE_CANCELLED) console.warn(err);
        return null;
      })
      .then((n) => {
        // finished synchronously already: the rejected yield is moot
        if (completed || node !== undefined) return;
        node = n;
        if (state.cancelled) return complete();
        if (f.pending === 0) complete();
        else endSlice(); // the pixels are still on their way
      });
    return true;
  };
  _takeFullSnapshot = takeFullSnapshot;

  try {
    const handlers: listenerHandler[] = [];

    const observe = (doc: Document) => {
      return callbackWrapper(initObservers)(
        {
          onMutation,
          mutationCb: wrappedMutationEmit,
          mousemoveCb: (positions, source) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source,
                positions,
              },
            }),
          mouseInteractionCb: (d) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.MouseInteraction,
                ...d,
              },
            }),
          scrollCb: wrappedScrollEmit,
          viewportResizeCb: (d) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.ViewportResize,
                ...d,
              },
            }),
          inputCb: (v) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.Input,
                ...v,
              },
            }),
          mediaInteractionCb: (p) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.MediaInteraction,
                ...p,
              },
            }),
          styleSheetRuleCb: (r) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.StyleSheetRule,
                ...r,
              },
            }),
          styleDeclarationCb: (r) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.StyleDeclaration,
                ...r,
              },
            }),
          canvasMutationCb: wrappedCanvasMutationEmit,
          fontCb: (p) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.Font,
                ...p,
              },
            }),
          selectionCb: (p) => {
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.Selection,
                ...p,
              },
            });
          },
          customElementCb: (c) => {
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.CustomElement,
                ...c,
              },
            });
          },
          blockClass,
          ignoreClass,
          ignoreSelector,
          maskAllText,
          maskTextClass,
          unmaskTextClass,
          maskTextSelector,
          unmaskTextSelector,
          maskInputOptions,
          inlineStylesheet,
          sampling,
          recordDOM,
          recordCanvas,
          inlineImages,
          userTriggeredOnInput,
          collectFonts,
          doc,
          maskAttributeFn,
          maskInputFn,
          maskTextFn,
          keepIframeSrcFn,
          blockSelector,
          unblockSelector,
          slimDOMOptions,
          dataURLOptions,
          mirror,
          iframeManager,
          stylesheetManager,
          shadowDomManager,
          processedNodeManager,
          canvasManager,
          ignoreCSSAttributes,
          plugins:
            plugins
              ?.filter((p) => p.observer)
              ?.map((p) => ({
                observer: p.observer!,
                options: p.options,
                callback: (payload: object) =>
                  wrappedEmit({
                    type: EventType.Plugin,
                    data: {
                      plugin: p.name,
                      payload,
                    },
                  }),
              })) || [],
        },
        {},
      );
    };

    // Observers of same-origin iframe documents, stopped when the document unloads.
    const iframeObservers = new Map<Document, listenerHandler>();
    iframeManager.addLoadListener((iframeEl) => {
      try {
        const doc = iframeEl.contentDocument!;
        // Iframes are attached again on every full snapshot, but each document needs to be observed only once.
        if (iframeObservers.has(doc)) return;
        iframeObservers.set(doc, observe(doc));
      } catch (error) {
        // TODO: handle internal error
        console.warn(error);
      }
    });
    iframeManager.addUnloadListener((doc) => {
      const stopObserving = iframeObservers.get(doc);
      if (!stopObserving) return;
      iframeObservers.delete(doc);
      stopObserving();
      shadowDomManager.removeShadowRootsIn(doc);
      mirror.removeNodeFromMap(doc);
    });

    const init = () => {
      if (
        snapshotSliceMs > 0 &&
        recordDOM &&
        // sliced: the page runs during the snapshot, so observers start
        // right after the freeze
        takeFullSnapshotSliced(false, () => handlers.push(observe(document)))
      )
        return;
      takeFullSnapshotNow();
      handlers.push(observe(document));
    };
    if (['interactive', 'complete'].includes(document.readyState)) {
      init();
    } else {
      handlers.push(
        on('DOMContentLoaded', () => {
          wrappedEmit({
            type: EventType.DomContentLoaded,
            data: {},
          });
          if (recordAfter === 'DOMContentLoaded') init();
        }),
      );
      handlers.push(
        on(
          'load',
          () => {
            wrappedEmit({
              type: EventType.Load,
              data: {},
            });
            if (recordAfter === 'load') init();
          },
          window,
        ),
      );
    }
    return () => {
      if (slicing) slicing.cancelled = true;
      if (activeSlicing) {
        // stopped mid-snapshot: nothing of it is emitted (the recorder calls
        // flushMutations() first where the snapshot must be kept)
        activeSlicing.cancelled = true;
        activeSlicing = null;
      }
      // mutations of the current frame happened before stop(): they go out
      flushCoalescedMutations();
      setMutationCoalescing(false);
      stopped = true;
      setAssetHook(null);
      setAssetDeferral(false, true);
      [...handlers, ...iframeObservers.values()].forEach((handler) => {
        try {
          handler();
        } catch (error) {
          const msg = String(error).toLowerCase();
          /**
           * https://github.com/rrweb-io/rrweb/pull/1695
           * This error can occur in a known scenario:
           * If an iframe is initially same-origin and observed, but later its 
           location is changed in an opaque way to a cross-origin URL (perhaps within the iframe via its `document.location` or a redirect) 
           * attempting to execute the handler in the stop record function will 
           throw a "cannot access cross-origin frame" error.
           * This error is expected and can be safely ignored.
           */
          if (!msg.includes('cross-origin')) {
            console.warn(error);
          }
        }
      });
      iframeObservers.clear();
      iframeManager.destroy();
      processedNodeManager.destroy();
      _takeFullSnapshot = undefined;
      // addCustomEvent / addAnnotation throw once stopped, as upstream's
      // `recording` flag makes them
      _wrappedEmit = undefined;
      _freezeCanvas = undefined;
      shadowDomManager.reset();
      canvasManager.reset();
      unregisterErrorHandler();
    };
  } catch (error) {
    // TODO: handle internal error
    console.warn(error);
  }
}

export function addCustomEvent<T>(tag: string, payload: T) {
  if (!_wrappedEmit) {
    throw new Error('please add custom event after start recording');
  }
  wrappedEmit({
    type: EventType.Custom,
    data: {
      tag,
      payload,
    },
  });
}

/**
 * Emit the mutations buffered for the current frame now (coalesceMutations).
 * A sliced snapshot still walking finishes synchronously first, so its Meta,
 * FullSnapshot and the events queued behind it go out too. Call before
 * shipping events on page hide/unload, or before stop() when the recording
 * must keep that snapshot.
 */
export function flushMutations() {
  activeSlicing?.finish();
  flushCoalescedMutations();
}

export function addAnnotation(annotation: annotationData) {
  if (!_wrappedEmit) {
    throw new Error('please add annotation after recording started');
  }
  wrappedEmit({ type: EventType.Annotation, data: annotation });
}

export function freezePage() {
  _freezeCanvas?.();
  mutationBuffers.forEach((buf) => buf.freeze());
}

export function takeFullSnapshot(isCheckout?: boolean) {
  if (!_takeFullSnapshot) {
    throw new Error('please take full snapshot after start recording');
  }
  _takeFullSnapshot(isCheckout);
}

// record.addCustomEvent is removed because Sentry Session Replay does not use it
// record.freezePage is removed because Sentry Session Replay does not use it

// For backwards compatibility - we can eventually remove this when we migrated to using the exported `mirror` & `takeFullSnapshot`
record.mirror = mirror;
record.takeFullSnapshot = takeFullSnapshot;
// upstream rrweb's public annotation API (record.addAnnotation)
record.addAnnotation = addAnnotation;

export default record;

function _getCanvasManager(
  getCanvasManagerFn:
    | undefined
    | ((
        options: Partial<CanvasManagerConstructorOptions>,
      ) => CanvasManagerInterface),
  options: CanvasManagerConstructorOptions,
) {
  try {
    return getCanvasManagerFn
      ? getCanvasManagerFn(options)
      : new CanvasManagerNoop();
  } catch {
    console.warn('Unable to initialize CanvasManager');
    return new CanvasManagerNoop();
  }
}
