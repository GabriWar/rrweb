/**
 * @vitest-environment jsdom
 */
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import rebuild, {
  // adaptCssForReplay,
  addHoverClass,
  buildNodeWithSN,
  createCache,
  createSandboxedIframe,
  rebuildIntoSandboxedIframe,
} from '../src/rebuild';
import { NodeType } from '@rrweb/types';
import { createMirror, Mirror } from '../src/utils';

function getDuration(hrtime: [number, number]) {
  const [seconds, nanoseconds] = hrtime;
  return seconds * 1000 + nanoseconds / 1000000;
}

describe('rebuild', function () {
  let cache: ReturnType<typeof createCache>;
  let mirror: Mirror;

  beforeEach(() => {
    mirror = createMirror();
    cache = createCache();
  });

  const simpleSnapshot = {
    id: 1,
    type: NodeType.Document,
    childNodes: [
      {
        id: 2,
        type: NodeType.Element,
        tagName: 'html',
        attributes: {},
        childNodes: [
          {
            id: 3,
            type: NodeType.Element,
            tagName: 'body',
            attributes: {},
            childNodes: [],
          },
        ],
      },
    ],
  } as const;

  function setIframeSandbox(iframe: HTMLIFrameElement, sandbox: string): void {
    const tokens = sandbox.trim().split(/\s+/).filter(Boolean);
    iframe.setAttribute('sandbox', sandbox);
    Object.defineProperty(iframe, 'sandbox', {
      configurable: true,
      value: {
        length: tokens.length,
        contains: (token: string) => tokens.includes(token),
        item: (index: number) => tokens[index] ?? null,
        toString: () => sandbox,
        [Symbol.iterator]: () => tokens[Symbol.iterator](),
      },
    });
  }

  function mockCreatedIframeSandboxDomApi(
    onIframe?: (iframe: HTMLIFrameElement) => void,
  ): () => void {
    const createElement = document.createElement.bind(document);
    const getTokens = (iframe: HTMLIFrameElement) =>
      (iframe.getAttribute('sandbox') || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      const element = createElement(tagName, options);
      if (tagName.toLowerCase() === 'iframe') {
        const iframe = element as HTMLIFrameElement;
        Object.defineProperty(iframe, 'sandbox', {
          configurable: true,
          value: {
            get length() {
              return getTokens(iframe).length;
            },
            contains: (token: string) => getTokens(iframe).includes(token),
            item: (index: number) => getTokens(iframe)[index] ?? null,
            toString: () => iframe.getAttribute('sandbox') || '',
            [Symbol.iterator]: () => getTokens(iframe)[Symbol.iterator](),
          },
        });
        onIframe?.(iframe);
      }
      return element;
    }) as typeof document.createElement);

    return () => spy.mockRestore();
  }

  describe('browser rebuild target guard', () => {
    it('throws when rebuilding into the top-level browser document', () => {
      expect(() =>
        rebuild(simpleSnapshot, {
          doc: document,
          cache,
          mirror,
        }),
      ).toThrow(
        'rrweb-snapshot.rebuild() cannot rebuild into an unprotected browser document',
      );
    });

    it('throws for caller-supplied iframe documents even with exactly allow-same-origin sandbox', () => {
      const iframe = document.createElement('iframe');
      setIframeSandbox(iframe, 'allow-same-origin');
      document.body.appendChild(iframe);

      expect(() =>
        rebuild(simpleSnapshot, {
          doc: iframe.contentDocument!,
          cache,
          mirror,
        }),
      ).toThrow(
        'rrweb-snapshot.rebuild() cannot rebuild into an unprotected browser document',
      );

      iframe.remove();
    });

    it('allows rebuilding into an iframe document created by createSandboxedIframe', () => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      const restoreCreateElement = mockCreatedIframeSandboxDomApi();

      try {
        const iframe = createSandboxedIframe({
          root,
        });

        const node = rebuild(simpleSnapshot, {
          doc: iframe.contentDocument!,
          cache,
          mirror,
        });

        expect(root.contains(iframe)).toBe(true);
        expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
        expect(node).toBe(iframe.contentDocument);
      } finally {
        restoreCreateElement();
        root.remove();
      }
    });

    it('throws for sandbox policies other than exactly allow-same-origin', () => {
      for (const sandbox of [
        '',
        'allow-scripts',
        'allow-same-origin allow-scripts',
        'allow-same-origin allow-forms',
      ]) {
        const root = document.createElement('div');
        document.body.appendChild(root);
        const restoreCreateElement = mockCreatedIframeSandboxDomApi();

        try {
          const iframe = createSandboxedIframe({
            root,
          });
          setIframeSandbox(iframe, sandbox);

          expect(() =>
            rebuild(simpleSnapshot, {
              doc: iframe.contentDocument!,
              cache: createCache(),
              mirror: createMirror(),
            }),
          ).toThrow(
            'rrweb-snapshot.rebuild() cannot rebuild into an unprotected browser document',
          );
        } finally {
          restoreCreateElement();
          root.remove();
        }
      }
    });

    it('throws when only a raw sandbox attribute is present without the sandbox DOM API', () => {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-same-origin');

      const iframePrototype = Object.getPrototypeOf(iframe);
      const sandboxDescriptor = Object.getOwnPropertyDescriptor(
        iframePrototype,
        'sandbox',
      );
      if (sandboxDescriptor) {
        delete iframePrototype.sandbox;
      }

      try {
        expect('sandbox' in iframe).toBe(false);
        document.body.appendChild(iframe);

        expect(() =>
          rebuild(simpleSnapshot, {
            doc: iframe.contentDocument!,
            cache: createCache(),
            mirror: createMirror(),
          }),
        ).toThrow(
          'rrweb-snapshot.rebuild() cannot rebuild into an unprotected browser document',
        );
      } finally {
        iframe.remove();
        if (sandboxDescriptor) {
          Object.defineProperty(iframePrototype, 'sandbox', sandboxDescriptor);
        }
      }
    });

    it('allows an unprotected rebuild when the caller explicitly opts out', () => {
      const node = rebuild(simpleSnapshot, {
        doc: document,
        cache,
        mirror,
        UNSAFE_allowUnprotectedRebuild: true,
      });

      expect(node).toBe(document);
    });

    it('allows rebuilding into a document without a defaultView', () => {
      const detachedDocument = document.implementation.createDocument(
        null,
        '',
        null,
      );

      expect(detachedDocument.defaultView).toBeNull();

      const node = rebuild(
        {
          id: 4,
          type: NodeType.Element,
          tagName: 'div',
          attributes: {},
          childNodes: [],
        },
        {
          doc: detachedDocument,
          cache,
          mirror,
        },
      );

      expect(node).toBeInstanceOf(Element);
      expect(node?.ownerDocument).toBe(detachedDocument);
    });

    it('rebuildIntoSandboxedIframe creates a fresh sandboxed iframe in the required root', () => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      const restoreCreateElement = mockCreatedIframeSandboxDomApi();

      try {
        const { iframe, node } = rebuildIntoSandboxedIframe(simpleSnapshot, {
          root,
          cache,
          mirror,
        });

        expect(root.contains(iframe)).toBe(true);
        expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
        expect(node).toBe(iframe.contentDocument);
        expect(iframe.contentDocument!.querySelector('body')).not.toBeNull();
      } finally {
        restoreCreateElement();
        root.remove();
      }
    });

    it('rebuildIntoSandboxedIframe does not allow callers to override sandbox', () => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      const restoreCreateElement = mockCreatedIframeSandboxDomApi();

      try {
        const { iframe } = rebuildIntoSandboxedIframe(simpleSnapshot, {
          root,
          cache,
          mirror,
          iframeAttributes: {
            sandbox: 'allow-same-origin allow-scripts',
            title: 'Replay',
          } as Record<string, string>,
        });

        expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
        expect(iframe.getAttribute('title')).toBe('Replay');
      } finally {
        restoreCreateElement();
        root.remove();
      }
    });

    it('rebuildIntoSandboxedIframe removes the iframe when rebuild throws', () => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      let createdIframe: HTMLIFrameElement | undefined;
      const restoreCreateElement = mockCreatedIframeSandboxDomApi((iframe) => {
        document.body.appendChild(iframe);
        createdIframe = iframe;
      });

      try {
        expect(() =>
          rebuildIntoSandboxedIframe(simpleSnapshot, {
            root,
            cache,
            mirror,
            afterAppend: () => {
              throw new Error('after append failed');
            },
          }),
        ).toThrow('after append failed');

        expect(createdIframe).toBeDefined();
        expect(root.contains(createdIframe!)).toBe(false);
      } finally {
        restoreCreateElement();
        root.remove();
      }
    });

    it('createSandboxedIframe rejects a detached root without appending an iframe', () => {
      const root = document.createElement('div');

      expect(() =>
        createSandboxedIframe({
          root,
        }),
      ).toThrow('root to be connected to a document');

      expect(root.querySelector('iframe')).toBeNull();
    });

    it('rebuildIntoSandboxedIframe rejects a detached root without appending an iframe', () => {
      const root = document.createElement('div');

      expect(() =>
        rebuildIntoSandboxedIframe(simpleSnapshot, {
          root,
          cache,
          mirror,
        }),
      ).toThrow('root to be connected to a document');

      expect(root.querySelector('iframe')).toBeNull();
    });
  });

  describe('rr_dataURL', function () {
    it('should rebuild dataURL', function () {
      const dataURI =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const node = buildNodeWithSN(
        {
          id: 1,
          tagName: 'img',
          type: NodeType.Element,
          attributes: {
            rr_dataURL: dataURI,
            src: 'http://example.com/image.png',
          },
          childNodes: [],
        },
        {
          doc: document,
          mirror,
          hackCss: false,
          cache,
        },
      ) as HTMLImageElement;
      expect(node?.src).toBe(dataURI);
    });
  });

  describe('rr_width/rr_height', function () {
    it('rebuild blocked element with correct dimensions', function () {
      const node = buildNodeWithSN(
        {
          id: 1,
          tagName: 'svg',
          type: NodeType.Element,
          isSVG: true,
          attributes: {
            rr_width: '50px',
            rr_height: '50px',
          },
          childNodes: [],
        },
        {
          doc: document,
          mirror,
          hackCss: false,
          cache,
        },
      ) as HTMLDivElement;
      expect(node.style.width).toBe('50px');
      expect(node.style.height).toBe('50px');
    });
  });

  describe('shadowDom', function () {
    it('rebuild shadowRoot without siblings', function () {
      const node = buildNodeWithSN(
        {
          id: 1,
          tagName: 'div',
          type: NodeType.Element,
          attributes: {},
          childNodes: [
            {
              id: 2,
              tagName: 'div',
              type: NodeType.Element,
              attributes: {},
              childNodes: [],
              isShadow: true,
            },
          ],
          isShadowHost: true,
        },
        {
          doc: document,
          mirror,
          hackCss: false,
          cache,
        },
      ) as HTMLDivElement;
      expect(node.shadowRoot?.childNodes.length).toBe(1);
    });
  });

  describe('add hover class to hover selector related rules', function () {
    it('will do nothing to css text without :hover', () => {
      const cssText = 'body { color: white }';
      expect(addHoverClass(cssText, cache)).toEqual(cssText);
    });

    it('can add hover class to css text', () => {
      const cssText = '.a:hover { color: white }';
      expect(addHoverClass(cssText, cache)).toEqual(
        '.a:hover, .a.\\:hover { color: white }',
      );
    });

    it('can add hover class when there is multi selector', () => {
      const cssText = '.a, .b:hover, .c { color: white }';
      expect(addHoverClass(cssText, cache)).toEqual(
        '.a, .b:hover, .b.\\:hover, .c { color: white }',
      );
    });

    it('can add hover class when there is a multi selector with the same prefix', () => {
      const cssText = '.a:hover, .a:hover::after { color: white }';
      expect(addHoverClass(cssText, cache)).toEqual(
        '.a:hover, .a.\\:hover, .a:hover::after, .a.\\:hover::after { color: white }',
      );
    });

    it('can add hover class when :hover is not the end of selector', () => {
      const cssText = 'div:hover::after { color: white }';
      expect(addHoverClass(cssText, cache)).toEqual(
        'div:hover::after, div.\\:hover::after { color: white }',
      );
    });

    it('can add hover class when the selector has multi :hover', () => {
      const cssText = 'a:hover b:hover { color: white }';
      expect(addHoverClass(cssText, cache)).toEqual(
        'a:hover b:hover, a.\\:hover b.\\:hover { color: white }',
      );
    });

    it('will ignore :hover in css value', () => {
      const cssText = '.a::after { content: ":hover" }';
      expect(addHoverClass(cssText, cache)).toEqual(cssText);
    });

    // this benchmark is unreliable when run in parallel with other tests
    it.skip('benchmark', () => {
      const cssText = fs.readFileSync(
        path.resolve(__dirname, './css/benchmark.css'),
        'utf8',
      );
      const start = process.hrtime();
      addHoverClass(cssText, cache);
      const end = process.hrtime(start);
      const duration = getDuration(end);
      expect(duration).toBeLessThan(100);
    });

    it('should be a lot faster to add a hover class to a previously processed css string', () => {
      const factor = 100;

      let cssText = fs.readFileSync(
        path.resolve(__dirname, './css/benchmark.css'),
        'utf8',
      );

      const start = process.hrtime();
      addHoverClass(cssText, cache);
      const end = process.hrtime(start);

      const cachedStart = process.hrtime();
      addHoverClass(cssText, cache);
      const cachedEnd = process.hrtime(cachedStart);

      expect(getDuration(cachedEnd) * factor).toBeLessThan(getDuration(end));
    });
  });

  describe('isCustom elements', function () {
    it('should not throw when rebuilding custom element without hyphen (e.g. webview)', function () {
      // Elements like Electron's <webview> are registered as custom elements
      // but their names don't contain a hyphen, which makes them invalid for
      // customElements.define(). We should handle this gracefully via try/catch.
      expect(() => {
        buildNodeWithSN(
          {
            id: 1,
            tagName: 'webview',
            type: NodeType.Element,
            attributes: {},
            childNodes: [],
            isCustom: true,
          },
          {
            doc: document,
            mirror,
            hackCss: false,
            cache,
          },
        );
      }).not.toThrow();
    });

    it('should define a custom element with a valid hyphenated name', function () {
      const node = buildNodeWithSN(
        {
          id: 1,
          tagName: 'my-component',
          type: NodeType.Element,
          attributes: {},
          childNodes: [],
          isCustom: true,
        },
        {
          doc: document,
          mirror,
          hackCss: false,
          cache,
        },
      ) as HTMLElement;
      expect(node).toBeTruthy();
      expect(node.tagName.toLowerCase()).toBe('my-component');
    });
  });

  // sentry: skipped because we've removed `adaptCssForReplay` for now
  // it('should not incorrectly interpret escaped quotes', () => {
  //   // the ':hover' in the below is a decoy which is not part of the selector,
  //   // previously that part was being incorrectly consumed by the selector regex
  //   const should_not_modify =
  //     ".tailwind :is(.before\\:content-\\[\\'\\'\\])::before { --tw-content: \":hover\"; content: var(--tw-content); }.tailwind :is(.\\[\\&\\>li\\]\\:before\\:content-\\[\\'-\\'\\] > li)::before { color: pink; }";
  //   expect(adaptCssForReplay(should_not_modify, cache)).toEqual(
  //     should_not_modify,
  //   );
  // });

  // sentry: skipped because we've removed `adaptCssForReplay` for now
  // it('should not incorrectly interpret at rules', () => {
  //   // the ':hover' in the below is a decoy which is not part of the selector,
  //   const should_not_modify =
  //     '@import url("https://fonts.googleapis.com/css2?family=Rubik:ital,wght@0,400;0,500;0,700;1,400&display=:hover");';
  //   expect(adaptCssForReplay(should_not_modify, cache)).toEqual(
  //     should_not_modify,
  //   );
  // });
});
