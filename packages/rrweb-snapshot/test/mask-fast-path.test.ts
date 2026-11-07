/**
 * Panopticon RR-018: needMaskingText's closest() fast path gives the same
 * answer as the ancestor walk it short-circuits, for every node of a tree
 * mixing mask / unmask classes and selectors.
 * Run: npx vitest run --config vitest.panopticon.config.ts
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import snapshot, { createMatchPredicate, distanceToMatch, needMaskingText } from '../src/snapshot';
import { Mirror } from '../src/utils';

/** needMaskingText as it was before the fast path (upstream logic). */
function reference(
  node: Node,
  maskTextClass: string | RegExp,
  maskTextSelector: string | null,
  unmaskTextClass: string | RegExp | null,
  unmaskTextSelector: string | null,
  maskAllText: boolean,
): boolean {
  const el = (node.nodeType === 1 ? node : node.parentElement) as Element | null;
  if (!el) return false;
  if (node.nodeType === 1 && !el.childNodes.length) return false;
  if (maskAllText) {
    const un = distanceToMatch(el, createMatchPredicate(unmaskTextClass, unmaskTextSelector));
    if (un < 0) return true;
    const m = distanceToMatch(el, createMatchPredicate(maskTextClass, maskTextSelector), un);
    return m >= 0 ? m <= un : false;
  }
  const m = distanceToMatch(el, createMatchPredicate(maskTextClass, maskTextSelector));
  if (m < 0) return false;
  const un = distanceToMatch(el, createMatchPredicate(unmaskTextClass, unmaskTextSelector), m);
  return un >= 0 ? m <= un : true;
}

const doc = new JSDOM(`<!doctype html><body>
  <div id="a"><p>plain <b>bold</b></p>
    <section class="rr-mask"><p>masked <i>deep <u>deeper</u></i></p>
      <div class="rr-unmask"><p>unmasked inside masked</p></div></section>
    <article data-private><span>private <em>x</em></span></article>
    <div class="other"><span data-private="1">attr</span><span>sibling</span></div>
  </div></body>`).window.document;

const nodes: Node[] = [];
const walk = (n: Node) => {
  nodes.push(n);
  n.childNodes.forEach(walk);
};
walk(doc.body);

describe('needMaskingText closest() fast path (RR-018)', () => {
  const cases: Array<[string | RegExp, string | null, string | RegExp | null, string | null]> = [
    ['rr-mask', '[data-private]', null, null],
    ['rr-mask', null, 'rr-unmask', null],
    ['rr-mask', '[data-private]', 'rr-unmask', '.other'],
    ['', '[data-private]', null, null],
    ['', null, null, null],
    [/^rr-m/, '[data-private]', null, null],
  ];
  it.each(cases)('class %s selector %s: same answer for every node', (mc, ms, uc, us) => {
    for (const maskAll of [false, true]) {
      for (const n of nodes) {
        expect(needMaskingText(n, mc, ms, uc, us, maskAll), `${n.nodeName} ${n.textContent?.slice(0, 20)}`).toBe(
          reference(n, mc, ms, uc, us, maskAll),
        );
      }
    }
  });

  // privacy fix 4: one invalid user selector must not turn the mask class off
  it.each([
    ['rr-mask', '[data-private', null, null],
    ['rr-mask', 'div:::bad', 'rr-unmask', null],
    ['rr-mask', '[data-private]', 'rr-unmask', '.other[[['],
  ] as Array<[string, string, string | null, string | null]>)(
    'invalid selector %s / %s: masks exactly what the upstream walk masks (privacy fix 4)',
    (mc, ms, uc, us) => {
      let masked = 0;
      for (const maskAll of [false, true]) {
        for (const n of nodes) {
          const want = reference(n, mc, ms, uc, us, maskAll);
          if (want) masked++;
          expect(needMaskingText(n, mc, ms, uc, us, maskAll), `${n.nodeName} ${n.textContent?.slice(0, 20)}`).toBe(want);
        }
      }
      expect(masked).toBeGreaterThan(0);
    },
  );

  it('text in a .rr-mask region stays masked in a snapshot when maskTextSelector is invalid (privacy fix 4)', () => {
    const d = new JSDOM('<!doctype html><body><p class="rr-mask">card 4242</p><p>public</p></body>').window.document;
    const json = JSON.stringify(snapshot(d, { maskTextClass: 'rr-mask', maskTextSelector: 'p:::bad', mirror: new Mirror() }));
    expect(json).not.toContain('4242');
    expect(json).toContain('public');
  });
});
