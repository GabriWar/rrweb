/**
 * Panopticon RR-052: the constructor sizes the replay iframe to the first
 * Meta on a timeout (the "poster"). A seek made right after construction
 * (the paged dashboard player builds a Replayer and seeks at once) has
 * already applied that Meta and a later ViewportResize; the poster timeout
 * must not undo them.
 */
import { describe, expect, it } from 'vitest';
import { EventType, IncrementalSource, type eventWithTime } from '@rrweb/types';
import { Replayer } from '../../src/replay';

const node = {
  type: 0,
  id: 1,
  childNodes: [
    {
      type: 2,
      tagName: 'html',
      id: 2,
      attributes: {},
      childNodes: [
        { type: 2, tagName: 'head', id: 3, attributes: {}, childNodes: [] },
        { type: 2, tagName: 'body', id: 4, attributes: {}, childNodes: [] },
      ],
    },
  ],
};
const events = [
  {
    timestamp: 1000,
    type: EventType.Meta,
    data: { href: 'http://x/', width: 1280, height: 800 },
  },
  {
    timestamp: 1000,
    type: EventType.FullSnapshot,
    data: { node, initialOffset: { top: 0, left: 0 } },
  },
  {
    timestamp: 2000,
    type: EventType.IncrementalSnapshot,
    data: {
      source: IncrementalSource.ViewportResize,
      width: 1024,
      height: 768,
    },
  },
  {
    timestamp: 3000,
    type: EventType.IncrementalSnapshot,
    data: {
      source: IncrementalSource.MouseMove,
      positions: [{ x: 1, y: 1, id: 4, timeOffset: 0 }],
    },
  },
] as unknown as eventWithTime[];

describe('poster resize after an immediate seek (Panopticon RR-052)', () => {
  it('keeps the size the seek applied', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const r = new Replayer(events, {
      root,
      showWarning: false,
      mouseTail: false,
    });
    // offsets count from the first event: 500 is before the resize, 1500 after
    r.pause(500);
    expect(r.iframe.getAttribute('width')).toBe('1280');
    r.pause(1500);
    expect(r.iframe.getAttribute('width')).toBe('1024');
    await new Promise((res) => setTimeout(res, 20));
    expect(r.iframe.getAttribute('width')).toBe('1024');
    r.destroy();
  });

  it('still sizes the poster when nothing was played', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const r = new Replayer(events, {
      root,
      showWarning: false,
      mouseTail: false,
    });
    await new Promise((res) => setTimeout(res, 20));
    expect(r.iframe.getAttribute('width')).toBe('1280');
    r.destroy();
  });
});
