/**
 * Panopticon item 8 loss audit: what the RR-016 / RR-017 CPU options lose
 * against the unoptimized recorder, and that the defaults (both off) record
 * exactly what upstream rrweb records. The Panopticon recorder runs with
 * coalesceMutations false and snapshotSliceMs 0 because of the first two
 * cases.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import { describe, expect, it } from 'vitest';
import { EventType, IncrementalSource } from '@rrweb/types';
import type { eventWithTime, mutationData } from '@rrweb/types';
import { cleanupSnapshot } from 'rrweb-snapshot';
import record from '../../src/record';

const frame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** Every attribute value and text value the stream carries, in order. */
function values(events: eventWithTime[]) {
  const out: string[] = [];
  for (const e of events) {
    if (
      e.type !== EventType.IncrementalSnapshot ||
      e.data.source !== IncrementalSource.Mutation
    )
      continue;
    const d = e.data as mutationData;
    for (const a of d.attributes) out.push(`attr ${JSON.stringify(a.attributes)}`);
    for (const t of d.texts) out.push(`text ${t.value}`);
    for (const a of d.adds) out.push(`add ${JSON.stringify(a.node).slice(0, 60)}`);
    for (const r of d.removes) out.push(`rm ${r.id}`);
  }
  return out;
}

async function recordWith(
  opts: { coalesceMutations?: boolean; snapshotSliceMs?: number },
  during: () => Promise<void> | void,
) {
  document.body.innerHTML =
    '<div id="a" class="s0">x</div><ul id="l">' +
    Array.from({ length: 300 }, (_, i) => `<li id="i${i}">item ${i}</li>`).join('') +
    '</ul>';
  cleanupSnapshot();
  const events: eventWithTime[] = [];
  const stop = record({ emit: (e) => events.push(e as eventWithTime), ...opts })!;
  await during();
  const deadline = Date.now() + 10_000;
  while (!events.some((e) => e.type === EventType.FullSnapshot) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await frame();
  await frame();
  stop();
  return events;
}

/** Two class changes and a text change in separate microtasks of one task. */
async function intermediateValues() {
  await frame();
  const a = document.getElementById('a')!;
  a.className = 's1';
  await Promise.resolve();
  await Promise.resolve();
  a.className = 's2';
  a.firstChild!.textContent = 'y';
  await Promise.resolve();
  await Promise.resolve();
  a.firstChild!.textContent = 'z';
  await frame();
}

describe('loss audit (Panopticon item 8)', () => {
  it('coalesceMutations drops values an element held between two MutationObserver callbacks of one frame', async () => {
    const plain = values(await recordWith({}, intermediateValues));
    const coalesced = values(await recordWith({ coalesceMutations: true }, intermediateValues));
    // the unoptimized recorder emits every callback: s1, then s2 + y, then z
    expect(plain).toEqual(['attr {"class":"s1"}', 'attr {"class":"s2"}', 'text y', 'text z']);
    // per frame, the attribute map keeps the last value only: s1 is gone
    expect(coalesced).not.toContain('attr {"class":"s1"}');
    expect(coalesced.length).toBeLessThan(plain.length);
  });

  it('a sliced snapshot records an element removed before the walk reached it, then its removal, as the synchronous one', async () => {
    const removeLate = async () => {
      // record() returned: a sliced walk has only serialized its first slice
      document.getElementById('i299')!.remove();
      await Promise.resolve();
    };
    const sync = await recordWith({}, removeLate);
    const sliced = await recordWith({ snapshotSliceMs: 0.001 }, removeLate);
    const full = (evs: eventWithTime[]) => JSON.stringify(evs.find((e) => e.type === EventType.FullSnapshot)!.data);
    // synchronous: i299 is in the FullSnapshot, then its removal follows
    expect(full(sync)).toContain('"i299"');
    expect(values(sync).some((v) => v.startsWith('rm '))).toBe(true);
    // sliced (frozen when it started): the same FullSnapshot, the same removal
    expect(full(sliced)).toBe(full(sync));
    expect(values(sliced)).toEqual(values(sync));
  });

  it('with both options at their defaults the stream is the unoptimized one, value for value', async () => {
    const a = values(await recordWith({}, intermediateValues));
    const b = values(await recordWith({ coalesceMutations: false, snapshotSliceMs: 0 }, intermediateValues));
    expect(b).toEqual(a);
  });

  it('a sliced snapshot keeps every value of the changes made while it walks, each with its own callback', async () => {
    const a = values(await recordWith({}, intermediateValues));
    const b = values(await recordWith({ snapshotSliceMs: 0.001 }, intermediateValues));
    expect(b).toEqual(a);
  });
});
