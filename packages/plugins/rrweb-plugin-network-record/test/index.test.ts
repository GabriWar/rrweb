import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecordNetworkPlugin } from '../src';
import type { NetworkData } from '../src';

class MockPerformanceObserver {
  observe() {
    //
  }

  disconnect() {
    //
  }
}

type MockWindow = {
  performance: {
    now: () => number;
    getEntries: () => PerformanceEntry[];
    getEntriesByName: (url: string) => PerformanceResourceTiming[];
  };
  PerformanceObserver: typeof PerformanceObserver;
  XMLHttpRequest: typeof XMLHttpRequest;
  fetch: typeof fetch;
};

function createPerformanceEntry(
  url: string,
  initiatorType: 'fetch' | 'xmlhttprequest',
): PerformanceResourceTiming {
  return {
    name: url,
    entryType: 'resource',
    initiatorType,
    startTime: 0,
    responseEnd: 1,
    duration: 1,
    toJSON: () => ({
      name: url,
      entryType: 'resource',
      initiatorType,
    }),
  } as PerformanceResourceTiming;
}

function createNavigationEntry(url: string): PerformanceNavigationTiming {
  return {
    name: url,
    entryType: 'navigation',
    initiatorType: 'navigation',
    startTime: 0,
    responseEnd: 1,
    duration: 1,
    toJSON: () => ({
      name: url,
      entryType: 'navigation',
      initiatorType: 'navigation',
    }),
  } as PerformanceNavigationTiming;
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** Bodies are read beside the page: let those reads (real timers) finish. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await flushMicrotasks();
  }
}

function createMockWindow({
  fetchImpl = async () => new Response('ok'),
  entries = [],
  initialEntries = [],
}: {
  fetchImpl?: typeof fetch;
  entries?: PerformanceResourceTiming[];
  initialEntries?: PerformanceEntry[];
} = {}): MockWindow {
  let now = 0;
  class MockXMLHttpRequest {
    static instances: MockXMLHttpRequest[] = [];

    listeners = new Map<string, Array<() => void>>();
    readyState = 0;
    DONE = 4;
    status = 200;
    response: unknown = '';
    sentBody: Document | XMLHttpRequestBodyInit | null | undefined;

    constructor() {
      MockXMLHttpRequest.instances.push(this);
    }

    open() {
      //
    }

    send(body?: Document | XMLHttpRequestBodyInit | null) {
      this.sentBody = body;
    }

    setRequestHeader() {
      //
    }

    getAllResponseHeaders() {
      return 'content-type: application/json';
    }

    addEventListener(event: string, listener: () => void) {
      const listeners = this.listeners.get(event) || [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    complete() {
      this.readyState = this.DONE;
      for (const listener of this.listeners.get('readystatechange') || []) {
        listener();
      }
    }
  }

  return {
    performance: {
      now: () => now++,
      getEntries: () => initialEntries,
      getEntriesByName: (url: string) =>
        entries.filter((entry) => entry.name === url),
    },
    PerformanceObserver:
      MockPerformanceObserver as unknown as typeof PerformanceObserver,
    XMLHttpRequest: MockXMLHttpRequest as unknown as typeof XMLHttpRequest,
    fetch: fetchImpl,
  };
}

describe('rrweb-plugin-network-record', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the XHR method passed to open()', async () => {
    const url = 'https://example.com/api';
    const events: NetworkData[] = [];
    const win = createMockWindow({
      entries: [createPerformanceEntry(url, 'xmlhttprequest')],
    });
    const plugin = getRecordNetworkPlugin({
      recordBody: true,
      initiatorTypes: ['xmlhttprequest'],
    });
    const cleanup = plugin.observer(
      (data: NetworkData) => events.push(data),
      win,
      plugin.options,
    );

    const xhr = new win.XMLHttpRequest();
    xhr.open('POST', url);
    xhr.send('{"ok":true}');
    (xhr as unknown as { complete: () => void }).complete();
    await flushMicrotasks();
    cleanup();

    expect(events[0].requests[0].method).toBe('POST');
  });

  it('records the XHR method when performance timing data is unavailable', async () => {
    vi.useFakeTimers();
    const url = 'https://example.com/api';
    const events: NetworkData[] = [];
    const win = createMockWindow();
    const plugin = getRecordNetworkPlugin({
      recordBody: true,
      initiatorTypes: ['xmlhttprequest'],
    });
    const cleanup = plugin.observer(
      (data: NetworkData) => events.push(data),
      win,
      plugin.options,
    );

    const xhr = new win.XMLHttpRequest();
    xhr.open('POST', url);
    xhr.send('{"ok":true}');
    (xhr as unknown as { complete: () => void }).complete();
    await vi.runAllTimersAsync();
    await flushMicrotasks();
    cleanup();

    expect(events[0].requests[0].method).toBe('POST');
  });

  it('records every timing field at full precision, the URL only as the request name (Panopticon item 8 review)', () => {
    const json = {
      name: 'https://user:pw@example.com/secret?q=1',
      entryType: 'resource',
      initiatorType: 'img',
      startTime: 12.345,
      responseEnd: 400.125,
      duration: 387.78,
      domainLookupStart: 13.1,
      connectEnd: 20.2,
      secureConnectionStart: 15.5,
      requestStart: 20.25,
      responseStart: 380.06,
      transferSize: 1234,
      encodedBodySize: 900,
      decodedBodySize: 2000,
      nextHopProtocol: 'h2',
      serverTiming: [{ name: 'db', duration: 12.5, description: 'q' }],
    };
    const entry = {
      ...json,
      toJSON: () => json,
    } as unknown as PerformanceResourceTiming;
    const events: NetworkData[] = [];
    const win = createMockWindow({ initialEntries: [entry] });
    const plugin = getRecordNetworkPlugin({
      recordInitialRequests: true,
      initiatorTypes: ['img'],
    });
    const cleanup = plugin.observer(
      (data: NetworkData) => events.push(data),
      win,
      plugin.options,
    );
    cleanup();
    const r = events[0].requests[0];
    expect(r.startTime).toBe(12.345);
    expect(r.endTime).toBe(400.125);
    const { name: _url, ...rest } = json;
    expect(r.timing).toEqual(rest);
    expect(JSON.stringify(r.timing)).not.toContain('secret');
  });

  it('filters initial navigation entries by initiatorTypes', () => {
    const events: NetworkData[] = [];
    const win = createMockWindow({
      initialEntries: [createNavigationEntry('https://example.com/page')],
    });
    const plugin = getRecordNetworkPlugin({
      recordInitialRequests: true,
      initiatorTypes: ['fetch'],
    });
    const cleanup = plugin.observer(
      (data: NetworkData) => events.push(data),
      win,
      plugin.options,
    );
    cleanup();

    expect(events[0]).toEqual({ requests: [], isInitial: true });
  });

  it('records fetch request bodies as serializable text', async () => {
    const url = 'https://example.com/api';
    const events: NetworkData[] = [];
    const win = createMockWindow({
      entries: [createPerformanceEntry(url, 'fetch')],
    });
    const plugin = getRecordNetworkPlugin({
      recordBody: true,
      initiatorTypes: ['fetch'],
    });
    const cleanup = plugin.observer(
      (data: NetworkData) => events.push(data),
      win,
      plugin.options,
    );

    await win.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    await settle();
    cleanup();

    expect(events[0].requests[0].requestBody).toBe('hello');
  });

  it('forwards fetch(url, init) to the original fetch without replacing it with an internal Request', async () => {
    const url = 'https://example.com/api';
    let downstreamInput: RequestInfo | URL | undefined;
    let downstreamInit: RequestInit | undefined;
    const init = {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    };
    const win = createMockWindow({
      entries: [createPerformanceEntry(url, 'fetch')],
      fetchImpl: async (input, requestInit) => {
        downstreamInput = input;
        downstreamInit = requestInit;
        return new Response('ok');
      },
    });
    const plugin = getRecordNetworkPlugin({
      recordBody: true,
      initiatorTypes: ['fetch'],
    });
    const cleanup = plugin.observer(() => undefined, win, plugin.options);

    await win.fetch(url, init);
    cleanup();

    expect(downstreamInput).toBe(url);
    expect(downstreamInit).toBe(init);
  });

  describe('bodies byte for byte (Panopticon item 8)', () => {
    const binary = new Uint8Array([0, 255, 128, 10, 192, 1, 254]);
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

    function record(
      win: MockWindow,
      initiatorTypes: Array<'fetch' | 'xmlhttprequest'>,
    ) {
      const events: NetworkData[] = [];
      const plugin = getRecordNetworkPlugin({
        recordBody: true,
        initiatorTypes,
      });
      const cleanup = plugin.observer(
        (data: NetworkData) => events.push(data),
        win,
        plugin.options,
      );
      return { events, cleanup };
    }

    it('a fetch response body slower than any timeout is recorded in full, and the page gets its response first', async () => {
      vi.useFakeTimers();
      const url = 'https://example.com/stream';
      let push!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => void (push = c),
      });
      const win = createMockWindow({
        entries: [createPerformanceEntry(url, 'fetch')],
        fetchImpl: async () =>
          new Response(stream, { headers: { 'content-type': 'text/plain' } }),
      });
      const { events, cleanup } = record(win, ['fetch']);
      const res = await win.fetch(url);
      expect(res.status).toBe(200);
      push.enqueue(new TextEncoder().encode('chunk 1 '));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events).toHaveLength(0);
      push.enqueue(new TextEncoder().encode('chunk 2'));
      push.close();
      expect(await res.text()).toBe('chunk 1 chunk 2');
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
      cleanup();
      expect(events[0].requests[0].responseBody).toBe('chunk 1 chunk 2');
    });

    it('a binary fetch response is recorded as base64 of its exact bytes, never decoded as text', async () => {
      const url = 'https://example.com/bin';
      const win = createMockWindow({
        entries: [createPerformanceEntry(url, 'fetch')],
        fetchImpl: async () =>
          new Response(binary.slice(), {
            headers: { 'content-type': 'application/octet-stream' },
          }),
      });
      const { events, cleanup } = record(win, ['fetch']);
      const res = await win.fetch(url, {
        method: 'POST',
        body: binary.slice(),
      });
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(binary);
      await settle();
      cleanup();
      const r = events[0].requests[0];
      expect(r.responseBody).toEqual({ base64: b64(binary) });
      expect(r.requestBody).toEqual({ base64: b64(binary) });
    });

    it('valid UTF-8 stays text, a leading BOM included', async () => {
      const url = 'https://example.com/bom';
      const text = '\ufeff{"a":"\u00e9\u{1f600}"}';
      const win = createMockWindow({
        entries: [createPerformanceEntry(url, 'fetch')],
        fetchImpl: async () => new Response(new TextEncoder().encode(text)),
      });
      const { events, cleanup } = record(win, ['fetch']);
      await win.fetch(url);
      await settle();
      cleanup();
      expect(events[0].requests[0].responseBody).toBe(text);
    });

    it('XHR ArrayBuffer and Blob bodies are recorded byte for byte, not as a placeholder', async () => {
      const url = 'https://example.com/xhr';
      const win = createMockWindow({
        entries: [createPerformanceEntry(url, 'xmlhttprequest')],
      });
      const { events, cleanup } = record(win, ['xmlhttprequest']);
      const xhr = new win.XMLHttpRequest() as unknown as {
        open: (m: string, u: string) => void;
        send: (b: unknown) => void;
        complete: () => void;
        response: unknown;
      };
      xhr.open('POST', url);
      xhr.send(new Blob([binary.slice()]));
      xhr.response = binary.slice().buffer;
      xhr.complete();
      for (let i = 0; i < 20; i++) await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 0));
      await settle();
      cleanup();
      const r = events[0].requests[0];
      expect(r.responseBody).toEqual({ base64: b64(binary) });
      expect(r.requestBody).toEqual({ base64: b64(binary) });
    });
  });

  describe('no body lost: documents, files, streams open at stop (Panopticon item 8)', () => {
    const xhrOf = (win: MockWindow) =>
      new win.XMLHttpRequest() as unknown as {
        open: (m: string, u: string) => void;
        send: (b: unknown) => void;
        complete: () => void;
        response: unknown;
      };

    it('an XHR Document body keeps its markup, HTML and XML', async () => {
      const url = 'https://example.com/doc';
      const win = createMockWindow({
        entries: [createPerformanceEntry(url, 'xmlhttprequest')],
      });
      const events: NetworkData[] = [];
      const plugin = getRecordNetworkPlugin({
        recordBody: true,
        initiatorTypes: ['xmlhttprequest'],
      });
      const cleanup = plugin.observer(
        (d: NetworkData) => events.push(d),
        win,
        plugin.options,
      );
      const html = new DOMParser().parseFromString(
        '<!DOCTYPE html><html><body><p class="a" data-x="1">hi <b>there</b></p><!--c--></body></html>',
        'text/html',
      );
      const xml = new DOMParser().parseFromString(
        '<root a="1"><item id="i">t</item></root>',
        'application/xml',
      );
      const xhr = xhrOf(win);
      xhr.open('POST', url);
      xhr.send(xml);
      xhr.response = html;
      xhr.complete();
      await settle();
      cleanup();
      const r = events[0].requests[0];
      expect(r.responseBody).toBe(
        '<!DOCTYPE html><html><head></head><body><p class="a" data-x="1">hi <b>there</b></p><!--c--></body></html>',
      );
      expect(r.requestBody).toBe('<root a="1"><item id="i">t</item></root>');
    });

    it('a FormData file is recorded with its name, type, size and bytes, entries in order', async () => {
      const url = 'https://example.com/upload';
      const win = createMockWindow({
        entries: [createPerformanceEntry(url, 'xmlhttprequest')],
      });
      const events: NetworkData[] = [];
      const plugin = getRecordNetworkPlugin({
        recordBody: true,
        initiatorTypes: ['xmlhttprequest'],
      });
      const cleanup = plugin.observer(
        (d: NetworkData) => events.push(d),
        win,
        plugin.options,
      );
      const bytes = new Uint8Array([0, 255, 1, 128]);
      const fd = new FormData();
      fd.append('title', 'report');
      fd.append(
        'file',
        new File([bytes], 'r.bin', { type: 'application/octet-stream' }),
      );
      fd.append('note', 'n');
      const xhr = xhrOf(win);
      xhr.open('POST', url);
      xhr.send(fd);
      xhr.complete();
      await settle();
      cleanup();
      expect(events[0].requests[0].requestBody).toEqual({
        formData: [
          ['title', 'report'],
          [
            'file',
            {
              name: 'r.bin',
              type: 'application/octet-stream',
              size: 4,
              base64: Buffer.from(bytes).toString('base64'),
            },
          ],
          ['note', 'n'],
        ],
      });
    });

    // a fetch whose body is still streaming when the first recording stops
    const streamingAtStop = async (
      first: Parameters<typeof getRecordNetworkPlugin>[0],
    ) => {
      const url = 'https://example.com/sse?token=secret';
      let push!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => void (push = c),
      });
      const win = createMockWindow({
        entries: [createPerformanceEntry(url, 'fetch')],
        fetchImpl: async () => new Response(stream),
      });
      const firstEvents: NetworkData[] = [];
      const plugin = getRecordNetworkPlugin(first);
      const stop1 = plugin.observer(
        (d: NetworkData) => firstEvents.push(d),
        win,
        plugin.options,
      );
      const res = await win.fetch(url);
      const pageRead = res.text();
      push.enqueue(new TextEncoder().encode('event 1\n'));
      await settle();
      stop1();
      // ends while no recording runs
      push.enqueue(new TextEncoder().encode('event 2\n'));
      push.close();
      expect(await pageRead).toBe('event 1\nevent 2\n');
      await settle();
      const next = (options: Parameters<typeof getRecordNetworkPlugin>[0]) => {
        const p2 = getRecordNetworkPlugin(options);
        const events: NetworkData[] = [];
        const stop2 = p2.observer(
          (d: NetworkData) => events.push(d),
          win,
          p2.options,
        );
        stop2();
        return events;
      };
      return { firstEvents, next };
    };
    const stripQuery = (r: { name: string }) => ({
      ...r,
      name: r.name.split('?')[0],
    });

    it('a body still streaming at stop is reported as read so far (partial), the whole body follows to the next recording with the same key', async () => {
      const { firstEvents, next } = await streamingAtStop({
        recordBody: true,
        initiatorTypes: ['fetch'],
        carryOverKey: 's1',
        transformRequestFn: stripQuery,
      });
      expect(firstEvents).toHaveLength(1);
      expect(firstEvents[0].requests[0]).toMatchObject({
        name: 'https://example.com/sse',
        status: 200,
        responseBody: 'event 1\n',
        responseBodyPartial: true,
      });
      // the next recording passes NO transform: the carried request was sanitized by the recording it belongs to
      const second = next({
        recordBody: true,
        initiatorTypes: ['fetch'],
        carryOverKey: 's1',
      });
      expect(second).toHaveLength(1);
      expect(second[0].requests[0].name).toBe('https://example.com/sse');
      expect(second[0].requests[0].responseBody).toBe('event 1\nevent 2\n');
      expect(second[0].requests[0].responseBodyPartial).toBeUndefined();
    });

    it('a request that completes after stop never moves into a recording with another key, or without one', async () => {
      const other = await streamingAtStop({
        recordBody: true,
        initiatorTypes: ['fetch'],
        carryOverKey: 's1',
      });
      expect(
        other.next({
          recordBody: true,
          initiatorTypes: ['fetch'],
          carryOverKey: 's2',
        }),
      ).toHaveLength(0);
      const none = await streamingAtStop({
        recordBody: true,
        initiatorTypes: ['fetch'],
      });
      expect(none.firstEvents[0].requests[0].responseBodyPartial).toBe(true);
      expect(
        none.next({ recordBody: true, initiatorTypes: ['fetch'] }),
      ).toHaveLength(0);
    });
  });
});
