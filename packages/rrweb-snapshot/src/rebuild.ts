import { parse } from './css';
import type { tagMap, BuildCache } from './types';
import {
  serializedNodeWithId,
  NodeType,
  elementNode,
  legacyAttributes,
} from '@rrweb/types';
import {
  isElement,
  Mirror,
  isNodeMetaEqual,
  extractFileExtension,
} from './utils';

const tagMap: tagMap = {
  script: 'noscript',
  // camel case svg element tag names
  altglyph: 'altGlyph',
  altglyphdef: 'altGlyphDef',
  altglyphitem: 'altGlyphItem',
  animatecolor: 'animateColor',
  animatemotion: 'animateMotion',
  animatetransform: 'animateTransform',
  clippath: 'clipPath',
  feblend: 'feBlend',
  fecolormatrix: 'feColorMatrix',
  fecomponenttransfer: 'feComponentTransfer',
  fecomposite: 'feComposite',
  feconvolvematrix: 'feConvolveMatrix',
  fediffuselighting: 'feDiffuseLighting',
  fedisplacementmap: 'feDisplacementMap',
  fedistantlight: 'feDistantLight',
  fedropshadow: 'feDropShadow',
  feflood: 'feFlood',
  fefunca: 'feFuncA',
  fefuncb: 'feFuncB',
  fefuncg: 'feFuncG',
  fefuncr: 'feFuncR',
  fegaussianblur: 'feGaussianBlur',
  feimage: 'feImage',
  femerge: 'feMerge',
  femergenode: 'feMergeNode',
  femorphology: 'feMorphology',
  feoffset: 'feOffset',
  fepointlight: 'fePointLight',
  fespecularlighting: 'feSpecularLighting',
  fespotlight: 'feSpotLight',
  fetile: 'feTile',
  feturbulence: 'feTurbulence',
  foreignobject: 'foreignObject',
  glyphref: 'glyphRef',
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
};
function getTagName(n: elementNode): string {
  let tagName = tagMap[n.tagName] ? tagMap[n.tagName] : n.tagName;
  if (tagName === 'link' && n.attributes._cssText) {
    tagName = 'style';
  }
  return tagName;
}

// based on https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

const HOVER_SELECTOR = /([^\\]):hover/;
const HOVER_SELECTOR_GLOBAL = new RegExp(HOVER_SELECTOR.source, 'g');
export function addHoverClass(cssText: string, cache: BuildCache): string {
  const cachedStyle = cache?.stylesWithHoverClass.get(cssText);
  if (cachedStyle) return cachedStyle;

  if (cssText.length >= 1_000_000) {
    // Skip adding hover class for large stylesheets, otherwise we will run
    // into perf issues that will block main thread
    return cssText;
  }

  const ast = parse(cssText, {
    silent: true,
  });

  if (!ast.stylesheet) {
    return cssText;
  }

  const selectors: string[] = [];
  ast.stylesheet.rules.forEach((rule) => {
    if ('selectors' in rule) {
      (rule.selectors || []).forEach((selector: string) => {
        if (HOVER_SELECTOR.test(selector)) {
          selectors.push(selector);
        }
      });
    }
  });

  if (selectors.length === 0) {
    return cssText;
  }

  const selectorMatcher = new RegExp(
    selectors
      .filter((selector, index) => selectors.indexOf(selector) === index)
      .sort((a, b) => b.length - a.length)
      .map((selector) => {
        return escapeRegExp(selector);
      })
      .join('|'),
    'g',
  );

  const result = cssText.replace(selectorMatcher, (selector) => {
    const newSelector = selector.replace(HOVER_SELECTOR_GLOBAL, '$1.\\:hover');
    return `${selector}, ${newSelector}`;
  });
  cache?.stylesWithHoverClass.set(cssText, result);
  return result;
}

export function createCache(): BuildCache {
  const stylesWithHoverClass: Map<string, string> = new Map();
  return {
    stylesWithHoverClass,
  };
}

const REBUILD_TARGET_ERROR =
  'rrweb-snapshot.rebuild() cannot rebuild into an unprotected browser document. Use rebuildIntoSandboxedIframe() or set UNSAFE_allowUnprotectedRebuild: true only when you accept the script-execution risk.';
const SANDBOXED_IFRAME_ROOT_ERROR =
  'rrweb-snapshot.createSandboxedIframe() requires root to be connected to a document before creating a sandboxed iframe.';

const sandboxedRebuildDocuments = new WeakSet<Document>();

/**
 * Options used to rebuild a serialized snapshot into a live document.
 *
 * Browser rebuilds are protected by default. Use
 * `rebuildIntoSandboxedIframe()` or `createSandboxedIframe()` when replaying
 * untrusted data.
 */
type RebuildOptions = {
  /** Target document that receives the rebuilt nodes. */
  doc: Document;
  /** Called after each rebuilt node is created and before it may be appended. */
  onVisit?: (node: Node) => unknown;
  /** Adapts CSS selectors for replay-specific hover behavior when enabled. */
  hackCss?: boolean;
  /** Called after a rebuilt node is appended to its parent. */
  afterAppend?: (n: Node, id: number) => unknown;
  /** Per-rebuild cache for derived snapshot data. */
  cache: BuildCache;
  /** Mirror used to associate serialized node ids with rebuilt nodes. */
  mirror: Mirror;
  /**
   * Explicit unsafe opt-out from protected browser rebuild checks.
   *
   * Setting this to `true` allows rebuilding directly into an unprotected
   * browser document and can execute scripts from replay data.
   */
  UNSAFE_allowUnprotectedRebuild?: boolean;
};

/**
 * Options for creating a sandboxed iframe that is safe for snapshot rebuilds.
 *
 * The `root` element must already be connected to a document so the iframe can
 * create a live `contentDocument`. The helper always sets `sandbox` to exactly
 * `allow-same-origin`; any caller-provided `sandbox` attribute is ignored.
 */
type CreateSandboxedIframeOptions = {
  /** Connected element that receives the created iframe. */
  root: Element;
  /**
   * Attributes to apply to the iframe before insertion.
   *
   * `sandbox` is intentionally excluded and ignored at runtime because this
   * helper must force the sandbox policy required by protected rebuilds.
   */
  iframeAttributes?: Record<string, string> & { sandbox?: never };
};

/**
 * Options for rebuilding a serialized snapshot into a new sandboxed iframe.
 *
 * Inherits the iframe creation options and the standard rebuild callbacks and
 * cache options, while choosing the target document internally from the created
 * iframe. Use this helper for untrusted replay data.
 */
type RebuildIntoSandboxedIframeOptions = CreateSandboxedIframeOptions &
  Omit<RebuildOptions, 'doc' | 'UNSAFE_allowUnprotectedRebuild'>;

function isSupportedSandboxedIframe(
  frameElement: Element | null,
): frameElement is HTMLIFrameElement {
  if (!frameElement || frameElement.tagName !== 'IFRAME') {
    return false;
  }

  if (!('sandbox' in frameElement)) {
    return false;
  }

  const sandboxTokens = Array.from((frameElement as HTMLIFrameElement).sandbox);

  return sandboxTokens.length === 1 && sandboxTokens[0] === 'allow-same-origin';
}

function assertRebuildTargetAllowed(options: RebuildOptions): void {
  if (options.UNSAFE_allowUnprotectedRebuild) {
    return;
  }

  const win = options.doc.defaultView;
  if (!win) {
    return;
  }

  if (
    sandboxedRebuildDocuments.has(options.doc) &&
    isSupportedSandboxedIframe(win.frameElement)
  ) {
    return;
  }

  throw new Error(REBUILD_TARGET_ERROR);
}

function buildNode(
  n: serializedNodeWithId,
  options: {
    doc: Document;
    hackCss: boolean;
    cache: BuildCache;
  },
): Node | null {
  const { doc, hackCss, cache } = options;
  switch (n.type) {
    case NodeType.Document:
      return doc.implementation.createDocument(null, '', null);
    case NodeType.DocumentType:
      return doc.implementation.createDocumentType(
        n.name || 'html',
        n.publicId,
        n.systemId,
      );
    case NodeType.Element: {
      const tagName = getTagName(n);
      let node: Element;
      if (n.isSVG) {
        node = doc.createElementNS('http://www.w3.org/2000/svg', tagName);
      } else {
        if (
          // If the tag name is a custom element name
          n.isCustom &&
          // If the browser supports custom elements
          doc.defaultView?.customElements &&
          // If the custom element hasn't been defined yet
          !doc.defaultView.customElements.get(n.tagName)
        )
          try {
            doc.defaultView.customElements.define(
              n.tagName,
              class extends doc.defaultView.HTMLElement {},
            );
          } catch (e) {
            console.warn('Cannot define custom element', e);
            // Some elements (e.g. Electron's <webview>) are registered as custom
            // elements but have names that are not valid for customElements.define()
            // (missing hyphen). Silently ignore — the element will be created as
            // an HTMLUnknownElement instead.
          }
        node = doc.createElement(tagName);
      }
      /**
       * Attribute names start with `rr_` are internal attributes added by rrweb.
       * They often overwrite other attributes on the element.
       * We need to parse them last so they can overwrite conflicting attributes.
       */
      const specialAttributes: { [key: string]: string | number } = {};
      for (const name in n.attributes) {
        if (!Object.prototype.hasOwnProperty.call(n.attributes, name)) {
          continue;
        }
        let value = n.attributes[name];
        if (
          tagName === 'option' &&
          name === 'selected' &&
          (value as legacyAttributes[typeof name]) === false
        ) {
          // legacy fix (TODO: if `value === false` can be generated for other attrs,
          // should we also omit those other attrs from build ?)
          continue;
        }

        // null values mean the attribute was removed
        if (value === null) {
          continue;
        }

        /**
         * Boolean attributes are considered to be true if they're present on the element at all.
         * We should set value to the empty string ("") or the attribute's name, with no leading or trailing whitespace.
         * @see https://developer.mozilla.org/en-US/docs/Web/API/Element/setAttribute#parameters
         */
        if (value === true) value = '';

        if (name.startsWith('rr_')) {
          specialAttributes[name] = value;
          continue;
        }

        const isTextarea = tagName === 'textarea' && name === 'value';
        const isRemoteOrDynamicCss = tagName === 'style' && name === '_cssText';
        if (isRemoteOrDynamicCss && hackCss && typeof value === 'string') {
          value = addHoverClass(value, cache);
        }
        if ((isTextarea || isRemoteOrDynamicCss) && typeof value === 'string') {
          const child = doc.createTextNode(value);
          // https://github.com/rrweb-io/rrweb/issues/112
          for (const c of Array.from(node.childNodes)) {
            if (c.nodeType === node.TEXT_NODE) {
              node.removeChild(c);
            }
          }
          node.appendChild(child);
          continue;
        }

        try {
          if (n.isSVG && name === 'xlink:href') {
            node.setAttributeNS(
              'http://www.w3.org/1999/xlink',
              name,
              value.toString(),
            );
          } else if (
            name === 'onload' ||
            name === 'onclick' ||
            name.substring(0, 7) === 'onmouse'
          ) {
            // Rename some of the more common atttributes from https://www.w3schools.com/tags/ref_eventattributes.asp
            // as setting them triggers a console.error (which shows up despite the try/catch)
            // Assumption: these attributes are not used to css
            node.setAttribute('_' + name, value.toString());
          } else if (
            tagName === 'meta' &&
            n.attributes['http-equiv'] === 'Content-Security-Policy' &&
            name === 'content'
          ) {
            // If CSP contains style-src and inline-style is disabled, there will be an error "Refused to apply inline style because it violates the following Content Security Policy directive: style-src '*'".
            // And the function insertStyleRules in rrweb replayer will throw an error "Uncaught TypeError: Cannot read property 'insertRule' of null".
            node.setAttribute('csp-content', value.toString());
            continue;
          } else if (
            tagName === 'link' &&
            (n.attributes.rel === 'preload' ||
              n.attributes.rel === 'modulepreload')
          ) {
            // ignore
          } else if (
            tagName === 'link' &&
            n.attributes.rel === 'prefetch' &&
            typeof n.attributes.href === 'string' &&
            extractFileExtension(n.attributes.href) === 'js'
          ) {
            // ignore
          } else if (
            tagName === 'img' &&
            n.attributes.srcset &&
            n.attributes.rr_dataURL
          ) {
            // backup original img srcset
            node.setAttribute(
              'rrweb-original-srcset',
              n.attributes.srcset as string,
            );
          } else {
            node.setAttribute(name, value.toString());
          }
        } catch (error) {
          // skip invalid attribute
        }
      }

      for (const name in specialAttributes) {
        const value = specialAttributes[name];
        // handle internal attributes
        if (tagName === 'canvas' && name === 'rr_dataURL') {
          const image = doc.createElement('img');
          image.onload = () => {
            const ctx = (node as HTMLCanvasElement).getContext('2d');
            if (ctx) {
              ctx.drawImage(image, 0, 0, image.width, image.height);
            }
          };
          image.src = value.toString();
          type RRCanvasElement = {
            RRNodeType: NodeType;
            rr_dataURL: string;
          };
          // If the canvas element is created in RRDom runtime (seeking to a time point), the canvas context isn't supported. So the data has to be stored and not handled until diff process. https://github.com/rrweb-io/rrweb/pull/944
          if ((node as unknown as RRCanvasElement).RRNodeType)
            (node as unknown as RRCanvasElement).rr_dataURL = value.toString();
        } else if (tagName === 'img' && name === 'rr_dataURL') {
          const image = node as HTMLImageElement;
          if (!image.currentSrc.startsWith('data:')) {
            // Backup original img src. It may not have been set yet.
            image.setAttribute(
              'rrweb-original-src',
              n.attributes.src as string,
            );
            image.src = value.toString();
          }
        }

        if (name === 'rr_width') {
          (node as HTMLElement).style.setProperty('width', value.toString());
        } else if (name === 'rr_height') {
          (node as HTMLElement).style.setProperty('height', value.toString());
        } else if (
          name === 'rr_mediaCurrentTime' &&
          typeof value === 'number'
        ) {
          (node as HTMLMediaElement).currentTime = value;
        } else if (name === 'rr_mediaState') {
          switch (value) {
            case 'played':
              (node as HTMLMediaElement)
                .play()
                .catch((e) => console.warn('media playback error', e));
              break;
            case 'paused':
              (node as HTMLMediaElement).pause();
              break;
            default:
          }
        }
      }

      if (n.isShadowHost) {
        /**
         * Since node is newly rebuilt, it should be a normal element
         * without shadowRoot.
         * But if there are some weird situations that has defined
         * custom element in the scope before we rebuild node, it may
         * register the shadowRoot earlier.
         * The logic in the 'else' block is just a try-my-best solution
         * for the corner case, please let we know if it is wrong and
         * we can remove it.
         */
        if (!node.shadowRoot) {
          node.attachShadow({ mode: 'open' });
        } else {
          while (node.shadowRoot.firstChild) {
            node.shadowRoot.removeChild(node.shadowRoot.firstChild);
          }
        }
      }
      // Disable autocomplete on input fields to prevent the viewer's
      // personal data from appearing during replay
      if (tagName === 'input' || tagName === 'textarea') {
        node.setAttribute('autocomplete', 'off');
      }
      return node;
    }
    case NodeType.Text:
      return doc.createTextNode(
        n.isStyle && hackCss
          ? addHoverClass(n.textContent, cache)
          : n.textContent,
      );
    case NodeType.CDATA:
      // `createCDATASection` only works for XML documents (not HTML)
      // https://developer.mozilla.org/en-US/docs/Web/API/Document/createCDATASection#notes
      if (!(doc instanceof XMLDocument)) {
        return null;
      }

      return doc.createCDATASection(n.textContent);
    case NodeType.Comment:
      return doc.createComment(n.textContent);
    default:
      return null;
  }
}

export function buildNodeWithSN(
  n: serializedNodeWithId,
  options: {
    doc: Document;
    mirror: Mirror;
    skipChild?: boolean;
    hackCss: boolean;
    /**
     * This callback will be called for each of this nodes' `.childNodes` after they are appended to _this_ node.
     * Caveat: This callback _doesn't_ get called when this node is appended to the DOM.
     */
    afterAppend?: (n: Node, id: number) => unknown;
    cache: BuildCache;
  },
): Node | null {
  const {
    doc,
    mirror,
    skipChild = false,
    hackCss = true,
    afterAppend,
    cache,
  } = options;
  /**
   * Add a check to see if the node is already in the mirror. If it is, we can skip the whole process.
   * This situation (duplicated nodes) can happen when recorder has some unfixed bugs and the same node is recorded twice. Or something goes wrong when saving or transferring event data.
   * Duplicated node creation may cause unexpected errors in replayer. This check tries best effort to prevent the errors.
   */
  if (mirror.has(n.id)) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const nodeInMirror = mirror.getNode(n.id)!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const meta = mirror.getMeta(nodeInMirror)!;
    // For safety concern, check if the node in mirror is the same as the node we are trying to build
    if (isNodeMetaEqual(meta, n)) return mirror.getNode(n.id);
  }
  let node = buildNode(n, { doc, hackCss, cache });
  if (!node) {
    return null;
  }
  // If the snapshot is created by checkout, the rootId doesn't change but the iframe's document can be changed automatically when a new iframe element is created.
  if (n.rootId && (mirror.getNode(n.rootId) as Document) !== doc) {
    mirror.replace(n.rootId, doc);
  }
  // use target document as root document
  if (n.type === NodeType.Document) {
    // close before open to make sure document was closed
    doc.close();
    doc.open();
    if (
      n.compatMode === 'BackCompat' &&
      n.childNodes &&
      n.childNodes[0].type !== NodeType.DocumentType // there isn't one already defined
    ) {
      // Trigger compatMode in the iframe
      // this is needed as document.createElement('iframe') otherwise inherits a CSS1Compat mode from the parent replayer environment
      if (
        n.childNodes[0].type === NodeType.Element &&
        'xmlns' in n.childNodes[0].attributes &&
        n.childNodes[0].attributes.xmlns === 'http://www.w3.org/1999/xhtml'
      ) {
        // might as well use an xhtml doctype if we've got an xhtml namespace
        doc.write(
          '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "">',
        );
      } else {
        doc.write(
          '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN" "">',
        );
      }
    }
    node = doc;
  }

  mirror.add(node, n);

  if (
    (n.type === NodeType.Document || n.type === NodeType.Element) &&
    !skipChild
  ) {
    for (const childN of n.childNodes) {
      const childNode = buildNodeWithSN(childN, {
        doc,
        mirror,
        skipChild: false,
        hackCss,
        afterAppend,
        cache,
      });
      if (!childNode) {
        console.warn('Failed to rebuild', childN);
        continue;
      }

      if (childN.isShadow && isElement(node) && node.shadowRoot) {
        node.shadowRoot.appendChild(childNode);
      } else if (
        n.type === NodeType.Document &&
        childN.type == NodeType.Element
      ) {
        const htmlElement = childNode as HTMLElement;
        let body: HTMLBodyElement | null = null;
        htmlElement.childNodes.forEach((child) => {
          if (child.nodeName === 'BODY') body = child as HTMLBodyElement;
        });
        if (body) {
          // this branch solves a problem in Firefox where css transitions are incorrectly
          // being applied upon rebuild.  Presumably FF doesn't finished parsing the styles
          // in time, and applies e.g. a default margin:0 to elements which have a non-zero
          // margin set in CSS, along with a transition on them
          htmlElement.removeChild(body);
          // append <head> and <style>s
          node.appendChild(childNode);
          // now append <body>
          htmlElement.appendChild(body);
        } else {
          node.appendChild(childNode);
        }
      } else {
        node.appendChild(childNode);
      }
      if (afterAppend) {
        afterAppend(childNode, childN.id);
      }
    }
  }

  return node;
}

function visit(mirror: Mirror, onVisit: (node: Node) => void) {
  function walk(node: Node) {
    onVisit(node);
  }

  for (const id of mirror.getIds()) {
    if (mirror.has(id)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      walk(mirror.getNode(id)!);
    }
  }
}

function handleScroll(node: Node, mirror: Mirror) {
  const n = mirror.getMeta(node);
  if (n?.type !== NodeType.Element) {
    return;
  }
  const el = node as HTMLElement;
  for (const name in n.attributes) {
    if (
      !(
        Object.prototype.hasOwnProperty.call(n.attributes, name) &&
        name.startsWith('rr_')
      )
    ) {
      continue;
    }
    const value = n.attributes[name];
    if (name === 'rr_scrollLeft') {
      el.scrollLeft = value as number;
    }
    if (name === 'rr_scrollTop') {
      el.scrollTop = value as number;
    }
  }
}

function rebuild(
  n: serializedNodeWithId,
  options: RebuildOptions,
): Node | null {
  assertRebuildTargetAllowed(options);

  const {
    doc,
    onVisit,
    hackCss = true,
    afterAppend,
    cache,
    mirror = new Mirror(),
  } = options;
  const node = buildNodeWithSN(n, {
    doc,
    mirror,
    skipChild: false,
    hackCss,
    afterAppend,
    cache,
  });
  visit(mirror, (visitedNode) => {
    if (onVisit) {
      onVisit(visitedNode);
    }
    handleScroll(visitedNode, mirror);
  });
  return node;
}

/**
 * Create and append an iframe configured for protected snapshot rebuilds.
 *
 * The `root` option must be connected to a document. The returned iframe is
 * appended to `root`, tracked as an allowed rebuild target, and forced to use
 * exactly `sandbox="allow-same-origin"`. A caller-provided `sandbox` attribute
 * is ignored so replay data cannot weaken or expand the sandbox policy.
 *
 * Use this helper, or `rebuildIntoSandboxedIframe()`, when preparing a target
 * for untrusted replay data.
 */
export function createSandboxedIframe(
  options: CreateSandboxedIframeOptions,
): HTMLIFrameElement {
  if (!options.root.isConnected) {
    throw new Error(SANDBOXED_IFRAME_ROOT_ERROR);
  }

  const iframe = options.root.ownerDocument.createElement('iframe');

  for (const [name, value] of Object.entries(options.iframeAttributes || {})) {
    if (name === 'sandbox') {
      continue;
    }
    iframe.setAttribute(name, value);
  }

  iframe.setAttribute('sandbox', 'allow-same-origin');
  options.root.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc || !iframe.contentWindow) {
    iframe.parentNode?.removeChild(iframe);
    throw new Error(SANDBOXED_IFRAME_ROOT_ERROR);
  }

  sandboxedRebuildDocuments.add(doc);

  return iframe;
}

/**
 * Rebuild a serialized snapshot into a newly created sandboxed iframe.
 *
 * This is the preferred helper for untrusted replay data. It creates an iframe
 * with `sandbox` forced to exactly `allow-same-origin`, rebuilds into that
 * iframe's document, and returns both the iframe and rebuilt root node. If the
 * rebuild fails, the newly appended iframe is removed before the error is
 * rethrown.
 */
export function rebuildIntoSandboxedIframe(
  n: serializedNodeWithId,
  options: RebuildIntoSandboxedIframeOptions,
): { iframe: HTMLIFrameElement; node: Node | null } {
  const iframe = createSandboxedIframe(options);
  const doc = iframe.contentDocument!;

  let node: Node | null;
  try {
    node = rebuild(n, {
      ...options,
      doc,
    });
  } catch (error) {
    iframe.parentNode?.removeChild(iframe);
    throw error;
  }

  return { iframe, node };
}

export default rebuild;
