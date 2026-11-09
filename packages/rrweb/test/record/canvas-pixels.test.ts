/**
 * Panopticon item 8: with a canvas manager that encodes frames off the main
 * thread, a full snapshot's canvas pixels are captured when the snapshot is
 * taken and encoded there too (no synchronous toDataURL); the Meta and the
 * FullSnapshot wait for them, carry them as rr_dataURL, and every event
 * recorded meanwhile follows with its own timestamp.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import { describe, expect, it } from 'vitest';
import { EventType, IncrementalSource } from '@rrweb/types';
import type { eventWithTime, serializedNodeWithId } from '@rrweb/types';
import { cleanupSnapshot } from 'rrweb-snapshot';
import record, { flushMutations } from '../../src/record';
import { CanvasManagerNoop } from '../../src/record/observers/canvas/canvas-manager';

const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

function canvasOf(
  sn: serializedNodeWithId,
  id: string,
): Record<string, unknown> | null {
  if (sn.type === 2 && sn.attributes.id === id) return sn.attributes;
  if ('childNodes' in sn)
    for (const c of sn.childNodes) {
      const a = canvasOf(c, id);
      if (a) return a;
    }
  return null;
}

/** A canvas manager whose worker answers when the test says so. */
function fakeManager() {
  const requests: Array<{
    canvas: HTMLCanvasElement;
    fill: (u: string | null) => void;
  }> = [];
  class Fake extends CanvasManagerNoop {
    capturePixels(
      canvas: HTMLCanvasElement,
      _o: unknown,
      fill: (u: string | null) => void,
    ) {
      requests.push({ canvas, fill });
      return true;
    }
    // the copy made when the pixels were asked for (item 8 review)
    flushPixels() {
      for (const r of requests.splice(0))
        r.fill(`data:image/png;base64,COPY-${r.canvas.id}`);
    }
  }
  return { requests, get: () => new Fake() };
}

function page() {
  document.body.innerHTML =
    '<canvas id="a" width="4" height="4"></canvas><canvas id="b" width="4" height="4"></canvas>' +
    '<div class="rr-block"><canvas id="c" width="4" height="4"></canvas></div><p id="t">x</p>';
  cleanupSnapshot();
}

describe('full snapshot canvas pixels off the main thread (item 8)', () => {
  it('Meta and FullSnapshot wait for the pixels; events recorded meanwhile follow, with their own times', async () => {
    page();
    const m = fakeManager();
    const events: eventWithTime[] = [];
    const stop = record({
      emit: (e) => events.push(e as eventWithTime),
      recordCanvas: true,
      getCanvasManager: m.get as never,
    })!;
    // the blocked canvas is never captured (its placeholder has no pixels)
    expect(m.requests.map((r) => r.canvas.id)).toEqual(['a', 'b']);
    expect(events).toEqual([]);
    await tick(5);
    document.getElementById('t')!.textContent = 'y';
    await tick();
    const changedAt = Date.now();
    expect(events).toEqual([]);
    m.requests[0].fill('data:image/png;base64,AAAA');
    await tick();
    expect(events).toEqual([]); // one canvas still on its way
    m.requests[1].fill(null); // blank: no rr_dataURL, as the synchronous blank check decides
    expect(events.map((e) => e.type).slice(0, 2)).toEqual([
      EventType.Meta,
      EventType.FullSnapshot,
    ]);
    const full = events[1];
    // stamped when it was taken, as the synchronous path stamps it
    expect(full.timestamp).toBeGreaterThanOrEqual(events[0].timestamp);
    const node = (full.data as { node: serializedNodeWithId }).node;
    expect(canvasOf(node, 'a')!.rr_dataURL).toBe('data:image/png;base64,AAAA');
    expect(canvasOf(node, 'b')!.rr_dataURL).toBeUndefined();
    expect(canvasOf(node, 'c')).toBeNull(); // blocked: placeholder, no canvas attributes
    // the snapshot is the page as of its start: the text change is a mutation after it
    expect(JSON.stringify(node)).toContain('"textContent":"x"');
    const mut = events.find(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.Mutation,
    )!;
    expect(JSON.stringify(mut.data)).toContain('"textContent":"y"');
    expect(mut.timestamp).toBeGreaterThan(full.timestamp);
    expect(mut.timestamp).toBeLessThanOrEqual(changedAt);
    stop();
  });

  it('the asset hook takes the pixels after the Meta, with the FullSnapshot that carries them', async () => {
    page();
    const m = fakeManager();
    const order: string[] = [];
    const big = 'data:image/png;base64,' + 'A'.repeat(2000);
    const stop = record({
      emit: (e) =>
        order.push(
          e.type === EventType.Meta
            ? 'meta'
            : e.type === EventType.FullSnapshot
            ? `full ${JSON.stringify(e.data).includes('"__m__/1"')}`
            : String(e.type),
        ),
      recordCanvas: true,
      getCanvasManager: m.get as never,
      assetHook: (kind, v) =>
        v.length >= 1024 ? (order.push(`hook ${kind}`), '__m__/1') : null,
    })!;
    m.requests[1].fill(null);
    m.requests[0].fill(big);
    expect(order.slice(0, 3)).toEqual(['meta', 'hook media', 'full true']);
    stop();
  });

  it('stop() while the pixels are on their way: nothing is emitted, late pixels are ignored', async () => {
    page();
    const m = fakeManager();
    const events: eventWithTime[] = [];
    const stop = record({
      emit: (e) => events.push(e as eventWithTime),
      recordCanvas: true,
      getCanvasManager: m.get as never,
    })!;
    stop();
    m.requests[0].fill('data:image/png;base64,AAAA');
    m.requests[1].fill(null);
    await tick();
    expect(events).toEqual([]);
  });

  it('flushMutations() (unload) sends the snapshot without waiting, the canvas still on its way with the pixels copied when they were asked for (item 8 review)', async () => {
    page();
    const m = fakeManager();
    const events: eventWithTime[] = [];
    const stop = record({
      emit: (e) => events.push(e as eventWithTime),
      recordCanvas: true,
      getCanvasManager: m.get as never,
    })!;
    m.requests.shift()!.fill('data:image/png;base64,AAAA');
    flushMutations();
    expect(events.map((e) => e.type).slice(0, 2)).toEqual([
      EventType.Meta,
      EventType.FullSnapshot,
    ]);
    const node = (events[1].data as { node: serializedNodeWithId }).node;
    expect(canvasOf(node, 'a')!.rr_dataURL).toBe('data:image/png;base64,AAAA');
    expect(canvasOf(node, 'b')!.rr_dataURL).toBe(
      'data:image/png;base64,COPY-b',
    );
    stop();
  });

  it('without a worker (the manager cannot capture) the snapshot reads the canvas itself, synchronously', () => {
    page();
    const events: eventWithTime[] = [];
    const stop = record({
      emit: (e) => events.push(e as eventWithTime),
      recordCanvas: true,
      getCanvasManager: (() => new CanvasManagerNoop()) as never,
    })!;
    expect(events.map((e) => e.type).slice(0, 2)).toEqual([
      EventType.Meta,
      EventType.FullSnapshot,
    ]);
    stop();
  });
});
