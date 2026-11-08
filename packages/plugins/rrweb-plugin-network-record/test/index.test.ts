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
    const entry = { ...json, toJSON: () => json } as unknown as PerformanceResourceTiming;
    const events: NetworkData[] = [];
    const win = createMockWindow({ initialEntries: [entry] });
    const plugin = getRecordNetworkPlugin({ recordInitialRequests: true, initiatorTypes: ['img'] });
    const cleanup = plugin.observer((data: NetworkData) => events.push(data), win, plugin.options);
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
    await flushMicrotasks();
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
});
