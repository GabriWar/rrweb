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
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });
});
afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.Worker = saved.Worker;
  g.createImageBitmap = saved.createImageBitmap;
  URL.createObjectURL = saved.url as typeof URL.createObjectURL;
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: saved.cores, configurable: true });
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
// one frame per call: more than the 1 ms the 1000 fps sampling throttles to
const gap = () => new Promise<void>((r) => setTimeout(r, 3));

function setup() {
  document.body.innerHTML = '<canvas id="c" width="4" height="4"></canvas>';
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const mirror = createMirror();
  mirror.add(canvas, { id: 7, type: 2, tagName: 'canvas', attributes: {}, childNodes: [] } as never);
  const frames: string[] = [];
  const m = new CanvasManager({
    recordCanvas: true,
    enableManualSnapshot: true,
    mutationCb: (p) => frames.push((p.commands[1].args[0] as { args: Array<{ data: Array<{ base64: string }> }> }).args[0].data[0].base64),
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
    const w = (seq: number) => workers[posts.find((p) => p.data.seq === seq)!.worker];
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
