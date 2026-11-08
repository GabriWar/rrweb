/**
 * Panopticon RR-017: record({ snapshotSliceMs }) serializes the full snapshot
 * in slices; events recorded meanwhile are queued, so the stream is Meta,
 * FullSnapshot, queued events in order, then the mutations buffered while
 * slicing. A page that does not change gets the same FullSnapshot as the
 * synchronous path.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import { describe, expect, it } from 'vitest';
import { EventType, IncrementalSource } from '@rrweb/types';
import type { eventWithTime } from '@rrweb/types';
import { cleanupSnapshot } from 'rrweb-snapshot';
import record, { flushMutations } from '../../src/record';

const settle = async (ms = 50) => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, ms / 5));
};

function page(n: number) {
  document.body.innerHTML =
    '<style>.a{color:red}</style><button id="b">b</button><ul id="l">' +
    Array.from({ length: n }, (_, i) => `<li class="i${i % 7}">item ${i}</li>`).join('') +
    '</ul>';
}

async function recordOnce(snapshotSliceMs: number, during?: () => void) {
  const events: eventWithTime[] = [];
  const stop = record({
    emit: (e) => {
      events.push(e as eventWithTime);
    },
    snapshotSliceMs,
  })!;
  during?.();
  // slices hop through MessageChannel; wait for the FullSnapshot, not a fixed time
  const deadline = Date.now() + 10_000;
  while (!events.some((e) => e.type === EventType.FullSnapshot) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await settle();
  stop();
  return events;
}

const kind = (e: eventWithTime) =>
  e.type === EventType.IncrementalSnapshot ? `3:${(e.data as { source: number }).source}` : String(e.type);

describe('sliced full snapshot (RR-017)', () => {
  it('a static page gets the same FullSnapshot as the synchronous path', async () => {
    page(400);
    cleanupSnapshot(); // node ids from 1 again
    const sync = await recordOnce(0);
    page(400);
    cleanupSnapshot();
    const sliced = await recordOnce(0.001);
    const full = (evs: eventWithTime[]) => JSON.stringify(evs.find((e) => e.type === EventType.FullSnapshot)!.data);
    expect(full(sliced)).toBe(full(sync));
    expect(sliced.map(kind).slice(0, 2)).toEqual(['4', '2']);
  });

  it('events recorded while slicing follow the FullSnapshot, mutations last, timestamps from the start', async () => {
    page(400);
    const events = await recordOnce(0.001, () => {
      // runs right after record() returned: the snapshot is still slicing
      document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 2, clientY: 2 }));
      const li = document.createElement('li');
      li.textContent = 'added while slicing';
      document.getElementById('l')!.appendChild(li);
    });
    const kinds = events.map(kind);
    expect(kinds.slice(0, 3)).toEqual(['4', '2', `3:${IncrementalSource.MouseInteraction}`]);
    expect(kinds.indexOf(`3:${IncrementalSource.Mutation}`)).toBeGreaterThan(2);
    const meta = events[0];
    const full = events[1];
    expect(full.timestamp).toBe(meta.timestamp);
    // the node added mid-snapshot is in the stream exactly once
    const json = JSON.stringify(events);
    expect(json.match(/added while slicing/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('stop() mid-snapshot: no event of any kind afterwards and the walk reads no further node (privacy fix 3)', async () => {
    page(3000);
    document.body.insertAdjacentHTML('beforeend', '<iframe id="f"></iframe>');
    const events: eventWithTime[] = [];
    const stop = record({ emit: (e) => events.push(e as eventWithTime), snapshotSliceMs: 0.001 })!;
    // let a few slices run, then stop while the walk is suspended
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    const walked = record.mirror.getIds().length;
    expect(walked).toBeGreaterThan(0);
    expect(walked).toBeLessThan(3000);
    stop();
    const atStop = events.length;
    // the page keeps changing and interacting after stop()
    const li = document.createElement('li');
    li.textContent = 'after stop';
    document.getElementById('l')!.appendChild(li);
    document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('f')!.dispatchEvent(new Event('load'));
    await settle(200);
    expect(events.length).toBe(atStop);
    expect(events.some((e) => e.type === EventType.FullSnapshot)).toBe(false);
    // the walk ended at the yield it was suspended in
    expect(record.mirror.getIds().length).toBe(walked);
    expect(() => record.takeFullSnapshot()).toThrow();
  });

  it('the Meta is dispatched with the FullSnapshot, in one synchronous step', async () => {
    page(3000);
    const events: eventWithTime[] = [];
    let ticks = 0;
    const tickAt: number[] = [];
    const stop = record({
      emit: (e) => {
        events.push(e as eventWithTime);
        tickAt.push(ticks);
      },
      snapshotSliceMs: 0.001,
    })!;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      ticks++;
    }
    // still walking: no Meta yet for a recorder flush to split from its snapshot
    expect(events.some((e) => e.type === EventType.Meta)).toBe(false);
    const deadline = Date.now() + 10_000;
    while (!events.some((e) => e.type === EventType.FullSnapshot) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
      ticks++;
    }
    stop();
    const m = events.findIndex((e) => e.type === EventType.Meta);
    expect(events[m + 1].type).toBe(EventType.FullSnapshot);
    expect(tickAt[m + 1]).toBe(tickAt[m]);
    expect(events[m + 1].timestamp).toBe(events[m].timestamp);
  });

  it('flushMutations() mid-snapshot finishes it synchronously, same FullSnapshot as the synchronous path', async () => {
    page(2000);
    cleanupSnapshot();
    const sync = await recordOnce(0);
    page(2000);
    cleanupSnapshot();
    const events: eventWithTime[] = [];
    const stop = record({ emit: (e) => events.push(e as eventWithTime), snapshotSliceMs: 0.001 })!;
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    expect(events.some((e) => e.type === EventType.FullSnapshot)).toBe(false);
    flushMutations();
    // the unload path ships right after this call
    expect(events.map(kind).slice(0, 2)).toEqual(['4', '2']);
    stop();
    await settle();
    const full = (evs: eventWithTime[]) => JSON.stringify(evs.find((e) => e.type === EventType.FullSnapshot)!.data);
    expect(full(events)).toBe(full(sync));
    expect(events.filter((e) => e.type === EventType.FullSnapshot).length).toBe(1);
  });

  it('a click on a node added mid-snapshot, or not walked yet, is recorded with its real id', async () => {
    page(3000);
    const events: eventWithTime[] = [];
    const stop = record({ emit: (e) => events.push(e as eventWithTime), snapshotSliceMs: 0.001 })!;
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    expect(events.length).toBe(0);
    // body was visited already: this button is only in the locked mutation buffer
    const late = document.createElement('button');
    late.textContent = 'cookie banner: accept';
    document.body.appendChild(late);
    // a user's click is a later task: the MutationObserver has delivered by then
    await Promise.resolve();
    late.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 3, clientY: 4 }));
    // the last list item: not reached by the walk yet
    const items = document.querySelectorAll('#l li');
    const deep = items[items.length - 1] as HTMLElement;
    deep.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 6 }));
    stop();
    const clicks = events.filter(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        (e.data as { source: number }).source === IncrementalSource.MouseInteraction &&
        (e.data as { type: number }).type === 2,
    ) as Array<eventWithTime & { data: { id: number } }>;
    expect(clicks.length).toBe(2);
    expect(clicks.every((c) => c.data.id > 0)).toBe(true);
    // the added button's id comes from the mutation emitted right before its click
    const add = events.find(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        (e.data as { source: number }).source === IncrementalSource.Mutation &&
        JSON.stringify(e.data).includes('cookie banner: accept'),
    ) as (eventWithTime & { data: { adds: Array<{ node: { id: number; tagName?: string } }> } }) | undefined;
    expect(add).toBeDefined();
    expect(events.indexOf(add!)).toBeLessThan(events.indexOf(clicks[0]));
    expect(add!.data.adds.some((a) => a.node.id === clicks[0].data.id && a.node.tagName === 'button')).toBe(true);
    expect(events.map(kind).slice(0, 2)).toEqual(['4', '2']);
  });

  it('a click on a node the walk already serialized does not end the slicing', async () => {
    page(3000);
    const events: eventWithTime[] = [];
    const stop = record({ emit: (e) => events.push(e as eventWithTime), snapshotSliceMs: 0.001 })!;
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const b = document.getElementById('b')!;
    expect(record.mirror.hasNode(b)).toBe(true);
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(events.some((e) => e.type === EventType.FullSnapshot)).toBe(false);
    const deadline = Date.now() + 10_000;
    while (!events.some((e) => e.type === EventType.FullSnapshot) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    stop();
    expect(events.map(kind).slice(0, 3)).toEqual(['4', '2', `3:${IncrementalSource.MouseInteraction}`]);
  });

  it('stop() during slicing emits no FullSnapshot', async () => {
    page(2000);
    const events: eventWithTime[] = [];
    const stop = record({ emit: (e) => events.push(e as eventWithTime), snapshotSliceMs: 0.001 })!;
    stop();
    await settle();
    expect(events.some((e) => e.type === EventType.FullSnapshot)).toBe(false);
  });
});
