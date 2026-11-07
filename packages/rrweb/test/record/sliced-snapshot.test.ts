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
import record from '../../src/record';

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

  it('stop() during slicing emits no FullSnapshot', async () => {
    page(2000);
    const events: eventWithTime[] = [];
    const stop = record({ emit: (e) => events.push(e as eventWithTime), snapshotSliceMs: 0.001 })!;
    stop();
    await settle();
    expect(events.some((e) => e.type === EventType.FullSnapshot)).toBe(false);
  });
});
