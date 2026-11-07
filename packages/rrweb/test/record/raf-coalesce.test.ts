/**
 * Panopticon RR-016: record({ coalesceMutations: true }) emits at most one
 * mutation event per animation frame without reordering the stream.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, IncrementalSource } from '@rrweb/types';
import type { eventWithTime } from '@rrweb/types';
import record, { flushMutations } from '../../src/record';

const frame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const isMutation = (e: eventWithTime) =>
  e.type === EventType.IncrementalSnapshot &&
  e.data.source === IncrementalSource.Mutation;
const kinds = (events: eventWithTime[]) =>
  events
    .filter((e) => e.type === EventType.IncrementalSnapshot)
    .map((e) => (e.data as { source: number }).source);

function start(coalesceMutations: boolean) {
  document.body.innerHTML = '<div id="root"></div><button id="b">b</button>';
  const events: eventWithTime[] = [];
  const stop = record({
    emit: (e) => events.push(e as eventWithTime),
    coalesceMutations,
  });
  return { events, stop: stop! };
}

async function threeMicrotaskAppends() {
  const root = document.getElementById('root')!;
  for (let i = 0; i < 3; i++) {
    const el = document.createElement('span');
    el.textContent = `n${i}`;
    root.appendChild(el);
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe('coalesceMutations (RR-016)', () => {
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    vi.restoreAllMocks();
  });

  it('baseline: three appends in separate microtasks give three mutation events', async () => {
    const { events, stop } = start(false);
    await threeMicrotaskAppends();
    await frame();
    expect(events.filter(isMutation)).toHaveLength(3);
    stop();
  });

  it('three appends in separate microtasks of one task give one mutation event', async () => {
    const { events, stop } = start(true);
    await threeMicrotaskAppends();
    expect(events.filter(isMutation)).toHaveLength(0);
    await frame();
    const muts = events.filter(isMutation);
    expect(muts).toHaveLength(1);
    const adds = (
      muts[0].data as {
        adds: Array<{ node: { tagName?: string; textContent?: string } }>;
      }
    ).adds;
    expect(adds.filter((a) => a.node.tagName === 'span')).toHaveLength(3);
    expect(
      adds.map((a) => a.node.textContent).filter(Boolean).sort(),
    ).toEqual(['n0', 'n1', 'n2']);
    stop();
  });

  it('a click between mutations flushes the frame first: mutation, then click', async () => {
    const { events, stop } = start(true);
    document.getElementById('root')!.appendChild(document.createElement('i'));
    await Promise.resolve();
    await Promise.resolve();
    document
      .getElementById('b')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));
    expect(kinds(events)).toEqual([
      IncrementalSource.Mutation,
      IncrementalSource.MouseInteraction,
    ]);
    stop();
  });

  it('a hidden document (no animation frames) flushes within 150 ms', async () => {
    const { events, stop } = start(true);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 0);
    document.getElementById('root')!.appendChild(document.createElement('i'));
    await Promise.resolve();
    expect(events.filter(isMutation)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(events.filter(isMutation)).toHaveLength(1);
    raf.mockRestore();
    stop();
  });

  it('flushMutations() and stop() emit what the frame buffered', async () => {
    const { events, stop } = start(true);
    document.getElementById('root')!.appendChild(document.createElement('i'));
    await Promise.resolve();
    flushMutations();
    expect(events.filter(isMutation)).toHaveLength(1);
    document.getElementById('root')!.appendChild(document.createElement('u'));
    await Promise.resolve();
    stop();
    expect(events.filter(isMutation)).toHaveLength(2);
  });
});
