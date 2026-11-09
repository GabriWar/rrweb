/**
 * Panopticon RR-030: record({ assetHook }) applies the hook to the full
 * snapshot and to nodes added by mutations, and uninstalls it at stop().
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import { describe, expect, it } from 'vitest';
import { EventType, IncrementalSource } from '@rrweb/types';
import type { eventWithTime } from '@rrweb/types';
import { cleanupSnapshot, snapshot } from 'rrweb-snapshot';
import record from '../../src/record';

const css = (p: string) =>
  Array.from({ length: 80 }, (_, i) => `.${p}${i}{padding:${i}px}`).join('');
const frame = () => new Promise<void>((r) => setTimeout(r, 30));

describe('record({ assetHook }) (RR-030)', () => {
  it('full snapshot and mutation adds go through the hook; stop() removes it', async () => {
    document.head.innerHTML = `<style>${css('a')}</style>`;
    document.body.innerHTML = '<div id="root"></div>';
    const calls: Array<[string, number]> = [];
    const events: eventWithTime[] = [];
    cleanupSnapshot();
    const stop = record({
      emit: (e) => events.push(e as eventWithTime),
      assetHook: (kind, v) =>
        v.length >= 1024
          ? (calls.push([kind, v.length]), `__m__/${calls.length}`)
          : null,
    })!;
    const style = document.createElement('style');
    style.textContent = css('b');
    document.getElementById('root')!.appendChild(style);
    await frame();
    stop();
    const full = events.find((e) => e.type === EventType.FullSnapshot)!;
    expect(JSON.stringify(full)).toContain('"_cssText":"__m__/1"');
    const mut = events.find(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.Mutation,
    )!;
    expect(JSON.stringify(mut)).toContain('"_cssText":"__m__/2"');
    expect(calls.map((c) => c[0])).toEqual(['css', 'css']);
    // uninstalled: a later serialization keeps the value
    const after = JSON.stringify(snapshot(document));
    expect(after).toContain('.a0');
    expect(after).not.toContain('__m__');
  });
});
