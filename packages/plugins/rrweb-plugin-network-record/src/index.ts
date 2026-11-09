import type {
  listenerHandler,
  RecordPlugin,
  IWindow,
  NetworkBody,
  NetworkData,
  NetworkFormDataFile,
  NetworkHeaders,
  NetworkInitiatorType,
  NetworkRecordOptions,
  NetworkRequest,
} from '@rrweb/types';
import { patch } from '@rrweb/utils';

/** Panopticon replay gate: compile `pano:rec:*` measures in (false in production). */
declare const __PANO_BENCH__: boolean | undefined;

function benchNow(): number {
  return typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__
    ? performance.now()
    : 0;
}

function benchEnd(start: number) {
  if (typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__) {
    performance.measure('pano:rec:network', {
      start,
      end: performance.now(),
    });
  }
}

export type {
  NetworkBody,
  NetworkData,
  NetworkHeaders,
  NetworkInitiatorType,
  NetworkRecordOptions,
  NetworkRequest,
} from '@rrweb/types';

const defaultNetworkOptions: NetworkRecordOptions = {
  initiatorTypes: [
    'audio',
    'beacon',
    'body',
    'css',
    'early-hint',
    'embed',
    'fetch',
    'frame',
    'iframe',
    'icon',
    'image',
    'img',
    'input',
    'link',
    'navigation',
    'object',
    'ping',
    'script',
    'track',
    'video',
    'xmlhttprequest',
  ],
  transformRequestFn: (request) => request,
  recordHeaders: false,
  recordBody: false,
  recordInitialRequests: false,
};

type networkCallback = (data: NetworkData) => void;

const isNavigationTiming = (
  entry: PerformanceEntry,
): entry is PerformanceNavigationTiming => entry.entryType === 'navigation';
const isResourceTiming = (
  entry: PerformanceEntry,
): entry is PerformanceResourceTiming => entry.entryType === 'resource';

type ObservedPerformanceEntry = (
  | PerformanceNavigationTiming
  | PerformanceResourceTiming
) & {
  responseStatus?: number;
};

/**
 * Panopticon item 8 review: every field of the entry (DNS, connect, TLS,
 * TTFB, transfer and body sizes, protocol, server timing, ...) at full
 * precision, except its URL, which is the request's own (sanitized)
 * `name`. Server-Timing names and descriptions are the host's to scrub
 * (transformRequestFn).
 */
function timingOf(entry: PerformanceEntry): Record<string, unknown> | undefined {
  try {
    const t = { ...(entry.toJSON() as Record<string, unknown>) };
    delete t.name;
    return t;
  } catch {
    return undefined;
  }
}

function getPerformanceEntryInitiatorType(
  entry: ObservedPerformanceEntry,
): NetworkInitiatorType {
  return isNavigationTiming(entry)
    ? 'navigation'
    : (entry.initiatorType as NetworkInitiatorType);
}

function shouldRecordPerformanceEntry(
  entry: PerformanceEntry,
  options: Required<NetworkRecordOptions>,
): entry is ObservedPerformanceEntry {
  return (
    (isNavigationTiming(entry) || isResourceTiming(entry)) &&
    options.initiatorTypes.includes(
      getPerformanceEntryInitiatorType(entry as ObservedPerformanceEntry),
    )
  );
}

function initPerformanceObserver(
  cb: networkCallback,
  win: IWindow,
  options: Required<NetworkRecordOptions>,
) {
  if (options.recordInitialRequests) {
    const initialPerformanceEntries = win.performance
      .getEntries()
      .filter((entry): entry is ObservedPerformanceEntry =>
        shouldRecordPerformanceEntry(entry, options),
      );
    cb({
      requests: initialPerformanceEntries.map((entry) => ({
        initiatorType: getPerformanceEntryInitiatorType(entry),
        duration: entry.duration,
        entryType: entry.entryType,
        name: entry.name,
        status: 'responseStatus' in entry ? entry.responseStatus : undefined,
        startTime: entry.startTime,
        endTime: entry.responseEnd,
        timing: timingOf(entry),
      })),
      isInitial: true,
    });
  }
  const observer = new win.PerformanceObserver((entries) => {
    const benchStart = benchNow();
    const shouldRecordViaPerformanceObserver = (
      entry: ObservedPerformanceEntry,
    ) =>
      options.recordBody || options.recordHeaders
        ? entry.initiatorType !== 'xmlhttprequest' &&
          entry.initiatorType !== 'fetch'
        : true;
    const performanceEntries = entries
      .getEntries()
      .filter(
        (entry): entry is ObservedPerformanceEntry =>
          shouldRecordPerformanceEntry(entry, options) &&
          shouldRecordViaPerformanceObserver(entry),
      );
    cb({
      requests: performanceEntries.map((entry) => ({
        initiatorType: getPerformanceEntryInitiatorType(entry),
        status: 'responseStatus' in entry ? entry.responseStatus : undefined,
        startTime: entry.startTime,
        endTime: entry.responseEnd,
        timing: timingOf(entry),
        duration: entry.duration,
        entryType: entry.entryType,
        name: entry.name,
      })),
    });
    benchEnd(benchStart);
  });
  observer.observe({ entryTypes: ['navigation', 'resource'] });
  return () => {
    observer.disconnect();
  };
}

function shouldRecordHeaders(
  type: 'request' | 'response',
  recordHeaders: NetworkRecordOptions['recordHeaders'],
) {
  return (
    !!recordHeaders &&
    (typeof recordHeaders === 'boolean' || recordHeaders[type])
  );
}

function shouldRecordBody(
  type: 'request' | 'response',
  recordBody: NetworkRecordOptions['recordBody'],
  headers: NetworkHeaders,
  url?: string | URL | RequestInfo,
) {
  function matchesContentType(contentTypes: string[]) {
    const contentTypeHeader = Object.keys(headers).find(
      (key) => key.toLowerCase() === 'content-type',
    );
    const contentType = contentTypeHeader && headers[contentTypeHeader];
    return contentTypes.some((ct) => contentType?.includes(ct));
  }
  if (isBlobUrl(url)) return false;
  if (!recordBody) return false;
  if (typeof recordBody === 'boolean') return true;
  if (Array.isArray(recordBody)) return matchesContentType(recordBody);
  const recordBodyType = recordBody[type];
  if (typeof recordBodyType === 'boolean') return recordBodyType;
  return matchesContentType(recordBodyType);
}

function isRequest(value: unknown): value is Request {
  if (typeof Request === 'undefined') {
    return false;
  }
  if (value instanceof Request) {
    return true;
  }
  try {
    return Object.prototype.toString.call(value) === '[object Request]';
  } catch {
    return false;
  }
}

function isBlobUrl(url?: string | URL | RequestInfo): boolean {
  try {
    if (typeof url === 'string') {
      return url.startsWith('blob:');
    }
    if (url instanceof URL) {
      return url.protocol === 'blob:';
    }
    if (isRequest(url)) {
      return isBlobUrl(url.url);
    }
  } catch {
    //
  }
  return false;
}

function isReadableStreamBody(
  body: unknown,
): body is ReadableStream<Uint8Array> {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as ReadableStream<Uint8Array>).getReader === 'function' &&
    typeof (body as ReadableStream<Uint8Array>).tee === 'function'
  );
}

/**
 * Panopticon item 8: a FormData holding a file keeps every entry in order,
 * each file with its name, type, size and bytes (base64); one of strings
 * only stays its urlencoded text, as before.
 */
function readFormData(body: FormData): NetworkBody | Promise<NetworkBody> {
  const entries: Array<[string, FormDataEntryValue]> = [];
  body.forEach((value, key) => entries.push([key, value]));
  const isFile = (v: FormDataEntryValue): v is File =>
    typeof v !== 'string' && typeof Blob !== 'undefined' && v instanceof Blob;
  if (!entries.some(([, v]) => isFile(v))) return stringifyFormData(body);
  return Promise.all(
    entries.map(([key, v]): Promise<[string, string | NetworkFormDataFile]> =>
      isFile(v)
        ? blobBytes(v).then((b): [string, NetworkFormDataFile] => [
            key,
            {
              name: v.name,
              type: v.type,
              size: v.size,
              base64: toBase64(new Uint8Array(b)),
            },
          ])
        : Promise.resolve([key, String(v)]),
    ),
  ).then(
    (formData) => ({ formData }),
    (error: unknown) => `[rrweb/network] Failed to read body: ${String(error)}`,
  );
}

function stringifyFormData(body: FormData) {
  const searchParams = new URLSearchParams();
  body.forEach((value, key) => {
    searchParams.append(
      key,
      typeof File !== 'undefined' && value instanceof File
        ? value.name
        : String(value),
    );
  });
  return searchParams.toString();
}

/**
 * Panopticon item 8: bodies are recorded byte for byte. Bytes that are
 * valid UTF-8 are kept as exactly that text (a leading BOM included), any
 * other bytes as base64: a binary body is neither a placeholder nor a
 * lossy decode.
 */
const utf8 =
  typeof TextDecoder !== 'undefined'
    ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    : null;

function bytesToBody(bytes: Uint8Array): NetworkBody {
  if (utf8) {
    try {
      return utf8.decode(bytes);
    } catch {
      // not UTF-8: base64 below
    }
  }
  return { base64: toBase64(bytes) };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + 0x8000) as unknown as number[],
    );
  return btoa(s);
}

/**
 * Panopticon item 8: a Document as markup (its textContent dropped every
 * tag and attribute): XML documents through XMLSerializer, HTML documents
 * as their children's HTML (doctype, comments, the root element).
 */
function serializeDocument(doc: Document): string | null {
  try {
    const html = /html/i.test(doc.contentType || 'text/html');
    if (!html && typeof XMLSerializer !== 'undefined')
      return new XMLSerializer().serializeToString(doc);
    let s = '';
    doc.childNodes.forEach((n) => {
      if (n.nodeType === 10) s += `<!DOCTYPE ${(n as DocumentType).name}>`;
      else if (n.nodeType === 8) s += `<!--${n.nodeValue ?? ''}-->`;
      else if (n.nodeType === 1) s += (n as Element).outerHTML;
    });
    return s;
  } catch {
    return doc.textContent;
  }
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function readBlob(blob: Blob): Promise<NetworkBody> {
  return blobBytes(blob).then(
    (b) => bytesToBody(new Uint8Array(b)),
    (error: unknown) => `[rrweb/network] Failed to read body: ${String(error)}`,
  );
}

function readXhrBody(
  body: Document | XMLHttpRequestBodyInit | unknown | null | undefined,
): NetworkBody | Promise<NetworkBody> {
  if (body === undefined || body === null) {
    return null;
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return readFormData(body);
  }
  if (typeof Document !== 'undefined' && body instanceof Document) {
    return serializeDocument(body);
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return readBlob(body);
  }
  // decoded now: the bytes as of send() / the response
  if (body instanceof ArrayBuffer) {
    return bytesToBody(new Uint8Array(body));
  }
  if (ArrayBuffer.isView(body as ArrayBufferView)) {
    const v = body as ArrayBufferView;
    return bytesToBody(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  try {
    return JSON.stringify(body);
  } catch {
    return `[rrweb/network] Failed to stringify body`;
  }
}

/**
 * The whole body, however long it takes (Panopticon item 8: no timeout, a
 * slow or streamed body is recorded in full). The copy is taken now, so
 * the page reads its own body undisturbed and is never kept waiting.
 */
function readFetchBody(
  requestOrResponse: Request | Response,
): Promise<NetworkBody> {
  let copy: Request | Response;
  try {
    copy = requestOrResponse.clone();
  } catch {
    return Promise.resolve('[rrweb/network] Failed to read body');
  }
  return copy.arrayBuffer().then(
    (b) => bytesToBody(new Uint8Array(b)),
    (error: unknown) => `[rrweb/network] Failed to read body: ${String(error)}`,
  );
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * A response body read chunk by chunk into `chunks` (Panopticon item 8:
 * what was read so far is there when the recording stops mid-stream). A
 * read that fails after some bytes keeps them.
 */
function readResponseBody(
  res: Response,
  chunks: Uint8Array[],
): Promise<NetworkBody> {
  let copy: Response;
  try {
    copy = res.clone();
  } catch {
    return Promise.resolve('[rrweb/network] Failed to read body');
  }
  const body = copy.body;
  if (!body || typeof body.getReader !== 'function') return readFetchBody(copy);
  const reader = body.getReader();
  const pump = (): Promise<NetworkBody> =>
    reader.read().then(({ done, value }) => {
      if (done) return bytesToBody(concatBytes(chunks));
      if (value) chunks.push(value);
      return pump();
    });
  return pump().catch((error: unknown) =>
    chunks.length
      ? bytesToBody(concatBytes(chunks))
      : `[rrweb/network] Failed to read body: ${String(error)}`,
  );
}

async function getRequestPerformanceEntry(
  win: IWindow,
  initiatorType: string,
  url: string,
  after?: number,
  before?: number,
  attempt = 0,
): Promise<PerformanceResourceTiming | null> {
  if (attempt > 10) {
    return null;
  }
  const urlPerformanceEntries = win.performance.getEntriesByName(
    url,
  ) as PerformanceResourceTiming[];
  const performanceEntry = findLast(
    urlPerformanceEntries,
    (entry) =>
      isResourceTiming(entry) &&
      entry.initiatorType === initiatorType &&
      (!after || entry.startTime >= after) &&
      (!before || entry.startTime <= before),
  );
  if (!performanceEntry) {
    await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    return getRequestPerformanceEntry(
      win,
      initiatorType,
      url,
      after,
      before,
      attempt + 1,
    );
  }
  return performanceEntry;
}

function initXhrObserver(
  cb: networkCallback,
  win: IWindow,
  options: Required<NetworkRecordOptions>,
): listenerHandler {
  if (!options.initiatorTypes.includes('xmlhttprequest')) {
    return () => {
      //
    };
  }
  const recordRequestHeaders = shouldRecordHeaders(
    'request',
    options.recordHeaders,
  );
  const recordResponseHeaders = shouldRecordHeaders(
    'response',
    options.recordHeaders,
  );
  const restorePatch = patch(win.XMLHttpRequest.prototype, 'open', ((
    originalOpen: typeof XMLHttpRequest.prototype.open,
  ) => {
    return function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async = true,
      username?: string | null,
      password?: string | null,
    ) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const xhr = this;
      const req = new Request(url, { method });
      const networkRequest: Partial<NetworkRequest> = {};
      // bodies still being read (a Blob): the request is reported after them
      const reads: Promise<void>[] = [];
      const setBody = (
        key: 'requestBody' | 'responseBody',
        body: NetworkBody | Promise<NetworkBody>,
      ) => {
        if (body instanceof Promise)
          reads.push(
            body.then((b) => {
              networkRequest[key] = b;
            }),
          );
        else networkRequest[key] = body;
      };
      let after: number | undefined;
      let before: number | undefined;
      const requestHeaders: NetworkHeaders = {};
      const originalSetRequestHeader = xhr.setRequestHeader.bind(xhr);
      xhr.setRequestHeader = (header: string, value: string) => {
        requestHeaders[header] = value;
        return originalSetRequestHeader(header, value);
      };
      if (recordRequestHeaders) {
        networkRequest.requestHeaders = requestHeaders;
      }
      const originalSend = xhr.send.bind(xhr);
      xhr.send = (body) => {
        if (
          shouldRecordBody('request', options.recordBody, requestHeaders, url)
        ) {
          setBody('requestBody', readXhrBody(body));
        }
        after = win.performance.now();
        return originalSend(body);
      };
      xhr.addEventListener('readystatechange', () => {
        if (xhr.readyState !== xhr.DONE) {
          return;
        }
        before = win.performance.now();
        const responseHeaders: NetworkHeaders = {};
        const rawHeaders = xhr.getAllResponseHeaders();
        const headers = rawHeaders.trim().split(/[\r\n]+/);
        headers.forEach((line) => {
          const parts = line.split(': ');
          const header = parts.shift();
          const value = parts.join(': ');
          if (header) {
            responseHeaders[header] = value;
          }
        });
        if (recordResponseHeaders) {
          networkRequest.responseHeaders = responseHeaders;
        }
        if (
          shouldRecordBody('response', options.recordBody, responseHeaders, url)
        ) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          setBody('responseBody', readXhrBody(xhr.response));
        }
        Promise.all(reads)
          .then(() =>
            getRequestPerformanceEntry(
              win,
              'xmlhttprequest',
              req.url,
              after,
              before,
            ),
          )
          .then((entry) => {
            if (!entry) {
              // https://github.com/rrweb-io/rrweb/pull/1105#issuecomment-1953808336
              const requests = prepareRequestWithoutPerformance(
                req,
                networkRequest,
              );
              cb({ requests });
              return;
            }

            const requests = prepareRequest(
              entry,
              method,
              xhr.status,
              networkRequest,
            );
            cb({ requests });
          })
          .catch(() => {
            //
          });
      });
      originalOpen.call(xhr, method, url, async, username, password);
    };
  }) as (...args: unknown[]) => unknown);
  return () => {
    restorePatch();
  };
}

function initFetchObserver(
  cb: networkCallback,
  win: IWindow,
  options: Required<NetworkRecordOptions>,
): listenerHandler {
  if (!options.initiatorTypes.includes('fetch')) {
    return () => {
      //
    };
  }
  const recordRequestHeaders = shouldRecordHeaders(
    'request',
    options.recordHeaders,
  );
  const recordResponseHeaders = shouldRecordHeaders(
    'response',
    options.recordHeaders,
  );
  // response bodies still being read: reported partially at stop
  const reading = new Set<() => void>();
  const restorePatch = patch(win, 'fetch', ((originalFetch: typeof fetch) => {
    return async function (
      url: URL | RequestInfo,
      init?: RequestInit | undefined,
    ) {
      const req = new Request(url, init);
      let res: Response | undefined;
      const networkRequest: Partial<NetworkRequest> = {};
      // bodies are read beside the page (no await before the request goes
      // out or before the page gets its response); reported after them
      const reads: Promise<void>[] = [];
      let after: number | undefined;
      let before: number | undefined;
      try {
        const requestHeaders: NetworkHeaders = {};
        req.headers.forEach((value, header) => {
          requestHeaders[header] = value;
        });
        if (recordRequestHeaders) {
          networkRequest.requestHeaders = requestHeaders;
        }
        if (
          !isReadableStreamBody(init?.body) &&
          shouldRecordBody('request', options.recordBody, requestHeaders, url)
        ) {
          reads.push(
            readFetchBody(req).then((b) => {
              networkRequest.requestBody = b;
            }),
          );
        }
        after = win.performance.now();
        res = isRequest(url)
          ? await originalFetch(req)
          : await originalFetch(url, init);
        before = win.performance.now();
        const responseHeaders: NetworkHeaders = {};
        res.headers.forEach((value, header) => {
          responseHeaders[header] = value;
        });
        if (recordResponseHeaders) {
          networkRequest.responseHeaders = responseHeaders;
        }
        if (
          shouldRecordBody('response', options.recordBody, responseHeaders, url)
        ) {
          const chunks: Uint8Array[] = [];
          const status = res.status;
          const partial = () =>
            cb({
              requests: [
                {
                  ...prepareRequestWithoutPerformance(req, networkRequest)[0],
                  status,
                  responseBody: bytesToBody(concatBytes(chunks)),
                  responseBodyPartial: true,
                },
              ],
            });
          reading.add(partial);
          reads.push(
            readResponseBody(res, chunks).then((b) => {
              reading.delete(partial);
              networkRequest.responseBody = b;
            }),
          );
        }
        return res;
      } finally {
        Promise.all(reads)
          .then(() =>
            getRequestPerformanceEntry(win, 'fetch', req.url, after, before),
          )
          .then((entry) => {
            if (!entry) {
              // https://github.com/rrweb-io/rrweb/pull/1105#issuecomment-1953808336
              const requests = prepareRequestWithoutPerformance(
                req,
                networkRequest,
              );
              cb({ requests });
              return;
            }

            const requests = prepareRequest(
              entry,
              req.method,
              res?.status,
              networkRequest,
            );
            cb({ requests });
          })
          .catch(() => {
            //
          });
      }
    };
  }) as (...args: unknown[]) => unknown);
  return () => {
    // a body still streaming: what was read so far, marked partial; the
    // whole body follows when it ends (initNetworkObserver routes it)
    for (const partial of [...reading]) partial();
    reading.clear();
    restorePatch();
  };
}

/**
 * Panopticon item 8: a request that completes after its recording stopped
 * (a body still streaming at stop; its partial body was reported at stop)
 * is sanitized with the transformRequestFn of the recording it belongs to,
 * then goes to the recording running on that window, or waits for the next
 * one, ONLY when that recording has the same non-empty carryOverKey (the
 * same replay session and config). Without a key, or with another key, it
 * is dropped: data never moves into a recording it was not recorded for.
 */
type ActiveRecording = { key: string; emit: networkCallback };
const activeCallbacks = new WeakMap<object, ActiveRecording>();
const carried = new WeakMap<object, { key: string; data: NetworkData }[]>();

function initNetworkObserver(
  callback: networkCallback,
  win: IWindow, // top window or in an iframe
  options: NetworkRecordOptions,
): listenerHandler {
  if (!('performance' in win)) {
    return () => {
      //
    };
  }
  const networkOptions = (
    options
      ? Object.assign({}, defaultNetworkOptions, options)
      : defaultNetworkOptions
  ) as Required<NetworkRecordOptions>;

  const sanitize = (data: NetworkData): NetworkData => ({
    ...data,
    requests: data.requests
      .map((request) => networkOptions.transformRequestFn(request))
      .filter(Boolean) as NetworkRequest[],
  });
  // already-sanitized data, from this recording or carried over
  const emit: networkCallback = (data) => {
    if (data.requests.length > 0 || data.isInitial) callback(data);
  };
  const cb: networkCallback = (data) => {
    const benchStart = benchNow();
    emit(sanitize(data));
    benchEnd(benchStart);
  };
  const key = networkOptions.carryOverKey || '';
  let stopped = false;
  const deliver: networkCallback = (data) => {
    if (!stopped) return cb(data);
    if (!key) return;
    const clean = sanitize(data);
    if (clean.requests.length === 0) return;
    const next = activeCallbacks.get(win);
    if (next) {
      if (next.key === key) next.emit(clean);
      return;
    }
    const q = carried.get(win) || [];
    q.push({ key, data: clean });
    carried.set(win, q);
  };
  const self: ActiveRecording = { key, emit };
  activeCallbacks.set(win, self);
  const late = carried.get(win);
  if (late) {
    carried.delete(win);
    if (key) for (const entry of late) if (entry.key === key) emit(entry.data);
  }
  const performanceObserver = initPerformanceObserver(cb, win, networkOptions);
  let xhrObserver: listenerHandler = () => {
    //
  };
  let fetchObserver: listenerHandler = () => {
    //
  };
  if (networkOptions.recordHeaders || networkOptions.recordBody) {
    xhrObserver = initXhrObserver(deliver, win, networkOptions);
    fetchObserver = initFetchObserver(deliver, win, networkOptions);
  }
  return () => {
    performanceObserver();
    xhrObserver();
    fetchObserver();
    stopped = true;
    if (activeCallbacks.get(win) === self) activeCallbacks.delete(win);
  };
}

function prepareRequest(
  entry: PerformanceResourceTiming,
  method: string | undefined,
  status: number | undefined,
  networkRequest: Partial<NetworkRequest>,
): NetworkRequest[] {
  const request: NetworkRequest = {
    method,
    initiatorType: entry.initiatorType as NetworkInitiatorType,
    duration: entry.duration,
    entryType: entry.entryType,
    name: entry.name,
    status,
    startTime: entry.startTime,
    endTime: entry.responseEnd,
    timing: timingOf(entry),
    requestHeaders: networkRequest.requestHeaders,
    requestBody: networkRequest.requestBody,
    responseHeaders: networkRequest.responseHeaders,
    responseBody: networkRequest.responseBody,
  };

  return [request];
}

function prepareRequestWithoutPerformance(
  req: Request,
  networkRequest: Partial<NetworkRequest>,
): NetworkRequest[] {
  const request: NetworkRequest = {
    name: req.url,
    method: req.method,
    requestHeaders: networkRequest.requestHeaders,
    requestBody: networkRequest.requestBody,
    responseHeaders: networkRequest.responseHeaders,
    responseBody: networkRequest.responseBody,
  };

  return [request];
}

function findLast<T>(
  array: Array<T>,
  predicate: (value: T) => boolean,
): T | undefined {
  const length = array.length;
  for (let i = length - 1; i >= 0; i -= 1) {
    if (predicate(array[i])) {
      return array[i];
    }
  }
}

export const PLUGIN_NAME = 'rrweb/network@1';

export const getRecordNetworkPlugin: (
  options?: NetworkRecordOptions,
) => RecordPlugin = (options) => ({
  name: PLUGIN_NAME,
  observer: initNetworkObserver as RecordPlugin['observer'],
  options: options,
});
