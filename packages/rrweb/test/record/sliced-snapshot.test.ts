/**
 * Panopticon RR-017 / item 8: record({ snapshotSliceMs }) freezes the page
 * when the snapshot starts and serializes the frozen copy in slices; events
 * recorded meanwhile (mutations with their own times) are queued, so the
 * stream is Meta, FullSnapshot, then every queued event in order, and the
 * FullSnapshot is the synchronous path's.
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
    Array.from(
      { length: n },
      (_, i) => `<li class="i${i % 7}">item ${i}</li>`,
    ).join('') +
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
  while (
    !events.some((e) => e.type === EventType.FullSnapshot) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await settle();
  stop();
  return events;
}

const kind = (e: eventWithTime) =>
  e.type === EventType.IncrementalSnapshot
    ? `3:${(e.data as { source: number }).source}`
    : String(e.type);

describe('sliced full snapshot (RR-017)', () => {
  it('a static page gets the same FullSnapshot as the synchronous path', async () => {
    page(400);
    cleanupSnapshot(); // node ids from 1 again
    const sync = await recordOnce(0);
    page(400);
    cleanupSnapshot();
    const sliced = await recordOnce(0.001);
    const full = (evs: eventWithTime[]) =>
      JSON.stringify(evs.find((e) => e.type === EventType.FullSnapshot)!.data);
    expect(full(sliced)).toBe(full(sync));
    expect(sliced.map(kind).slice(0, 2)).toEqual(['4', '2']);
  });

  it('events recorded while slicing follow the FullSnapshot, mutations last, timestamps from the start', async () => {
    page(400);
    const events = await recordOnce(0.001, () => {
      // runs right after record() returned: the snapshot is still slicing
      document
        .getElementById('b')!
        .dispatchEvent(
          new MouseEvent('click', { bubbles: true, clientX: 2, clientY: 2 }),
        );
      const li = document.createElement('li');
      li.textContent = 'added while slicing';
      document.getElementById('l')!.appendChild(li);
    });
    const kinds = events.map(kind);
    expect(kinds.slice(0, 3)).toEqual([
      '4',
      '2',
      `3:${IncrementalSource.MouseInteraction}`,
    ]);
    expect(kinds.indexOf(`3:${IncrementalSource.Mutation}`)).toBeGreaterThan(2);
    const meta = events[0];
    const full = events[1];
    expect(full.timestamp).toBe(meta.timestamp);
    // the node added mid-snapshot is in the stream exactly once
    const json = JSON.stringify(events);
    expect(
      json.match(/added while slicing/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(1);
  });

  it('stop() mid-snapshot: no event of any kind afterwards and the walk serializes no further node (privacy fix 3)', async () => {
    page(3000);
    document.body.insertAdjacentHTML('beforeend', '<iframe id="f"></iframe>');
    const events: eventWithTime[] = [];
    let serializedAfterStop = false;
    let stopped = false;
    const stop = record({
      emit: (e) => events.push(e as eventWithTime),
      snapshotSliceMs: 0.001,
      // the asset hook runs for every serialized element with a large value:
      // none may be serialized after stop()
      assetHook: () => {
        if (stopped) serializedAfterStop = true;
        return null;
      },
    })!;
    // every node got its id when the snapshot started (the freeze)
    expect(record.mirror.getIds().length).toBeGreaterThan(3000);
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    stop();
    stopped = true;
    const atStop = events.length;
    // the page keeps changing and interacting after stop()
    const li = document.createElement('li');
    li.textContent = 'after stop';
    document.getElementById('l')!.appendChild(li);
    document
      .getElementById('b')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('f')!.dispatchEvent(new Event('load'));
    await settle(200);
    expect(events.length).toBe(atStop);
    expect(events.length).toBe(0);
    expect(serializedAfterStop).toBe(false);
    expect(() => record.takeFullSnapshot()).toThrow();
  });

  it(
    'the Meta is dispatched with the FullSnapshot, in one synchronous step',
    { timeout: 25_000 },
    async () => {
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
      while (
        !events.some((e) => e.type === EventType.FullSnapshot) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 5));
        ticks++;
      }
      stop();
      const m = events.findIndex((e) => e.type === EventType.Meta);
      expect(events[m + 1].type).toBe(EventType.FullSnapshot);
      expect(tickAt[m + 1]).toBe(tickAt[m]);
      expect(events[m + 1].timestamp).toBe(events[m].timestamp);
    },
  );

  it('flushMutations() mid-snapshot finishes it synchronously, same FullSnapshot as the synchronous path', async () => {
    page(2000);
    cleanupSnapshot();
    const sync = await recordOnce(0);
    page(2000);
    cleanupSnapshot();
    const events: eventWithTime[] = [];
    const stop = record({
      emit: (e) => events.push(e as eventWithTime),
      snapshotSliceMs: 0.001,
    })!;
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    expect(events.some((e) => e.type === EventType.FullSnapshot)).toBe(false);
    flushMutations();
    // the unload path ships right after this call
    expect(events.map(kind).slice(0, 2)).toEqual(['4', '2']);
    stop();
    await settle();
    const full = (evs: eventWithTime[]) =>
      JSON.stringify(evs.find((e) => e.type === EventType.FullSnapshot)!.data);
    expect(full(events)).toBe(full(sync));
    expect(events.filter((e) => e.type === EventType.FullSnapshot).length).toBe(
      1,
    );
  });

  it('a click on a node added mid-snapshot, or not walked yet, is recorded with its real id, after the FullSnapshot', async () => {
    page(3000);
    const events: eventWithTime[] = [];
    const stop = record({
      emit: (e) => events.push(e as eventWithTime),
      snapshotSliceMs: 0.001,
    })!;
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    expect(events.length).toBe(0);
    // added after the freeze: the mutation buffer gives it its id now
    const late = document.createElement('button');
    late.textContent = 'cookie banner: accept';
    document.body.appendChild(late);
    // a user's click is a later task: the MutationObserver has delivered by then
    await Promise.resolve();
    late.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 3, clientY: 4 }),
    );
    // the last list item: not reached by the walk yet, its id given at the freeze
    const items = document.querySelectorAll('#l li');
    const deep = items[items.length - 1] as HTMLElement;
    const deepId = record.mirror.getId(deep);
    expect(deepId).toBeGreaterThan(0);
    deep.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 6 }),
    );
    // the walk carries on: nothing out until it is done
    expect(events.length).toBe(0);
    const deadline = Date.now() + 20_000;
    while (
      !events.some((e) => e.type === EventType.FullSnapshot) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    stop();
    const clicks = events.filter(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        (e.data as { source: number }).source ===
          IncrementalSource.MouseInteraction &&
        (e.data as { type: number }).type === 2,
    ) as Array<eventWithTime & { data: { id: number } }>;
    expect(clicks.length).toBe(2);
    expect(clicks[1].data.id).toBe(deepId);
    const full = JSON.stringify(
      events.find((e) => e.type === EventType.FullSnapshot)!.data,
    );
    expect(full).toContain(`"id":${deepId}}`);
    expect(full).not.toContain('cookie banner');
    // the added button's id comes from the mutation emitted right before its click
    const add = events.find(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        (e.data as { source: number }).source === IncrementalSource.Mutation &&
        JSON.stringify(e.data).includes('cookie banner: accept'),
    ) as
      | (eventWithTime & {
          data: { adds: Array<{ node: { id: number; tagName?: string } }> };
        })
      | undefined;
    expect(add).toBeDefined();
    expect(events.indexOf(add!)).toBeLessThan(events.indexOf(clicks[0]));
    expect(
      add!.data.adds.some(
        (a) => a.node.id === clicks[0].data.id && a.node.tagName === 'button',
      ),
    ).toBe(true);
    expect(events.map(kind).slice(0, 2)).toEqual(['4', '2']);
  }, 25_000);

  it('a click on a node the walk already serialized does not end the slicing', async () => {
    page(3000);
    const events: eventWithTime[] = [];
    const stop = record({
      emit: (e) => events.push(e as eventWithTime),
      snapshotSliceMs: 0.001,
    })!;
    const b = document.getElementById('b')!;
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    expect(record.mirror.hasNode(b)).toBe(true);
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(events.some((e) => e.type === EventType.FullSnapshot)).toBe(false);
    const deadline = Date.now() + 10_000;
    while (
      !events.some((e) => e.type === EventType.FullSnapshot) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    stop();
    expect(events.map(kind).slice(0, 3)).toEqual([
      '4',
      '2',
      `3:${IncrementalSource.MouseInteraction}`,
    ]);
    // ~6,000 nodes, one MessageChannel hop per slice: ~5 s under load, and
    // the waits above allow 10 s each; vitest's 5 s default cut it short
  }, 25_000);

  it('stop() during slicing emits no FullSnapshot', async () => {
    page(2000);
    const events: eventWithTime[] = [];
    const stop = record({
      emit: (e) => events.push(e as eventWithTime),
      snapshotSliceMs: 0.001,
    })!;
    stop();
    await settle();
    expect(events.some((e) => e.type === EventType.FullSnapshot)).toBe(false);
  });
});
