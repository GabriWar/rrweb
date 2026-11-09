/**
 * Panopticon item 8: while stop() runs the observers' cleanup, a plugin
 * still reports what it holds (the network plugin's response bodies still
 * streaming); nothing else is emitted after stop, and nothing of the
 * plugin after its cleanup returned.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import { describe, expect, it } from 'vitest';
import { EventType } from '@rrweb/types';
import type { eventWithTime, RecordPlugin } from '@rrweb/types';
import record from '../../src/record';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('plugins report during stop (item 8)', () => {
  it("a plugin's cleanup reports; a later report and other events are not emitted", async () => {
    document.body.innerHTML = '<p>x</p>';
    let later: (() => void) | null = null;
    const plugin: RecordPlugin = {
      name: 'test/flush@1',
      observer: (cb: (p: unknown) => void) => {
        later = () => cb({ after: true });
        return () => cb({ atStop: true });
      },
      options: {},
    };
    const events: eventWithTime[] = [];
    const stop = record({ emit: (e) => events.push(e as eventWithTime), plugins: [plugin] })!;
    await tick(50);
    stop();
    later!();
    const payloads = events
      .filter((e) => e.type === EventType.Plugin)
      .map((e) => (e.data as { payload: unknown }).payload);
    expect(payloads).toEqual([{ atStop: true }]);
  });
});
