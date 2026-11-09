/**
 * Panopticon RR-017 / item 8: snapshotSliced() walks a frozen copy of the
 * page in serializeNodeWithId's exact order and produces byte-identical
 * output to the synchronous snapshot() taken when it started, even when it
 * yields after every node and the page changes in between.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import snapshot, {
  cleanupSnapshot,
  freezeDocument,
  noteSheetMutation,
  selectorMatchesOnCopy,
  snapshotSliced,
} from '../src/snapshot';
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

  it('the page changing between slices: the snapshot is the page as of its start, byte for byte (item 8)', async () => {
    const html =
      '<ul id="l"><li id="a">a</li><li id="b" class="x">b</li><li id="c">c</li></ul>' +
      '<input id="i" value="v0"><style id="s">.a{color:red}</style><p id="tail">t</p>';
    const doc = load(html);
    const expected = syncJson(doc);
    let step = 0;
    const slicer = everyNode(() => {
      if (++step !== 4) return;
      // removed before the walk reached it
      doc.getElementById('c')!.remove();
      // added to a parent the walk has listed
      const d = doc.createElement('li');
      d.id = 'd';
      doc.getElementById('l')!.appendChild(d);
      // attribute, text, form value and CSSOM changes of nodes not walked yet
      doc.getElementById('b')!.className = 'y';
      doc.getElementById('tail')!.firstChild!.textContent = 'changed';
      (doc.getElementById('i') as HTMLInputElement).value = 'v1';
      const sheet = (doc.getElementById('s') as HTMLStyleElement).sheet!;
      noteSheetMutation(sheet); // what rrweb's CSSOM patches call first
      sheet.insertRule('.late{color:blue}', 1);
    });
    expect(await slicedJson(doc, slicer)).toBe(expected);
    expect(step).toBeGreaterThan(4);
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

  it.each([
    [
      'class',
      (el: Element) => el.classList.add('rr-block'),
      (el: Element) => el.classList.remove('rr-block'),
    ],
    [
      'selector',
      (el: Element) => el.setAttribute('data-block', ''),
      (el: Element) => el.removeAttribute('data-block'),
    ],
  ])(
    'a block (%s) added or removed between slices: the block as of the start decides, as in snapshot() then (privacy: a blocked element never shows its content)',
    async (_how, block, unblock) => {
      const html =
        '<div id="p"><span id="s1">open one</span><span id="s2">open two</span></div>' +
        '<div id="q"><span id="h1">secret one</span><span id="h2">secret two</span></div><p id="after">after</p>';
      const doc = load(html);
      block(doc.getElementById('q')!);
      const expected = syncJson(doc);
      expect(expected).not.toContain('secret');
      const mirror = new Mirror();
      let changed = false;
      cleanupSnapshot();
      const sn = await snapshotSliced(
        doc,
        { ...OPTIONS, mirror },
        {
          shouldYield: () => true,
          yieldSlice: async () => {
            if (changed) return;
            changed = true;
            block(doc.getElementById('p')!);
            unblock(doc.getElementById('q')!);
          },
        },
      );
      expect(changed).toBe(true);
      const json = JSON.stringify(sn);
      expect(json).toBe(expected);
      expect(json).toContain('open two');
      expect(json).not.toContain('secret');
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

describe('freeze privacy selectors (fail closed)', () => {
  it('only structural pseudo-classes let a copy decide block / mask', () => {
    for (const sel of [
      '.mask',
      '[data-block]',
      'ul > li:nth-child(2n+1)',
      'div:not(.x):has(> p:first-child)',
      'p:empty',
    ])
      expect(selectorMatchesOnCopy(sel), sel).toBe(true);
    for (const sel of [
      'input:checked',
      'option:checked ~ .x',
      'input:indeterminate',
      'input:placeholder-shown',
      'input:invalid',
      'x-el:state(open)',
      'x-el:--open',
      ':root .secret',
      'p::first-line',
      'a:HOVER',
      'a:hov\\65r',
      '[data-k="a:b"]',
      'div:has(input:checked)',
      ':focus-within .x',
    ])
      expect(selectorMatchesOnCopy(sel), sel).toBe(false);
  });

  it('a state-dependent mask or block selector makes freezeDocument give up', () => {
    const { window } = new JSDOM(
      '<p class="mask">a</p><input type="checkbox">',
    );
    const doc = window.document;
    expect(
      freezeDocument(doc, {
        mirror: new Mirror(),
        maskTextSelector: 'body:has(input:indeterminate) p',
      }),
    ).toBeNull();
    expect(
      freezeDocument(doc, {
        mirror: new Mirror(),
        blockSelector: 'option:checked',
      }),
    ).toBeNull();
    expect(
      freezeDocument(doc, { mirror: new Mirror(), maskTextSelector: '.mask' }),
    ).not.toBeNull();
  });
});
