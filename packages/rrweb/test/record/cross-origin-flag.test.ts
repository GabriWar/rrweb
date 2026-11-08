/**
 * Panopticon RR-009: __RRWEB_EXCLUDE_CROSS_ORIGIN_IFRAME__ drops the
 * cross-origin postMessage bridge; same-origin iframe recording is unchanged.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventType, IncrementalSource } from '@rrweb/types';
import type { eventWithTime } from '@rrweb/types';
import record from '../../src/record';

declare global {
  // eslint-disable-next-line no-var
  var __RRWEB_EXCLUDE_CROSS_ORIGIN_IFRAME__: boolean | undefined;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function crossOriginMessage(source: Window) {
  // what a recorded cross-origin child posts to its parent
  const event = {
    type: EventType.IncrementalSnapshot,
    data: { source: IncrementalSource.Scroll, id: 1, x: 0, y: 10 },
    timestamp: Date.now(),
  };
  return new MessageEvent('message', {
    data: {
      type: 'rrweb',
      event,
      origin: 'https://child.example',
      isCheckout: false,
    },
    origin: 'https://child.example',
    source,
  });
}

async function recordWithIframe(recordCrossOriginIframes: boolean) {
  document.body.innerHTML = '<p id="p">parent</p><iframe id="f"></iframe>';
  const iframe = document.getElementById('f') as HTMLIFrameElement;
  const events: eventWithTime[] = [];
  const stop = record({
    emit: (e) => events.push(e as eventWithTime),
    recordCrossOriginIframes,
  });
  await tick(50);
  // same-origin mutation inside the iframe
  const doc = iframe.contentDocument!;
  const li = doc.createElement('b');
  li.textContent = 'inside';
  doc.body.appendChild(li);
  await tick();
  window.dispatchEvent(crossOriginMessage(iframe.contentWindow!));
  await tick();
  stop?.();
  return events;
}

const isScroll10 = (e: eventWithTime) =>
  e.type === EventType.IncrementalSnapshot &&
  e.data.source === IncrementalSource.Scroll &&
  (e.data as { y: number }).y === 10;

const insideAdds = (events: eventWithTime[]) =>
  events.filter(
    (e) =>
      e.type === EventType.IncrementalSnapshot &&
      e.data.source === IncrementalSource.Mutation &&
      JSON.stringify(e.data).includes('inside'),
  ).length;

describe('__RRWEB_EXCLUDE_CROSS_ORIGIN_IFRAME__', () => {
  afterEach(() => {
    globalThis.__RRWEB_EXCLUDE_CROSS_ORIGIN_IFRAME__ = undefined;
  });

  it('without the flag, cross-origin child events are accepted when enabled', async () => {
    const events = await recordWithIframe(true);
    expect(events.some(isScroll10)).toBe(true);
    expect(insideAdds(events)).toBe(1);
  });

  it('with the flag, cross-origin postMessage events are ignored even if requested', async () => {
    globalThis.__RRWEB_EXCLUDE_CROSS_ORIGIN_IFRAME__ = true;
    const events = await recordWithIframe(true);
    expect(events.some(isScroll10)).toBe(false);
  });

  it('with the flag, same-origin iframe recording is unchanged', async () => {
    const plain = await recordWithIframe(false);
    globalThis.__RRWEB_EXCLUDE_CROSS_ORIGIN_IFRAME__ = true;
    const flagged = await recordWithIframe(false);
    const shape = (events: eventWithTime[]) =>
      events.map((e) =>
        e.type === EventType.IncrementalSnapshot
          ? `${e.type}:${e.data.source}:${
              'isAttachIframe' in e.data ? 'attach' : ''
            }`
          : String(e.type),
      );
    expect(shape(flagged)).toEqual(shape(plain));
    expect(insideAdds(flagged)).toBe(1);
    expect(
      flagged.some(
        (e) =>
          e.type === EventType.IncrementalSnapshot &&
          e.data.source === IncrementalSource.Mutation &&
          (e.data as { isAttachIframe?: boolean }).isAttachIframe,
      ),
    ).toBe(true);
  });
});
