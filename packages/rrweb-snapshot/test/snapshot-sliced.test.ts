/**
 * Panopticon RR-017: snapshotSliced() walks the DOM in serializeNodeWithId's
 * exact order and, on a page that does not change, produces byte-identical
 * output to the synchronous snapshot() even when it yields after every node.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import snapshot, { cleanupSnapshot, snapshotSliced } from '../src/snapshot';
import type { SnapshotSlicer } from '../src/snapshot';
import { Mirror } from '../src/utils';
import { NodeType } from '@rrweb/types';
import type { serializedNodeWithId } from '@rrweb/types';

const htmlDir = path.join(__dirname, 'html');
const fixtures = fs.readdirSync(htmlDir).filter((f) => f.endsWith('.html'));

const OPTIONS = {
  inlineStylesheet: true,
  maskAllInputs: true,
  slimDOM: 'all' as const,
  blockSelector: '[data-block]',
  maskTextSelector: '.mask',
};

/** Yield after every single node. */
function everyNode(onYield?: () => void): SnapshotSlicer & { yields: number } {
  const s = {
    yields: 0,
    shouldYield: () => true,
    yieldSlice: async () => {
      s.yields++;
      onYield?.();
      await Promise.resolve();
    },
  };
  return s;
}

function load(html: string, url = 'http://localhost/page.html') {
  return new JSDOM(html, { url, pretendToBeVisual: true }).window.document;
}

function syncJson(doc: Document) {
  cleanupSnapshot();
  return JSON.stringify(snapshot(doc, { ...OPTIONS, mirror: new Mirror() }));
}

async function slicedJson(doc: Document, slicer: SnapshotSlicer) {
  cleanupSnapshot();
  return JSON.stringify(
    await snapshotSliced(doc, { ...OPTIONS, mirror: new Mirror() }, slicer),
  );
}

describe('snapshotSliced (RR-017)', () => {
  it.each(fixtures)(
    '%s: byte-identical to snapshot() while yielding after every node',
    async (file) => {
      const html = fs.readFileSync(path.join(htmlDir, file), 'utf8');
      const doc = load(html);
      const expected = syncJson(doc);
      const slicer = everyNode();
      expect(await slicedJson(doc, slicer)).toBe(expected);
      expect(slicer.yields).toBeGreaterThan(0);
    },
  );

  it.each(fixtures)(
    '%s: finishNow() during a yield completes synchronously, byte-identical, and the promise gives the same node',
    async (file) => {
      const html = fs.readFileSync(path.join(htmlDir, file), 'utf8');
      const doc = load(html);
      const expected = syncJson(doc);
      let finishNow: (() => serializedNodeWithId | null) | undefined;
      let finished: serializedNodeWithId | null = null;
      let yields = 0;
      const slicer: SnapshotSlicer = {
        shouldYield: () => true,
        yieldSlice: async () => {
          yields++;
          // the recorder's flushMutations() / a user event, while the page has its turn
          if (yields === 3) finished = finishNow!();
          await Promise.resolve();
        },
        control: (f) => {
          finishNow = f;
        },
      };
      cleanupSnapshot();
      const promised = await snapshotSliced(
        doc,
        { ...OPTIONS, mirror: new Mirror() },
        slicer,
      );
      if (yields < 3) return; // a fixture too small to yield three times
      expect(finished).not.toBeNull();
      expect(JSON.stringify(finished)).toBe(expected);
      expect(promised).toBe(finished);
      expect(yields).toBe(3);
      expect(finishNow!()).toBe(finished);
    },
  );

  it('shadow roots and slots: identical, with isShadow / isShadowHost in the same places', async () => {
    const doc = load(
      '<div id="host"><span slot="a">light</span></div><p>after</p>',
    );
    const host = doc.getElementById('host')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<b>in shadow <slot name="a"></slot></b><i>two</i>';
    const expected = syncJson(doc);
    expect(expected).toContain('"isShadowHost":true');
    expect(expected).toContain('"isShadow":true');
    expect(await slicedJson(doc, everyNode())).toBe(expected);
  });

  it('a node removed between slices is not serialized; one added to a visited parent is left to the mutation buffer', async () => {
    const doc = load(
      '<ul id="l"><li id="a">a</li><li id="b">b</li><li id="c">c</li></ul><p id="tail">t</p>',
    );
    let step = 0;
    const slicer = everyNode(() => {
      step++;
      if (step === 4) {
        doc.getElementById('c')!.remove(); // listed with its parent, not visited yet
        const d = doc.createElement('li');
        d.id = 'd';
        doc.getElementById('l')!.appendChild(d); // parent already listed its children
      }
    });
    cleanupSnapshot();
    const sn = await snapshotSliced(
      doc,
      { ...OPTIONS, mirror: new Mirror() },
      slicer,
    );
    const ids: string[] = [];
    const walk = (n: serializedNodeWithId) => {
      if (n.type === NodeType.Element && typeof n.attributes.id === 'string')
        ids.push(n.attributes.id);
      if ('childNodes' in n) n.childNodes.forEach(walk);
    };
    walk(sn!);
    expect(ids).toContain('a');
    expect(ids).not.toContain('c');
    expect(ids).not.toContain('d');
    expect(ids).toContain('tail');
  });

  it('a node moved into a not-yet-visited part is serialized once', async () => {
    const doc = load(
      '<div id="x"><span id="m">m</span></div><div id="y"></div>',
    );
    let moved = false;
    cleanupSnapshot();
    const mirror = new Mirror();
    let calls = 0;
    const sn = await snapshotSliced(
      doc,
      { ...OPTIONS, mirror },
      {
        shouldYield: () => true,
        yieldSlice: async () => {
          calls++;
          const m = doc.getElementById('m')!;
          if (!moved && mirror.hasNode(m)) {
            doc.getElementById('y')!.appendChild(m);
            moved = true;
          }
        },
      },
    );
    expect(moved).toBe(true);
    expect(calls).toBeGreaterThan(0);
    const json = JSON.stringify(sn);
    expect(json.match(/"id":"m"/g)).toHaveLength(1);
  });

  it('a stylesheet changed between slices is serialized once, never with a duplicated rule', async () => {
    const doc = load('<style id="s">.a{color:red}</style><p>x</p><p>y</p>');
    const sheet = (doc.getElementById('s') as HTMLStyleElement).sheet!;
    let n = 0;
    cleanupSnapshot();
    const sn = await snapshotSliced(
      doc,
      { ...OPTIONS, mirror: new Mirror() },
      {
        shouldYield: () => true,
        yieldSlice: async () => {
          // every yield grows the sheet, before and after its owner was visited
          sheet.insertRule(`.r${n++}{color:blue}`, sheet.cssRules.length);
        },
      },
    );
    const json = JSON.stringify(sn);
    const css = /"_cssText":"([^"]*)"/.exec(json)![1];
    const rules = css.split('}').filter(Boolean);
    expect(new Set(rules).size).toBe(rules.length);
  });

  /** ids renumbered in DFS order: a dropped subtree consumed ids the other run never handed out */
  function renumber(sn: serializedNodeWithId | null): string {
    let next = 1;
    const walk = (n: serializedNodeWithId): unknown => {
      const out: Record<string, unknown> = { ...n, id: next++ };
      if ('childNodes' in n) out.childNodes = n.childNodes.map(walk);
      return out;
    };
    return JSON.stringify(sn && walk(sn));
  }

  it.each([
    ['class', (el: Element) => el.classList.add('rr-block')],
    ['selector', (el: Element) => el.setAttribute('data-block', '')],
  ])(
    'an ancestor blocked (%s) between slices: none of its children is serialized, same as snapshot() after the change (privacy fix 2)',
    async (_how, block) => {
      const html =
        '<div id="p"><span id="s1">secret one</span><span id="s2">secret two</span>' +
        '<b id="s3"><i>secret three</i></b></div><div id="q"><p id="after">after</p></div>';
      const doc = load(html);
      const mirror = new Mirror();
      let blocked = false;
      cleanupSnapshot();
      const sn = await snapshotSliced(
        doc,
        { ...OPTIONS, mirror },
        {
          shouldYield: () => true,
          yieldSlice: async () => {
            // #s1 and its text are serialized, #s2 / #s3 still queued
            if (
              !blocked &&
              mirror.hasNode(doc.getElementById('s1')!.firstChild!)
            ) {
              block(doc.getElementById('p')!);
              blocked = true;
            }
          },
        },
      );
      expect(blocked).toBe(true);
      const json = JSON.stringify(sn);
      expect(json).not.toContain('secret');
      expect(json).not.toMatch(/"id":"s[123]"/);
      expect(json).toContain('"rr_width"');
      expect(json).toContain('"id":"after"');
      // the dropped nodes are out of the mirror: later mutations of them are filtered
      expect(mirror.has(mirror.getId(doc.getElementById('s1')!))).toBe(false);
      expect(
        mirror.has(mirror.getId(doc.getElementById('s1')!.firstChild!)),
      ).toBe(false);
      expect(mirror.has(mirror.getId(doc.getElementById('p')!))).toBe(true);
      // what the synchronous snapshot of the changed page gives
      cleanupSnapshot();
      const after = snapshot(doc, { ...OPTIONS, mirror: new Mirror() });
      expect(renumber(sn)).toBe(renumber(after));
    },
  );

  it('a block on an element whose children are all done stays a capture of the earlier state', async () => {
    const doc = load(
      '<div id="p"><span>one</span></div><div id="q"><p>x</p><p>y</p></div>',
    );
    const mirror = new Mirror();
    let blocked = false;
    cleanupSnapshot();
    const sn = await snapshotSliced(
      doc,
      { ...OPTIONS, mirror },
      {
        shouldYield: () => true,
        yieldSlice: async () => {
          if (!blocked && mirror.hasNode(doc.querySelector('#q p')!)) {
            doc.getElementById('p')!.classList.add('rr-block');
            blocked = true;
          }
        },
      },
    );
    expect(blocked).toBe(true);
    // the mutation buffer records the class change; the snapshot holds what was read
    expect(JSON.stringify(sn)).toContain('"textContent":"one"');
  });

  it('completes when the slicer stops yielding (starvation guard on the recorder side)', async () => {
    const doc = load('<div>' + '<p>n</p>'.repeat(200) + '</div>');
    const expected = syncJson(doc);
    let calls = 0;
    const json = await slicedJson(doc, {
      shouldYield: () => calls < 5,
      yieldSlice: async () => {
        calls++;
      },
    });
    expect(calls).toBe(5);
    expect(json).toBe(expected);
  });
});
