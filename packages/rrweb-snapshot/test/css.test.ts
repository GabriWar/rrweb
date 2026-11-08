import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { parse, Rule, Media } from '../src/css';
import { addHoverClass, createCache } from '../src/rebuild';
import {
  fixSafariColons,
  escapeImportStatement,
  splitCssText,
  stringifyStylesheet,
} from './../src/utils';

describe('css parser', () => {
  it('should save the filename and source', () => {
    const css = 'booty {\n  size: large;\n}\n';
    const ast = parse(css, {
      source: 'booty.css',
    });

    expect(ast.stylesheet!.source).toEqual('booty.css');

    const position = ast.stylesheet!.rules[0].position!;
    expect(position.start).toBeTruthy();
    expect(position.end).toBeTruthy();
    expect(position.source).toEqual('booty.css');
    expect(position.content).toEqual(css);
  });

  it('should throw when a selector is missing', () => {
    expect(() => {
      parse('{size: large}');
    }).toThrow();

    expect(() => {
      parse('b { color: red; }\n{ color: green; }\na { color: blue; }');
    }).toThrow();
  });

  it('should throw when a broken comment is found', () => {
    expect(() => {
      parse('thing { color: red; } /* b { color: blue; }');
    }).toThrow();

    expect(() => {
      parse('/*');
    }).toThrow();

    /* Nested comments should be fine */
    expect(() => {
      parse('/* /* */');
    }).not.toThrow();
  });

  it('should allow empty property value', () => {
    expect(() => {
      parse('p { color:; }');
    }).not.toThrow();
  });

  it('should not throw with silent option', () => {
    expect(() => {
      parse('thing { color: red; } /* b { color: blue; }', { silent: true });
    }).not.toThrow();
  });

  it('should list the parsing errors and continue parsing', () => {
    const result = parse(
      'foo { color= red; } bar { color: blue; } baz {}} boo { display: none}',
      {
        silent: true,
        source: 'foo.css',
      },
    );

    const rules = result.stylesheet!.rules;
    expect(rules.length).toBeGreaterThan(2);

    const errors = result.stylesheet!.parsingErrors!;
    expect(errors.length).toEqual(2);

    expect(errors[0]).toHaveProperty('message');
    expect(errors[0]).toHaveProperty('reason');
    expect(errors[0]).toHaveProperty('filename');
    expect(errors[0]).toHaveProperty('line');
    expect(errors[0]).toHaveProperty('column');
    expect(errors[0]).toHaveProperty('source');
    expect(errors[0].filename).toEqual('foo.css');
  });

  it('should parse selector with comma nested inside ()', () => {
    const result = parse(
      '[_nghost-ng-c4172599085]:not(.fit-content).aim-select:hover:not(:disabled, [_nghost-ng-c4172599085]:not(.fit-content).aim-select--disabled, [_nghost-ng-c4172599085]:not(.fit-content).aim-select--invalid, [_nghost-ng-c4172599085]:not(.fit-content).aim-select--active) { border-color: rgb(84, 84, 84); }',
    );

    expect(result.parent).toEqual(null);

    const rules = result.stylesheet!.rules;
    expect(rules.length).toEqual(1);

    let rule = rules[0] as Rule;
    expect(rule.parent).toEqual(result);
    expect(rule.selectors?.length).toEqual(1);

    let decl = rule.declarations![0];
    expect(decl.parent).toEqual(rule);
  });

  it('should strip comments from selectors', () => {
    const cases: Array<[string, string[]]> = [
      ['.foo /* comment */, .bar { color: red; }', ['.foo', '.bar']],
      ['a /* x */ b, c /* y */ d { color: red; }', ['a  b', 'c  d']],
      ['.x /* trailing */ { color: red; }', ['.x']],
    ];
    for (const [css, expected] of cases) {
      const rules = parse(css).stylesheet!.rules.filter(
        (r): r is Rule => r.type === 'rule',
      );
      expect(rules[0].selectors?.map((s) => s.trim())).toEqual(expected);
    }
  });

  it('should not catastrophically backtrack on unterminated selector comments', () => {
    const evil = '/*' + '\n*'.repeat(40);
    const start = Date.now();
    expect(() =>
      parse(`${evil} { color: red; }`, { silent: true }),
    ).not.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
  });

  // TODO(sentry): our parser can't handle this atm
  it.skip('parses { and } in attribute selectors correctly', () => {
    const result = parse('foo[someAttr~="{someId}"] { color: red; }');
    const rules = result.stylesheet!.rules;

    expect(rules.length).toEqual(1);

    const rule = rules[0] as Rule;

    expect(rule.selectors![0]).toEqual('foo[someAttr~="{someId}"]');
  });

  it('should set parent property', () => {
    const result = parse(
      'thing { test: value; }\n' +
        '@media (min-width: 100px) { thing { test: value; } }',
    );

    expect(result.parent).toEqual(null);

    const rules = result.stylesheet!.rules;
    expect(rules.length).toEqual(2);

    let rule = rules[0] as Rule;
    expect(rule.parent).toEqual(result);
    expect(rule.declarations!.length).toEqual(1);

    let decl = rule.declarations![0];
    expect(decl.parent).toEqual(rule);

    const media = rules[1] as Media;
    expect(media.parent).toEqual(result);
    expect(media.rules!.length).toEqual(1);

    rule = media.rules![0] as Rule;
    expect(rule.parent).toEqual(media);

    expect(rule.declarations!.length).toEqual(1);
    decl = rule.declarations![0];
    expect(decl.parent).toEqual(rule);
  });

  it('parses : in attribute selectors correctly', () => {
    const out1 = fixSafariColons('[data-foo] { color: red; }');
    expect(out1).toEqual('[data-foo] { color: red; }');

    const out2 = fixSafariColons('[data-foo:other] { color: red; }');
    expect(out2).toEqual('[data-foo\\:other] { color: red; }');

    const out3 = fixSafariColons('[data-aa\\:other] { color: red; }');
    expect(out3).toEqual('[data-aa\\:other] { color: red; }');
  });

  it('parses nested commas in selectors correctly', () => {
    const result = parse(
      `
body > ul :is(li:not(:first-of-type) a:hover, li:not(:first-of-type).active a) {
  background: red;
}
`,
    );
    expect((result.stylesheet!.rules[0] as Rule)!.selectors!.length).toEqual(1);

    // TODO(sentry): our parser can't handle this atm
    //     const trickresult = parse(
    //       `
    // li[attr="weirdly("] a:hover, li[attr="weirdly)"] a {
    //   background-color: red;
    // }
    // `,
    //     );
    //     expect(
    //       (trickresult.stylesheet!.rules[0] as Rule)!.selectors!.length,
    //     ).toEqual(2);

    //     const weirderresult = parse(
    //       `
    // li[attr="weirder\\"("] a:hover, li[attr="weirder\\")"] a {
    //   background-color: red;
    // }
    // `,
    //     );
    //     expect(
    //       (weirderresult.stylesheet!.rules[0] as Rule)!.selectors!.length,
    //     ).toEqual(2);

    const commainstrresult = parse(
      `
li[attr="has,comma"] a:hover {
  background-color: red;
}
`,
    );
    expect(
      (commainstrresult.stylesheet!.rules[0] as Rule)!.selectors!.length,
    ).toEqual(1);
  });

  it.each([
    ['.foo,.bar {}', ['.foo', '.bar']],
    ['.bar:has(:disabled) {}', ['.bar:has(:disabled)']],
    ['.bar:has(input, button) {}', ['.bar:has(input, button)']],
    [
      '.bar:has(input:is(:disabled),button:has(:disabled)) {}',
      ['.bar:has(input:is(:disabled),button:has(:disabled))'],
    ],
    [
      '.bar:has(div, input:is(:disabled), button) {}',
      ['.bar:has(div,input:is(:disabled), button)'],
    ],
    [
      '.bar:has(div, input:is(:disabled),button:has(:disabled,.baz)) {}',
      ['.bar:has(div,input:is(:disabled),button:has(:disabled,.baz))'],
    ],
    [
      '.bar:has(input), .foo:has(input, button), .baz {}',
      ['.bar:has(input)', '.foo:has(input, button)', '.baz'],
    ],
    [
      '.bar:has(input:is(:disabled),button:has(:disabled,.baz), div:has(:disabled,.baz)){color: red;}',
      [
        '.bar:has(input:is(:disabled),button:has(:disabled,.baz),div:has(:disabled,.baz))',
      ],
    ],
    [
      '.bar:has(:has(:has(a), :has(:has(:has(b, :has(a), c), e))), input:is(:disabled), button) {}',
      [
        '.bar:has(:has(:has(a),:has(:has(:has(b,:has(a), c), e))),input:is(:disabled), button)',
      ],
    ],
    [
      '.foo,.bar:has(input:is(:disabled)){color: red;}',
      ['.foo', '.bar:has(input:is(:disabled))'],
    ],
    [
      '.foo,.bar:has(input:is(:disabled),button:has(:disabled,.baz)){color: red;}',
      ['.foo', '.bar:has(input:is(:disabled),button:has(:disabled,.baz))'],
    ],
    [
      '.foo,.bar:has(input:is(:disabled),button:has(:disabled), div:has(:disabled,.baz)){color: red;}',
      [
        '.foo',
        '.bar:has(input:is(:disabled),button:has(:disabled),div:has(:disabled,.baz))',
      ],
    ],
    [
      '.foo,.bar:has(input:is(:disabled),button:has(:disabled,.baz), div:has(:disabled,.baz)){color: red;}',
      [
        '.foo',
        '.bar:has(input:is(:disabled),button:has(:disabled,.baz),div:has(:disabled,.baz))',
      ],
    ],
    ['.bar:has(:disabled), .foo {}', ['.bar:has(:disabled)', '.foo']],
    [
      '.bar:has(input:is(:disabled),.foo,button:is(:disabled)), .foo {}',
      ['.bar:has(input:is(:disabled),.foo,button:is(:disabled))', '.foo'],
    ],
    [
      '.bar:has(input:is(:disabled),.foo,button:is(:disabled)), .foo:has(input, button), .baz,  {}',
      [
        '.bar:has(input:is(:disabled),.foo,button:is(:disabled))',
        '.foo:has(input, button)',
        '.baz',
      ],
    ],
  ])(
    'can parse selector(s) with functional pseudo classes: %s',
    (cssText, expected) => {
      expect(
        parse(
          cssText,
          // @ts-ignore
        ).stylesheet?.rules[0].selectors,
      ).toEqual(expected);
    },
  );

  it('parses imports with quotes correctly', () => {
    const out1 = escapeImportStatement({
      cssText: `@import url("/foo.css;900;800"");`,
      href: '/foo.css;900;800"',
      media: {
        length: 0,
      },
      layerName: null,
      supportsText: null,
    } as unknown as CSSImportRule);
    expect(out1).toEqual(`@import url("/foo.css;900;800\\"");`);

    const out2 = escapeImportStatement({
      cssText: `@import url("/foo.css;900;800"") supports(display: flex);`,
      href: '/foo.css;900;800"',
      media: {
        length: 0,
      },
      layerName: null,
      supportsText: 'display: flex',
    } as unknown as CSSImportRule);
    expect(out2).toEqual(
      `@import url("/foo.css;900;800\\"") supports(display: flex);`,
    );

    const out3 = escapeImportStatement({
      cssText: `@import url("/foo.css;900;800"");`,
      href: '/foo.css;900;800"',
      media: {
        length: 1,
        mediaText: 'print, screen',
      },
      layerName: null,
      supportsText: null,
    } as unknown as CSSImportRule);
    expect(out3).toEqual(`@import url("/foo.css;900;800\\"") print, screen;`);

    const out4 = escapeImportStatement({
      cssText: `@import url("/foo.css;900;800"") layer(layer-1);`,
      href: '/foo.css;900;800"',
      media: {
        length: 0,
      },
      layerName: 'layer-1',
      supportsText: null,
    } as unknown as CSSImportRule);
    expect(out4).toEqual(`@import url("/foo.css;900;800\\"") layer(layer-1);`);

    const out5 = escapeImportStatement({
      cssText: `@import url("/foo.css;900;800"") layer;`,
      href: '/foo.css;900;800"',
      media: {
        length: 0,
      },
      layerName: '',
      supportsText: null,
    } as unknown as CSSImportRule);
    expect(out5).toEqual(`@import url("/foo.css;900;800\\"") layer;`);
  });
});

// Upstream #1734 guard, on the fork's replay-side css adaptation
// (addHoverClass; the fork has no applyCssSplits/adaptCssForReplay).
describe('addHoverClass with unparseable css (#1734)', function () {
  it('falls back to the original text, byte for byte, instead of throwing', () => {
    const cssText = '.a { content: "unterminated }';
    const cache = createCache();
    let result = '';
    expect(() => {
      result = addHoverClass(cssText, cache);
    }).not.toThrow();
    expect(result).toBe(cssText);
  });
});

// Upstream rrweb splitter tests (splitCssText is shared with upstream).
describe('css splitter', () => {
  it('finds css textElement splits correctly', () => {
    const window = new Window({ url: 'https://localhost:8080' });
    const document = window.document;
    document.head.innerHTML = '<style>.a{background-color:red;}</style>';
    const style = document.querySelector('style');
    if (style) {
      // as authored, e.g. no spaces
      style.append('.a{background-color:black;}');

      // test how normalization finds the right sections
      style.append('.b      {background-color:black;}');
      style.append('.c{      background-color:                     black}');

      // how it is currently stringified (spaces present)
      const expected = [
        '.a { background-color: red; }',
        '.a { background-color: black; }',
        '.b { background-color: black; }',
        '.c { background-color: black; }',
      ];
      const browserSheet = expected.join('');
      expect(stringifyStylesheet(style.sheet!)).toEqual(browserSheet);

      expect(splitCssText(browserSheet, style)).toEqual(expected);
    }
  });

  it('finds css textElement splits correctly when comments are present', () => {
    const window = new Window({ url: 'https://localhost:8080' });
    const document = window.document;
    // as authored, with comment, missing semicolons
    document.head.innerHTML =
      '<style>.a{color:red}.b{color:blue} /* author comment */</style>';
    const style = document.querySelector('style');
    if (style) {
      style.append('/* author comment */.a{color:red}.b{color:green}');

      // how it is currently stringified (spaces present)
      const expected = [
        '.a { color: red; } .b { color: blue; }',
        '.a { color: red; } .b { color: green; }',
      ];
      const browserSheet = expected.join('');
      expect(splitCssText(browserSheet, style)).toEqual(expected);
    }
  });

  it('finds css textElement splits correctly with two identical text nodes', () => {
    const window = new Window({ url: 'https://localhost:8080' });
    const document = window.document;
    // as authored, with comment, missing semicolons
    const textContent = '.a { color:red; } .b { color:blue; }';
    document.head.innerHTML = '<style></style>';
    const style = document.querySelector('style');
    if (style) {
      style.append(textContent);
      style.append(textContent);

      const expected = [textContent, textContent];
      const browserSheet = expected.join('');
      expect(splitCssText(browserSheet, style)).toEqual(expected);

      style.append(textContent);
      const expected3 = [textContent, textContent, textContent];
      const browserSheet3 = expected3.join('');
      expect(splitCssText(browserSheet3, style)).toEqual(expected3);
    }
  });

  it('finds css textElement splits correctly when vendor prefixed rules have been removed', () => {
    const style = JSDOM.fragment(`<style></style>`).querySelector('style');
    if (style) {
      // as authored, with newlines
      style.appendChild(
        JSDOM.fragment(`.x {
  -webkit-transition: all 4s ease;
  content: 'try to keep a newline';
  transition: all 4s ease;
}`),
      );
      style.appendChild(
        JSDOM.fragment(`.y {
  -moz-transition: all 5s ease;
  transition: all 5s ease;
}`),
      );
      // browser .rules would usually omit the vendored versions and modifies the transition value
      const expected = [
        '.x { content: "try to keep a newline"; background: red; transition: 4s; }',
        '.y { transition: 5s; }',
      ];
      const browserSheet = expected.join('');

      // can't do this as JSDOM doesn't have style.sheet
      // also happy-dom doesn't strip out vendor-prefixed rules like a real browser does
      //expect(stringifyStylesheet(style.sheet!)).toEqual(browserSheet);

      expect(splitCssText(browserSheet, style)).toEqual(expected);
    }
  });

  it('efficiently finds split points in large files', () => {
    const cssText = fs.readFileSync(
      path.resolve(__dirname, './css/benchmark.css'),
      'utf8',
    );

    const parts = cssText.split('}');
    const sections = [];
    for (let i = 0; i < parts.length - 1; i++) {
      if (i % 100 === 0) {
        sections.push(parts[i] + '}');
      } else {
        sections[sections.length - 1] += parts[i] + '}';
      }
    }
    sections[sections.length - 1] += parts[parts.length - 1];

    expect(cssText.length).toEqual(sections.join('').length);

    const style = JSDOM.fragment(`<style></style>`).querySelector('style');
    if (style) {
      sections.forEach((section) => {
        style.appendChild(JSDOM.fragment(section));
      });
    }
    expect(splitCssText(cssText, style)).toEqual(sections);
  });

  it('finds css textElement splits correctly, with substring matching going from many to none', () => {
    const window = new Window({ url: 'https://localhost:8080' });
    const document = window.document;
    document.head.innerHTML = `<style>
.section-news-v3-detail .news-cnt-wrapper :where(p):not(:where([class~="not-prose"], [class~="not-prose"] *)) {
    margin-top: 0px;
    margin-bottom: 0px;
}

.section-news-v3-detail .news-cnt-wrapper .plugins-wrapper2 :where(figure):not(:where([class~="not-prose"],[class~="not-prose"] *)) {
    margin-top: 2em;
    margin-bottom: 2em;
}

.section-news-v3-detail .news-cnt-wrapper .plugins-wrapper2 :where(.prose > :first-child):not(:where([class~="not-prose"],[cl</style>`;
    const style = document.querySelector('style');
    if (style) {
      // happydom? bug avoid: strangely a greater than symbol in the template string below
      // e.g. '.prose > :last-child' causes more than one child to be appended
      style.append(`ass~="not-prose"] *)) {
    margin-top: 0;  /* cssRules transforms this to '0px' which was preventing matching prior to normalization */
}

.section-news-v3-detail .news-cnt-wrapper .plugins-wrapper2 :where(.prose :last-child):not(:where([class~="not-prose"],[class~="not-prose"] *)) {
    margin-bottom: 0;
}

.section-news-v3-detail .news-cnt-wrapper .plugins-wrapper2 {
    width: 100%;
    overflow-wrap: break-word;
}

.section-home {
    height: 100%;
    overflow-y: auto;
}
`);

      expect(style.childNodes.length).toEqual(2);

      const expected = [
        '.section-news-v3-detail .news-cnt-wrapper :where(p):not(:where([class~="not-prose"], [class~="not-prose"] *)) { margin-top: 0px; margin-bottom: 0px; }.section-news-v3-detail .news-cnt-wrapper .plugins-wrapper2 :where(figure):not(:where([class~="not-prose"],[class~="not-prose"] *)) { margin-top: 2em; margin-bottom: 2em; }.section-news-v3-detail .news-cnt-wrapper .plugins-wrapper2 :where(.prose > :first-child):not(:where([class~="not-prose"],[cl',
        'ass~="not-prose"] *)) { margin-top: 0px; }.section-news-v3-detail .news-cnt-wrapper .plugins-wrapper2 :where(.prose :last-child):not(:where([class~="not-prose"],[class~="not-prose"] *)) { margin-bottom: 0px; }.section-news-v3-detail .news-cnt-wrapper .plugins-wrapper2 { width: 100%; overflow-wrap: break-word; }.section-home { height: 100%; overflow-y: auto; }',
      ];
      const browserSheet = expected.join('');
      expect(stringifyStylesheet(style.sheet!)).toEqual(browserSheet);
      let _testNoPxNorm = true; // trigger the original motivating scenario for this test
      expect(splitCssText(browserSheet, style, _testNoPxNorm)).toEqual(
        expected,
      );
      _testNoPxNorm = false; // this case should also be solved by normalizing '0px' -> '0'
      expect(splitCssText(browserSheet, style, _testNoPxNorm)).toEqual(
        expected,
      );
    }
  });

  /*
   * `0px` (authored) always comes out in the rule as `0` so we decided at one point that
   * `normalizeCssString` should also do that transformation while it is stripping whitespace/comments.
   * This test exercises a case where this comes into play, however it is very contrived
   * (there are similar tests we could write which could exercise similar problems,
   * e.g. #FFF being serialized to rgb(255, 255, 255), and a split landing in just the
   * wrong place), so we could in future drop the '0px' normalization along with this test
   */
  it('finds a split point that lands on a `0` value, which requires 0px normalization', () => {
    const window = new Window({ url: 'https://localhost:8080' });
    const document = window.document;
    document.head.innerHTML =
      '<style>.aaaa { color: red; } .bbbb { margin: </style>';
    const style = document.querySelector('style');
    if (style) {
      style.append('0; } .cccc { top: 0; }');

      const expected = [
        '.aaaa { color: red; }.bbbb { margin: ',
        '0px; }.cccc { top: 0px; }',
      ];
      const browserSheet = expected.join('');
      expect(stringifyStylesheet(style.sheet!)).toEqual(browserSheet);

      let _testNoPxNorm = false;
      expect(splitCssText(browserSheet, style, _testNoPxNorm)).toEqual(
        expected,
      );

      _testNoPxNorm = true;
      expect(splitCssText(browserSheet, style, _testNoPxNorm)).toEqual([
        browserSheet,
      ]);
    }
  });

  it('finds css textElement splits correctly, even with repeated sections', () => {
    const window = new Window({ url: 'https://localhost:8080' });
    const document = window.document;
    document.head.innerHTML =
      '<style>.a{background-color: black; }        </style>';
    const style = document.querySelector('style');
    if (style) {
      style.append('.x{background-color:red;}');
      style.append('.b      {background-color:black;}');
      style.append('.x{background-color:red;}');
      style.append('.c{      background-color:                     black}');

      const expected = [
        '.a { background-color: black; }',
        '.x { background-color: red; }',
        '.b { background-color: black; }',
        '.x { background-color: red; }',
        '.c { background-color: black; }',
      ];
      const browserSheet = expected.join('');
      expect(stringifyStylesheet(style.sheet!)).toEqual(browserSheet);

      expect(splitCssText(browserSheet, style)).toEqual(expected);
    }
  });
});
