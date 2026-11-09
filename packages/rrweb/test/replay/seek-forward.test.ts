/**
 * Panopticon RR-053: a forward seek after a seek that ended on a MouseMove
 * must not re-apply events. A seek applies synchronously every event whose
 * raw timestamp is before the target; the next forward seek used to skip
 * only up to the MouseMove's first-position time (timestamp + a negative
 * timeOffset), so events in that window (here a StyleSheetRule insert,
 * which is not idempotent) were applied a second time.
 */
import { describe, expect, it } from 'vitest';
import mitt from 'mitt';
import { EventType, IncrementalSource, type eventWithTime } from '@rrweb/types';
import { createPlayerService } from '../../src/replay/machine';
import { Timer } from '../../src/replay/timer';

const ev = (timestamp: number, type: EventType, data: unknown) =>
  ({ timestamp, type, data } as eventWithTime);

function setup(events: eventWithTime[]) {
  const applied: number[] = [];
  const emitter = mitt();
  // eslint-disable-next-line prefer-const
  let service: ReturnType<typeof createPlayerService>;
  const getCastFn =
    (event: eventWithTime, isSync = false) =>
    () => {
      applied.push(event.timestamp);
      service.send({ type: 'CAST_EVENT', payload: { event, isSync } });
    };
  service = createPlayerService(
    {
      events,
      timer: new Timer([], { speed: 1 }),
      timeOffset: 0,
      baselineTime: 0,
      lastPlayedEvent: null,
    },
    {
      getCastFn,
      applyEventsSynchronously: (evs) =>
        evs.forEach((e) => getCastFn(e, true)()),
      emitter,
    },
  );
  service.start();
  const seek = (timeOffset: number) => {
    service.send({ type: 'PLAY', payload: { timeOffset } });
    service.send({ type: 'PAUSE' });
  };
  return { applied, seek };
}

describe('forward seek after a MouseMove (Panopticon RR-053)', () => {
  const events = [
    ev(0, EventType.Meta, { href: 'x', width: 10, height: 10 }),
    ev(0, EventType.FullSnapshot, { node: {}, initialOffset: {} }),
    ev(800, EventType.IncrementalSnapshot, {
      source: IncrementalSource.StyleSheetRule,
      id: 1,
      adds: [{ rule: '.a{}' }],
    }),
    ev(1000, EventType.IncrementalSnapshot, {
      source: IncrementalSource.MouseMove,
      positions: [
        { x: 1, y: 1, id: 1, timeOffset: -500 },
        { x: 2, y: 2, id: 1, timeOffset: 0 },
      ],
    }),
    ev(1500, EventType.IncrementalSnapshot, {
      source: IncrementalSource.Input,
      id: 2,
      text: 'a',
      isChecked: false,
    }),
  ];

  it('applies each event once across two forward seeks', () => {
    const { applied, seek } = setup(events);
    seek(1200);
    expect(applied).toEqual([0, 0, 800, 1000]);
    seek(2000);
    // only the event between the two seek targets
    expect(applied).toEqual([0, 0, 800, 1000, 1500]);
  });

  it('a backward seek still rebuilds from the snapshot', () => {
    const { applied, seek } = setup(events);
    seek(2000);
    applied.length = 0;
    seek(900);
    expect(applied).toEqual([0, 0, 800]);
  });
});
