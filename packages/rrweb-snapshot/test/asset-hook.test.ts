/**
 * Panopticon RR-030: the asset hook sees every large `_cssText`,
 * `rr_dataURL` and `data:` attribute value at serialization time. A hook
 * returning null changes nothing; a marker hook plus the side table gives
 * back the hook-less output byte for byte.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import snapshot, {
  cleanupSnapshot,
  setAssetHook,
  snapshotSliced,
} from '../src/snapshot';
import { Mirror } from '../src/utils';

const htmlDir = path.join(__dirname, 'html');
const fixtures = fs.readdirSync(htmlDir).filter((f) => f.endsWith('.html'));

const bigCss = Array.from(
  { length: 120 },
  (_, i) =>
    `.c${i}{color:#${(i * 4099)
      .toString(16)
      .padStart(6, '0')
      .slice(0, 6)};margin:${i}px}`,
).join('');
const dataUrl = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(200);
const ASSET_PAGE = `<!doctype html><html><head><style>${bigCss}</style><style>.small{color:red}</style></head>
<body><img src="${dataUrl}"><img src="data:image/gif;base64,R0lGOD"><a href="${dataUrl}">x</a><p style="color:blue">t</p></body></html>`;

const OPTIONS = { inlineStylesheet: true, slimDOM: 'all' as const };
const load = (html: string) =>
  new JSDOM(html, { url: 'http://localhost/p.html', pretendToBeVisual: true })
    .window.document;

function json(
  doc: Document,
  assetHook?: (k: 'css' | 'media', v: string) => string | null,
) {
  cleanupSnapshot();
  return JSON.stringify(
    snapshot(doc, { ...OPTIONS, mirror: new Mirror(), assetHook }),
  );
}

function markerHook() {
  const side: string[] = [];
  const kinds: string[] = [];
  const hook = (kind: 'css' | 'media', value: string) => {
    if (value.length < 1024) return null;
    kinds.push(kind);
    return `__pano_tmp__/${side.push(value) - 1}`;
  };
  const restore = (j: string) =>
    side.reduce(
      (out, v, n) =>
        out.replace(`"__pano_tmp__/${n}"`, () => JSON.stringify(v)),
      j,
    );
  return { hook, side, kinds, restore };
}

describe('asset hook (RR-030)', () => {
  it.each([...fixtures, 'assets'])(
    '%s: a hook returning null is byte-identical to no hook',
    (file) => {
      const html =
        file === 'assets'
          ? ASSET_PAGE
          : fs.readFileSync(path.join(htmlDir, file), 'utf8');
      const doc = load(html);
      expect(json(doc, () => null)).toBe(json(doc));
    },
  );

  it('marker hook: large css and data: values leave the snapshot, substituting them back is byte-identical', () => {
    const doc = load(ASSET_PAGE);
    const plain = json(doc);
    const m = markerHook();
    const marked = json(doc, m.hook);
    expect(m.kinds).toEqual(['css', 'media', 'media']);
    expect(marked.length).toBeLessThan(plain.length - bigCss.length);
    expect(marked).not.toContain('iVBORw0KGgo');
    expect(marked).toContain('R0lGOD'); // small values stay inline
    expect(m.restore(marked)).toBe(plain);
  });

  it('sliced snapshot with the hook installed by setAssetHook: same markers, same restore', async () => {
    const doc = load(ASSET_PAGE);
    const plain = json(doc);
    const m = markerHook();
    const prev = setAssetHook(m.hook);
    cleanupSnapshot();
    const sn = await snapshotSliced(
      doc,
      { ...OPTIONS, mirror: new Mirror() },
      {
        shouldYield: () => true,
        yieldSlice: () => Promise.resolve(),
      },
    );
    setAssetHook(prev);
    expect(m.side).toHaveLength(3);
    expect(m.restore(JSON.stringify(sn))).toBe(plain);
  });

  it('snapshot({assetHook}) does not leave the hook installed', () => {
    const doc = load(ASSET_PAGE);
    json(doc, markerHook().hook);
    expect(json(doc)).toContain('iVBORw0KGgo');
  });
});
