import { encode } from 'base64-arraybuffer';
import type {
  DataURLOptions,
  ImageBitmapDataURLWorkerParams,
  ImageBitmapDataURLWorkerResponse,
} from '@rrweb/types';

import { getScaledDimensions } from './getScaledDimensions';

const lastBlobMap: Map<number, string> = new Map();
const transparentBlobMap: Map<string, string> = new Map();

export interface ImageBitmapDataURLRequestWorker {
  postMessage: (
    message: ImageBitmapDataURLWorkerParams,
    transfer?: [ImageBitmap],
  ) => void;
  onmessage: (message: MessageEvent<ImageBitmapDataURLWorkerResponse>) => void;
}

interface ImageBitmapDataURLResponseWorker {
  onmessage:
    | null
    | ((message: MessageEvent<ImageBitmapDataURLWorkerParams>) => void);
  postMessage(e: ImageBitmapDataURLWorkerResponse): void;
}

async function getTransparentBlobFor(
  width: number,
  height: number,
  dataURLOptions: DataURLOptions,
): Promise<string> {
  const id = width + '-' + height;
  if ('OffscreenCanvas' in globalThis) {
    if (transparentBlobMap.has(id)) return transparentBlobMap.get(id)!;
    const offscreen = new OffscreenCanvas(width, height);
    offscreen.getContext('2d'); // creates rendering context for `converToBlob`
    const blob = await offscreen.convertToBlob(dataURLOptions); // takes a while
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = encode(arrayBuffer); // cpu intensive
    transparentBlobMap.set(id, base64);
    return base64;
  } else {
    return '';
  }
}

/** sha-256 of the bytes as base64, or undefined without WebCrypto (insecure context). */
async function sha256(b: ArrayBuffer): Promise<string | undefined> {
  try {
    if (!globalThis.crypto || !crypto.subtle) return undefined;
    return encode(await crypto.subtle.digest('SHA-256', b));
  } catch {
    return undefined;
  }
}

// `as any` because: https://github.com/Microsoft/TypeScript/issues/20595
const worker: ImageBitmapDataURLResponseWorker = self;

const handle = async function (
  e: MessageEvent<ImageBitmapDataURLWorkerParams>,
) {
  if ('OffscreenCanvas' in globalThis && e.data.initial !== undefined) {
    // Panopticon item 8: a full snapshot's pixels, the bytes toDataURL()
    // gives (same encoder, full size), or none for a blank canvas, as the
    // synchronous snapshot decides. Frame dedup (lastBlobMap) untouched.
    const { id, initial, bitmap, width, height, dataURLOptions } = e.data;
    try {
      const offscreen = new OffscreenCanvas(width, height);
      offscreen.getContext('bitmaprenderer')?.transferFromImageBitmap(bitmap);
      const blob = await offscreen.convertToBlob(dataURLOptions);
      const base64 = encode(await blob.arrayBuffer());
      if (
        base64 === (await getTransparentBlobFor(width, height, dataURLOptions))
      )
        return worker.postMessage({ id, initial });
      return worker.postMessage({
        id,
        initial,
        type: blob.type,
        base64,
        width,
        height,
      });
    } catch {
      bitmap.close();
      return worker.postMessage({ id, initial });
    }
  }
  if ('OffscreenCanvas' in globalThis) {
    const { id, bitmap, width, height, maxCanvasSize, dataURLOptions } = e.data;

    const transparentBase64 = getTransparentBlobFor(
      width,
      height,
      dataURLOptions,
    );

    const [targetWidth, targetHeight] = getScaledDimensions(
      width,
      height,
      maxCanvasSize,
    );
    const offscreen = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = offscreen.getContext('bitmaprenderer');

    const resizedBitmap =
      targetWidth === width && targetHeight === height
        ? bitmap
        : // resize bitmap to fit within maxsize
          // ~95% browser support https://caniuse.com/mdn-api_createimagebitmap_options_resizewidth_parameter
          await createImageBitmap(bitmap, {
            resizeWidth: targetWidth,
            resizeHeight: targetHeight,
            resizeQuality: 'low',
          });

    ctx?.transferFromImageBitmap(resizedBitmap);
    bitmap.close();

    const blob = await offscreen.convertToBlob(dataURLOptions); // takes a while
    const type = blob.type;
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = encode(arrayBuffer); // cpu intensive
    resizedBitmap.close();

    if (e.data.seq !== undefined) {
      // Panopticon item 8: one of several workers; the canvas manager keeps
      // the order and drops exact repeats, by this hash (it keeps the hash
      // of a canvas's last frame, not its bytes)
      return worker.postMessage({
        id,
        seq: e.data.seq,
        hash: await sha256(arrayBuffer),
        transparent: (await transparentBase64) === base64,
        type,
        base64,
        width,
        height,
      });
    }

    // on first try we should check if canvas is transparent,
    // no need to save it's contents in that case
    if (!lastBlobMap.has(id) && (await transparentBase64) === base64) {
      lastBlobMap.set(id, base64);
      return worker.postMessage({ id });
    }

    if (lastBlobMap.get(id) === base64) return worker.postMessage({ id }); // unchanged
    worker.postMessage({
      id,
      type,
      base64,
      width,
      height,
    });
    lastBlobMap.set(id, base64);
  } else {
    return worker.postMessage({
      id: e.data.id,
      seq: e.data.seq,
      initial: e.data.initial,
    });
  }
};

worker.onmessage = (e) => {
  // a failed frame still answers, so the canvas manager's order moves on
  handle(e).catch(() => {
    worker.postMessage({
      id: e.data.id,
      seq: e.data.seq,
      initial: e.data.initial,
    });
  });
};
