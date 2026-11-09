/**
 * Panopticon item 8: the canvas manager captures every animation frame
 * (never skipping one because an earlier frame is still being encoded),
 * spreads them over a pool of workers, emits them in capture order and
 * drops a frame only when its bytes equal the previous frame's.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMirror } from 'rrweb-snapshot';
import { CanvasManager } from '../../src/record/observers/canvas/canvas-manager';

type Post = { worker: number; data: { id: number; seq?: number } };

let posts: Post[] = [];
let workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  index = workers.length;
  constructor() {
    workers.push(this);
  }
  postMessage(data: { id: number; seq?: number }) {
    posts.push({ worker: this.index, data });
  }
  terminate() {}
  answer(data: unknown) {
    this.onmessage?.({ data });
  }
}

const saved: Record<string, unknown> = {};
beforeEach(() => {
  posts = [];
  workers = [];
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of ['Worker', 'createImageBitmap']) saved[k] = g[k];
  saved.url = URL.createObjectURL;
  saved.cores = navigator.hardwareConcurrency;
  g.Worker = FakeWorker;
  g.createImageBitmap = () => Promise.resolve({ close() {} });
  URL.createObjectURL = () => 'blob:worker';
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    value: 8,
    configurable: true,
  });
});
afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.Worker = saved.Worker;
  g.createImageBitmap = saved.createImageBitmap;
  URL.createObjectURL = saved.url as typeof URL.createObjectURL;
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    value: saved.cores,
    configurable: true,
  });
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
// one frame per call: more than the 1 ms the 1000 fps sampling throttles to
const gap = () => new Promise<void>((r) => setTimeout(r, 3));

function setup() {
  document.body.innerHTML = '<canvas id="c" width="4" height="4"></canvas>';
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const mirror = createMirror();
  mirror.add(canvas, {
    id: 7,
    type: 2,
    tagName: 'canvas',
    attributes: {},
    childNodes: [],
  } as never);
  const frames: string[] = [];
  const m = new CanvasManager({
    recordCanvas: true,
    enableManualSnapshot: true,
    mutationCb: (p) =>
      frames.push(
        (
          p.commands[1].args[0] as {
            args: Array<{ data: Array<{ base64: string }> }>;
          }
        ).args[0].data[0].base64,
      ),
    win: window as never,
    blockClass: 'rr-block',
    blockSelector: null,
    unblockSelector: null,
    mirror,
    dataURLOptions: { type: 'image/png' },
    sampling: 1000,
  });
  return { m, canvas, frames };
}

const reply = (seq: number, base64: string, transparent = false) => ({
  id: 7,
  seq,
  transparent,
  type: 'image/png',
  base64,
  width: 4,
  height: 4,
});

describe('canvas frames: every frame, in order, exact repeats only dropped (item 8)', () => {
  it('captures a frame on every call while earlier ones are still encoding, over a pool of workers', async () => {
    const { m, canvas } = setup();
    expect(workers.length).toBe(3);
    for (let i = 0; i < 6; i++) {
      m.snapshot(canvas, { skipRequestAnimationFrame: true });
      await gap();
    }
    await tick();
    const seqs = posts.filter((p) => p.data.seq !== undefined);
    expect(seqs.map((p) => p.data.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    // spread: no worker got all of them
    expect(new Set(seqs.map((p) => p.worker)).size).toBe(3);
    m.reset();
  });

  it('emits in capture order whatever order the workers answer in; drops a frame only when its bytes equal the previous one', async () => {
    const { m, canvas, frames } = setup();
    for (let i = 0; i < 6; i++) {
      m.snapshot(canvas, { skipRequestAnimationFrame: true });
      await gap();
    }
    await tick();
    const w = (seq: number) =>
      workers[posts.find((p) => p.data.seq === seq)!.worker];
    // first frame transparent (nothing to draw, as upstream), then A, A (repeat), B, A, failed
    w(2).answer(reply(2, 'A'));
    w(4).answer(reply(4, 'A'));
    expect(frames).toEqual([]); // 0 and 1 not back yet
    w(1).answer(reply(1, 'A'));
    w(0).answer(reply(0, 'T', true));
    expect(frames).toEqual(['A']); // 1 emitted, 2 repeats it
    w(3).answer(reply(3, 'B'));
    expect(frames).toEqual(['A', 'B', 'A']); // 4 differs from 3: kept, though equal to 1
    w(5).answer({ id: 7, seq: 5 }); // encoding failed: order moves on
    await gap();
    m.snapshot(canvas, { skipRequestAnimationFrame: true });
    await tick();
    workers[posts[posts.length - 1].worker].answer(reply(6, 'C'));
    expect(frames).toEqual(['A', 'B', 'A', 'C']);
    m.reset();
  });
});

/** The frame loop itself (no manual snapshot): rAF-driven, with the dirty observer installed. */
function setupLoop() {
  // jsdom has no 2D context: a stand-in prototype the dirty observer patches
  const g = window as unknown as Record<string, unknown>;
  class Ctx2D {
    canvas!: HTMLCanvasElement;
    fillRect() {}
    getImageData() {}
  }
  g.CanvasRenderingContext2D = Ctx2D;
  document.body.innerHTML = '<canvas id="c" width="4" height="4"></canvas>';
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const mirror = createMirror();
  mirror.add(canvas, {
    id: 7,
    type: 2,
    tagName: 'canvas',
    attributes: {},
    childNodes: [],
  } as never);
  const frames: Array<{ base64: string; at?: number }> = [];
  const m = new CanvasManager({
    recordCanvas: true,
    mutationCb: (p, at) =>
      frames.push({
        base64: (
          p.commands[1].args[0] as {
            args: Array<{ data: Array<{ base64: string }> }>;
          }
        ).args[0].data[0].base64,
        at,
      }),
    win: window as never,
    blockClass: 'rr-block',
    blockSelector: null,
    unblockSelector: null,
    mirror,
    dataURLOptions: { type: 'image/png' },
    sampling: 1000,
  });
  const ctx = new Ctx2D();
  ctx.canvas = canvas;
  const restore = () => {
    m.reset();
    delete g.CanvasRenderingContext2D;
  };
  return { m, canvas, ctx, frames, restore };
}

const seqPosts = () => posts.filter((p) => p.data.seq !== undefined);
const answerAll = (
  base64: (seq: number) => string,
  hash?: (seq: number) => string,
) => {
  for (const p of seqPosts().splice(0)) {
    const seq = p.data.seq!;
    workers[p.worker].answer({
      ...reply(seq, base64(seq)),
      ...(hash ? { hash: hash(seq) } : {}),
    });
  }
  posts = posts.filter((p) => p.data.seq === undefined);
};

describe('canvas frames: read only when changed, bounded in flight, stamped when read (item 8 review)', () => {
  it('a canvas seen drawing is read only after a draw, resize or new context; unseen ones every frame', async () => {
    const { m, canvas, ctx, restore } = setupLoop();
    try {
      await new Promise((r) => setTimeout(r, 60));
      // never seen drawing (context older than the recorder?): read every frame
      expect(seqPosts().length).toBeGreaterThan(1);
      answerAll(() => 'A');
      ctx.fillRect(); // now watched, and changed
      await new Promise((r) => setTimeout(r, 40));
      expect(seqPosts()).toHaveLength(1);
      answerAll(() => 'B');
      await new Promise((r) => setTimeout(r, 60));
      expect(seqPosts()).toHaveLength(0); // unchanged: not read back
      expect(m.stats.unchangedSkipped).toBeGreaterThan(0);
      canvas.width = 4; // clears the bitmap even at the same size
      await new Promise((r) => setTimeout(r, 40));
      expect(seqPosts()).toHaveLength(1);
      expect(canvas.width).toBe(4); // the getter still works
    } finally {
      restore();
    }
  });

  it('stops reading a canvas while 8 of its frames are on their way, and keeps it marked changed', async () => {
    const { m, ctx, restore } = setupLoop();
    try {
      ctx.fillRect();
      for (let i = 0; i < 12; i++) {
        ctx.fillRect();
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(seqPosts()).toHaveLength(8);
      expect(m.stats.deferred).toBeGreaterThan(0);
      expect(m.stats.framesInFlightPeak).toBe(8);
      expect(m.stats.bitmapBytesPeak).toBe(8 * 4 * 4 * 4);
      answerAll((s) => `F${s}`);
      // no draw since: the deferred change is still read
      await new Promise((r) => setTimeout(r, 40));
      expect(seqPosts().length).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });

  it('each frame carries the instant it was read, not when the worker answered', async () => {
    const { ctx, frames, restore } = setupLoop();
    try {
      const before = Date.now();
      ctx.fillRect();
      await new Promise((r) => setTimeout(r, 30));
      const readBy = Date.now();
      await new Promise((r) => setTimeout(r, 60));
      const p = seqPosts()[0];
      workers[p.worker].answer(reply(p.data.seq!, 'X'));
      const f = frames[frames.length - 1];
      expect(f.base64).toBe('X');
      expect(f.at).toBeGreaterThanOrEqual(before);
      expect(f.at).toBeLessThanOrEqual(readBy);
    } finally {
      restore();
    }
  });

  it("repeats are found by the worker's sha-256, the manager keeps only that hash, and forgets a canvas that left the page", async () => {
    const { m, canvas, frames, restore } = setupLoop();
    try {
      await new Promise((r) => setTimeout(r, 60));
      // different bytes in the test stand-in, same hash: the hash decides
      answerAll(
        (s) => `P${s}`,
        () => 'H1',
      );
      expect(frames).toHaveLength(1);
      const f = (
        m as unknown as { frames: Map<number, { last: string }> }
      ).frames.get(7)!;
      expect(f.last).toBe('H1');
      canvas.remove();
      answerAll(
        () => 'Q',
        () => 'H2',
      );
      await new Promise((r) => setTimeout(r, 40));
      expect(
        (m as unknown as { frames: Map<number, unknown> }).frames.has(7),
      ).toBe(false);
    } finally {
      restore();
    }
  });
});

/** A WebGL stand-in whose context may discard its drawing buffer once shown (preserveDrawingBuffer false). */
function setupGl(preserve: boolean, canvasAttrs = '') {
  const g = window as unknown as Record<string, unknown>;
  class Gl {
    canvas!: HTMLCanvasElement;
    clear() {}
    drawArrays() {}
    getContextAttributes() {
      return { preserveDrawingBuffer: preserve };
    }
  }
  g.WebGLRenderingContext = Gl;
  document.body.innerHTML = `<canvas id="c" width="4" height="4" ${canvasAttrs}></canvas>`;
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const mirror = createMirror();
  mirror.add(canvas, {
    id: 7,
    type: 2,
    tagName: 'canvas',
    attributes: {},
    childNodes: [],
  } as never);
  const m = new CanvasManager({
    recordCanvas: true,
    mutationCb: () => undefined,
    win: window as never,
    blockClass: 'rr-block',
    blockSelector: null,
    unblockSelector: null,
    mirror,
    dataURLOptions: { type: 'image/png' },
    sampling: 1000,
  });
  const gl = new Gl();
  gl.canvas = canvas;
  // which task each read happened in: true while the drawing task runs
  const reads: boolean[] = [];
  let drawing = false;
  (globalThis as unknown as Record<string, unknown>).createImageBitmap = () => {
    reads.push(drawing);
    return Promise.resolve({ close() {} });
  };
  // a draw in a task of its own; the flag drops in the next task
  const drawTask = () =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        drawing = true;
        gl.clear();
        gl.drawArrays();
        setTimeout(() => {
          drawing = false;
          resolve();
        }, 0);
      }, 0),
    );
  const restore = () => {
    m.reset();
    delete g.WebGLRenderingContext;
  };
  return { m, gl, reads, drawTask, restore };
}

describe('canvas frames: a WebGL buffer the browser clears once shown is read in the task that drew it (item 8)', () => {
  it('preserveDrawingBuffer false: every drawing task is read before it ends, once per task', async () => {
    const { reads, drawTask, restore } = setupGl(false);
    try {
      await new Promise((r) => setTimeout(r, 40)); // the loop's first reads (canvas not seen drawing yet)
      reads.length = 0;
      await drawTask();
      await drawTask(); // two draws within one animation frame: two frames
      expect(reads).toEqual([true, true]);
      await new Promise((r) => setTimeout(r, 40));
      expect(reads).toEqual([true, true]); // the frame loop does not read it again
    } finally {
      restore();
    }
  });

  it('a preserved buffer is left to the frame loop; a blocked canvas is never read', async () => {
    const kept = setupGl(true);
    try {
      await new Promise((r) => setTimeout(r, 40));
      kept.reads.length = 0;
      await kept.drawTask();
      expect(kept.reads).toEqual([]);
      await new Promise((r) => setTimeout(r, 40));
      expect(kept.reads).toEqual([false]);
    } finally {
      kept.restore();
    }
    const blocked = setupGl(false, 'class="rr-block"');
    try {
      await blocked.drawTask();
      await new Promise((r) => setTimeout(r, 40));
      expect(blocked.reads).toEqual([]);
    } finally {
      blocked.restore();
    }
  });
});
