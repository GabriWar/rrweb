import type {
  AssetHook,
  MaskInputOptions,
  SlimDOMOptions,
  MaskTextFn,
  MaskInputFn,
  KeepIframeSrcFn,
  ICanvas,
  DialogAttributes,
  MaskAttributeFn,
} from './types';
import { NodeType } from '@rrweb/types';
import type {
  serializedNode,
  serializedNodeWithId,
  serializedElementNodeWithId,
  elementNode,
  attributes,
  mediaAttributes,
  DataURLOptions,
} from '@rrweb/types';
import {
  Mirror,
  is2DCanvasBlank,
  isElement,
  isShadowRoot,
  maskInputValue,
  isNativeShadowDom,
  stringifyStylesheet,
  getInputType,
  getInputValue,
  toLowerCase,
  extractFileExtension,
  absolutifyURLs,
  extractOrigin,
  markCssSplits,
  toUpperCase,
  shouldMaskInput,
  setTimeout,
  clearTimeout,
  getIFrameContentDocument,
  getIFrameContentWindow,
  stringifyRule,
  fixBrowserCompatibilityIssuesInCSS,
} from './utils';
import dom from '@rrweb/utils';

let _id = 1;
const tagNameRegex = new RegExp('[^a-z0-9-_:]');

export const IGNORED_NODE = -2;

export function genId(): number {
  return _id++;
}

function getValidTagName(element: HTMLElement): Lowercase<string> {
  if (element instanceof HTMLFormElement) {
    return 'form';
  }

  const processedTagName = toLowerCase(element.tagName);

  if (tagNameRegex.test(processedTagName)) {
    // if the tag name is odd and we cannot extract
    // anything from the string, then we return a
    // generic div
    return 'div';
  }

  return processedTagName;
}

let canvasService: HTMLCanvasElement | null;
let canvasCtx: CanvasRenderingContext2D | null;

const URL_IN_CSS_REF = /url\((?:(')([^']*)'|(")(.*?)"|([^)]*))\)/gm;
const URL_PROTOCOL_MATCH = /^(?:[a-z+]+:)?\/\//i;
const URL_WWW_MATCH = /^www\..*/i;
const DATA_URI = /^(data:)([^,]*),(.*)/i;
export function filterCSSPropertiesFromInlineStyle(
  cssText: string,
  ignoredProperties: Set<string>,
): string {
  if (!cssText || ignoredProperties.size === 0) {
    return cssText;
  }

  try {
    // Split CSS by semicolons to get individual property-value pairs
    const properties = cssText.split(';');
    const filteredProperties = [];

    for (let property of properties) {
      property = property.trim();
      if (!property) continue;

      const colonIndex = property.indexOf(':');
      if (colonIndex === -1) {
        // Invalid property, keep it as is
        filteredProperties.push(property);
        continue;
      }

      const propertyName = property.slice(0, colonIndex).trim();

      // If this property is not in the ignore set, keep it
      if (!ignoredProperties.has(propertyName)) {
        filteredProperties.push(property);
      }
    }

    return (
      filteredProperties.join('; ') +
      (filteredProperties.length > 0 && cssText.endsWith(';') ? ';' : '')
    );
  } catch (error) {
    console.warn('Error filtering CSS properties:', error);
    return cssText;
  }
}

export function absoluteToStylesheet(
  cssText: string | null,
  href: string,
): string {
  return (cssText || '').replace(
    URL_IN_CSS_REF,
    (
      origin: string,
      quote1: string,
      path1: string,
      quote2: string,
      path2: string,
      path3: string,
    ) => {
      const filePath = path1 || path2 || path3;
      const maybeQuote = quote1 || quote2 || '';
      if (!filePath) {
        return origin;
      }
      if (URL_PROTOCOL_MATCH.test(filePath) || URL_WWW_MATCH.test(filePath)) {
        return `url(${maybeQuote}${filePath}${maybeQuote})`;
      }
      if (DATA_URI.test(filePath)) {
        return `url(${maybeQuote}${filePath}${maybeQuote})`;
      }
      if (filePath[0] === '/') {
        return `url(${maybeQuote}${
          extractOrigin(href) + filePath
        }${maybeQuote})`;
      }
      const stack = href.split('/');
      const parts = filePath.split('/');
      stack.pop();
      for (const part of parts) {
        if (part === '.') {
          continue;
        } else if (part === '..') {
          stack.pop();
        } else {
          stack.push(part);
        }
      }
      return `url(${maybeQuote}${stack.join('/')}${maybeQuote})`;
    },
  );
}

// eslint-disable-next-line no-control-regex
const SRCSET_NOT_SPACES = /^[^ \t\n\r\u000c]+/; // Don't use \s, to avoid matching non-breaking space
// eslint-disable-next-line no-control-regex
const SRCSET_COMMAS_OR_SPACES = /^[, \t\n\r\u000c]+/;
function getAbsoluteSrcsetString(doc: Document, attributeValue: string) {
  /*
    run absoluteToDoc over every url in the srcset

    this is adapted from https://github.com/albell/parse-srcset/
    without the parsing of the descriptors (we return these as-is)
    parce-srcset is in turn based on
    https://html.spec.whatwg.org/multipage/embedded-content.html#parse-a-srcset-attribute
  */
  if (attributeValue.trim() === '') {
    return attributeValue;
  }

  let pos = 0;

  function collectCharacters(regEx: RegExp) {
    let chars: string;
    const match = regEx.exec(attributeValue.substring(pos));
    if (match) {
      chars = match[0];
      pos += chars.length;
      return chars;
    }
    return '';
  }

  const output = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    collectCharacters(SRCSET_COMMAS_OR_SPACES);
    if (pos >= attributeValue.length) {
      break;
    }
    // don't split on commas within urls
    let url = collectCharacters(SRCSET_NOT_SPACES);
    if (url.slice(-1) === ',') {
      // aside: according to spec more than one comma at the end is a parse error, but we ignore that
      url = absoluteToDoc(doc, url.substring(0, url.length - 1));
      // the trailing comma splits the srcset, so the interpretion is that
      // another url will follow, and the descriptor is empty
      output.push(url);
    } else {
      let descriptorsStr = '';
      url = absoluteToDoc(doc, url);
      let inParens = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const c = attributeValue.charAt(pos);
        if (c === '') {
          output.push((url + descriptorsStr).trim());
          break;
        } else if (!inParens) {
          if (c === ',') {
            pos += 1;
            output.push((url + descriptorsStr).trim());
            break; // parse the next url
          } else if (c === '(') {
            inParens = true;
          }
        } else {
          // in parenthesis; ignore commas
          // (parenthesis may be supported by future additions to spec)
          if (c === ')') {
            inParens = false;
          }
        }
        descriptorsStr += c;
        pos += 1;
      }
    }
  }
  return output.join(', ');
}

const cachedDocument = new WeakMap<Document, HTMLAnchorElement>();

export function absoluteToDoc(doc: Document, attributeValue: string): string {
  if (!attributeValue || attributeValue.trim() === '') {
    return attributeValue;
  }

  return getHref(doc, attributeValue);
}

function isSVGElement(el: Element): boolean {
  return Boolean(el.tagName === 'svg' || (el as SVGElement).ownerSVGElement);
}

function getHref(doc: Document, customHref?: string) {
  let a = cachedDocument.get(doc);
  if (!a) {
    a = doc.createElement('a');
    cachedDocument.set(doc, a);
  }
  if (!customHref) {
    customHref = '';
  } else if (customHref.startsWith('blob:') || customHref.startsWith('data:')) {
    return customHref;
  }
  // note: using `new URL` is slower. See #1434 or https://jsbench.me/uqlud17rxo/1
  a.setAttribute('href', customHref);
  return a.href;
}

export function transformAttribute(
  doc: Document,
  tagName: Lowercase<string>,
  name: Lowercase<string>,
  value: string | null,
  element: HTMLElement,
  maskAttributeFn: MaskAttributeFn | undefined,
  ignoreCSSAttributes?: Set<string>,
): string | null {
  if (!value) {
    return value;
  }

  // relative path in attribute
  if (
    name === 'src' ||
    (name === 'href' && !(tagName === 'use' && value[0] === '#'))
  ) {
    // href starts with a # is an id pointer for svg
    return absoluteToDoc(doc, value);
  } else if (name === 'xlink:href' && value[0] !== '#') {
    // xlink:href starts with # is an id pointer
    return absoluteToDoc(doc, value);
  } else if (name === 'background' && ['table', 'td', 'th'].includes(tagName)) {
    return absoluteToDoc(doc, value);
  } else if (name === 'srcset') {
    return getAbsoluteSrcsetString(doc, value);
  } else if (name === 'style') {
    let processedStyle = absoluteToStylesheet(value, getHref(doc));
    if (ignoreCSSAttributes && ignoreCSSAttributes.size > 0) {
      processedStyle = filterCSSPropertiesFromInlineStyle(
        processedStyle,
        ignoreCSSAttributes,
      );
    }
    return processedStyle;
  } else if (tagName === 'object' && name === 'data') {
    return absoluteToDoc(doc, value);
  }

  // Custom attribute masking
  if (typeof maskAttributeFn === 'function') {
    return maskAttributeFn(name, value, element);
  }

  return value;
}

export function ignoreAttribute(
  tagName: Lowercase<string>,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _value: unknown,
): boolean {
  return (
    ['video', 'audio'].includes(tagName) && toLowerCase(name) === 'autoplay'
  );
}

export function _isBlockedElement(
  element: HTMLElement,
  blockClass: string | RegExp,
  blockSelector: string | null,
  unblockSelector: string | null,
): boolean {
  try {
    if (unblockSelector && element.matches(unblockSelector)) {
      return false;
    }

    if (typeof blockClass === 'string') {
      if (element.classList.contains(blockClass)) {
        return true;
      }
    } else {
      for (let eIndex = element.classList.length; eIndex--; ) {
        const className = element.classList[eIndex];
        if (blockClass.test(className)) {
          return true;
        }
      }
    }
    if (blockSelector) {
      return element.matches(blockSelector);
    }
  } catch (e) {
    //
  }

  return false;
}

function elementClassMatchesRegex(el: HTMLElement, regex: RegExp): boolean {
  for (let eIndex = el.classList.length; eIndex--; ) {
    const className = el.classList[eIndex];
    if (regex.test(className)) {
      return true;
    }
  }
  return false;
}

export function classMatchesRegex(
  node: Node | null,
  regex: RegExp,
  checkAncestors: boolean,
): boolean {
  if (!node) return false;
  if (checkAncestors) {
    return (
      distanceToMatch(node, (node) =>
        elementClassMatchesRegex(node as HTMLElement, regex),
      ) >= 0
    );
  } else if (node.nodeType === node.ELEMENT_NODE) {
    return elementClassMatchesRegex(node as HTMLElement, regex);
  }
  return false;
}

export function distanceToMatch(
  node: Node | null,
  matchPredicate: (node: Node) => boolean,
  limit = Infinity,
  distance = 0,
): number {
  if (!node) return -1;
  if (node.nodeType !== node.ELEMENT_NODE) return -1;
  if (distance > limit) return -1;
  if (matchPredicate(node)) return distance;
  return distanceToMatch(node.parentNode, matchPredicate, limit, distance + 1);
}

export function createMatchPredicate(
  className: string | RegExp | null,
  selector: string | null,
): (node: Node) => boolean {
  return (node: Node) => {
    const el = node as HTMLElement;
    if (el === null) return false;

    try {
      if (className) {
        if (typeof className === 'string') {
          if (el.matches(`.${className}`)) return true;
        } else if (elementClassMatchesRegex(el, className)) {
          return true;
        }
      }

      if (selector && el.matches(selector)) return true;

      return false;
    } catch {
      return false;
    }
  };
}

let maskSelectorFor: [string | RegExp, string | null, string | null] | null =
  null;
/** true when `selector` parses; never throws. */
function isValidSelector(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}
/**
 * The CSS selector equivalent of a mask class + mask selector, '' when there
 * is nothing to mask, null when there is no safe selector form: the class
 * is a RegExp, or the class or the selector does not parse. null sends
 * needMaskingText to the ancestor walk, which evaluates the class and the
 * selector separately (an invalid selector there only loses its own
 * matches, never the class's), so the fast path can never mask less.
 */
function maskTargetSelector(
  maskTextClass: string | RegExp,
  maskTextSelector: string | null,
): string | null {
  if (
    maskSelectorFor &&
    maskSelectorFor[0] === maskTextClass &&
    maskSelectorFor[1] === maskTextSelector
  )
    return maskSelectorFor[2];
  let sel: string | null = null;
  if (!maskTextClass || typeof maskTextClass === 'string') {
    const parts = [
      maskTextClass ? `.${maskTextClass}` : '',
      maskTextSelector || '',
    ].filter(Boolean);
    sel = parts.every(isValidSelector) ? parts.join(',') : null;
  }
  maskSelectorFor = [maskTextClass, maskTextSelector, sel];
  return sel;
}

export function needMaskingText(
  node: Node,
  maskTextClass: string | RegExp,
  maskTextSelector: string | null,
  unmaskTextClass: string | RegExp | null,
  unmaskTextSelector: string | null,
  maskAllText: boolean,
): boolean {
  let el: Element;
  if (isElement(node)) {
    el = node;
    if (!dom.childNodes(el).length) {
      // optimisation: we can avoid any of the below checks on leaf elements
      // as masking is applied to child text nodes only
      return false;
    }
  } else if (dom.parentElement(node) === null) {
    // should warn? maybe a text node isn't attached to a parent node yet?
    return false;
  } else {
    el = dom.parentElement(node)!;
  }
  try {
    if (el.tagName === 'INPUT') {
      // Special cases: We want to enforce some masking for password & credit-card related fields,
      // no matter the settings
      const autocomplete = el.getAttribute('autocomplete');
      const disallowedAutocompleteValues = [
        'current-password',
        'new-password',
        'cc-number',
        'cc-exp',
        'cc-exp-month',
        'cc-exp-year',
        'cc-csc',
      ];
      if (disallowedAutocompleteValues.includes(autocomplete as string)) {
        return true;
      }
    }

    let maskDistance = -1;
    let unmaskDistance = -1;

    if (maskAllText) {
      unmaskDistance = distanceToMatch(
        el,
        createMatchPredicate(unmaskTextClass, unmaskTextSelector),
      );

      if (unmaskDistance < 0) {
        return true;
      }

      maskDistance = distanceToMatch(
        el,
        createMatchPredicate(maskTextClass, maskTextSelector),
        unmaskDistance >= 0 ? unmaskDistance : Infinity,
      );
    } else {
      // Fast path (Panopticon RR-018): one native closest() answers "is any
      // element from here up a mask target", which is what the walk below
      // finds out with two matches() per ancestor for every text node.
      const maskSelector = maskTargetSelector(maskTextClass, maskTextSelector);
      if (maskSelector === '') return false;
      if (maskSelector) {
        let inside = true; // a failed check never answers "not masked"
        try {
          inside = !!el.closest(maskSelector);
        } catch {
          // fall through to the walk
        }
        if (!inside) return false;
      }

      maskDistance = distanceToMatch(
        el,
        createMatchPredicate(maskTextClass, maskTextSelector),
      );

      if (maskDistance < 0) {
        return false;
      }

      unmaskDistance = distanceToMatch(
        el,
        createMatchPredicate(unmaskTextClass, unmaskTextSelector),
        maskDistance >= 0 ? maskDistance : Infinity,
      );
    }

    return maskDistance >= 0
      ? unmaskDistance >= 0
        ? maskDistance <= unmaskDistance
        : true
      : unmaskDistance >= 0
      ? false
      : !!maskAllText;
  } catch (e) {
    //
  }

  return !!maskAllText;
}

// https://stackoverflow.com/a/36155560
function onceIframeLoaded(
  iframeEl: HTMLIFrameElement,
  listener: () => unknown,
  iframeLoadTimeout: number,
) {
  const win = getIFrameContentWindow(iframeEl);
  if (!win) {
    return;
  }
  // document is loading
  let fired = false;

  let readyState: DocumentReadyState;
  try {
    readyState = win.document.readyState;
  } catch (error) {
    return;
  }
  if (readyState !== 'complete') {
    const timer = setTimeout(() => {
      if (!fired) {
        listener();
        fired = true;
      }
    }, iframeLoadTimeout);
    iframeEl.addEventListener('load', () => {
      clearTimeout(timer);
      fired = true;
      listener();
    });
    return;
  }
  // check blank frame for Chrome
  const blankUrl = 'about:blank';
  if (
    win.location.href !== blankUrl ||
    iframeEl.src === blankUrl ||
    iframeEl.src === ''
  ) {
    // iframe was already loaded, make sure we wait to trigger the listener
    // till _after_ the mutation that found this iframe has had time to process
    setTimeout(listener, 0);

    return iframeEl.addEventListener('load', listener); // keep listing for future loads
  }
  // use default listener
  iframeEl.addEventListener('load', listener);
}

function onceStylesheetLoaded(
  link: HTMLLinkElement,
  listener: () => unknown,
  styleSheetLoadTimeout: number,
) {
  let fired = false;
  let styleSheetLoaded: StyleSheet | null;
  try {
    styleSheetLoaded = link.sheet;
  } catch (error) {
    // CORS stylesheets throw SecurityError when accessing .sheet
    // before they're loaded — fall through to attach load listener
    styleSheetLoaded = null;
  }

  if (styleSheetLoaded) return;

  const timer = setTimeout(() => {
    if (!fired) {
      listener();
      fired = true;
    }
  }, styleSheetLoadTimeout);

  link.addEventListener('load', () => {
    clearTimeout(timer);
    fired = true;
    listener();
  });
}

let assetHook: AssetHook | null = null;
/**
 * Panopticon RR-030: install the asset hook for every serialization that
 * follows (snapshot, sliced snapshot, mutation adds, iframe and stylesheet
 * loads, shadow roots), until it is set again. record() sets it from its
 * options at start and clears it at stop. Returns the previous hook.
 */
export function setAssetHook(hook: AssetHook | null): AssetHook | null {
  const prev = assetHook;
  assetHook = hook;
  return prev;
}

/**
 * Panopticon item 8: called for every canvas a full snapshot serializes
 * while canvas recording is on. A hook that returns true takes over the
 * pixels: it captures them now (an ImageBitmap is a copy of the canvas at
 * this instant) and calls `fill` with the canvas's PNG data URL, or null
 * for a blank canvas, once they are encoded off the main thread. The
 * recorder holds the FullSnapshot until every fill has run, so the stream
 * carries the same pixels the synchronous toDataURL() would have read.
 */
export type CanvasPixelsHook = (
  canvas: HTMLCanvasElement,
  dataURLOptions: DataURLOptions,
  fill: (dataURL: string | null) => void,
) => boolean;
let canvasPixelsHook: CanvasPixelsHook | null = null;
/**
 * Values the asset hook should take while a full snapshot is held back
 * (sliced, or waiting for canvas pixels): the recorder starts a new side
 * table at every Meta, so a value handed to the hook before the Meta is
 * dispatched would be dropped with the old one. While deferral is on, the
 * hook runs at dispatch time instead (applyDeferredAssetHooks, right after
 * the Meta), in order, on exactly the attributes it would have seen.
 */
let deferAssets = false;
const deferredAssets: Array<[attributes, AssetHook]> = [];
export function setAssetDeferral(on: boolean, drop = false): void {
  deferAssets = on;
  if (drop) deferredAssets.length = 0;
}
export function applyDeferredAssetHooks(): void {
  for (const [a, hook] of deferredAssets.splice(0)) applyAssetHookNow(a, hook);
}
/** Install the canvas pixels hook (record() sets it around full snapshots only). */
export function setCanvasPixelsHook(
  hook: CanvasPixelsHook | null,
): CanvasPixelsHook | null {
  const prev = canvasPixelsHook;
  canvasPixelsHook = hook;
  return prev;
}

/** Hand the element's large values to the asset hook (RR-030). */
function applyAssetHook(attributes: attributes, hook: AssetHook) {
  if (deferAssets) deferredAssets.push([attributes, hook]);
  else applyAssetHookNow(attributes, hook);
}
function applyAssetHookNow(attributes: attributes, hook: AssetHook) {
  for (const name in attributes) {
    const v = attributes[name];
    if (typeof v !== 'string') continue;
    const kind =
      name === '_cssText'
        ? 'css'
        : name === 'rr_dataURL' || v.startsWith('data:')
        ? 'media'
        : null;
    if (!kind) continue;
    const r = hook(kind, v);
    if (r !== null) attributes[name] = r;
  }
}

function serializeNode(
  n: Node,
  options: {
    doc: Document;
    mirror: Mirror;
    blockClass: string | RegExp;
    blockSelector: string | null;
    needsMask?: boolean;
    unblockSelector: string | null;
    maskAllText: boolean;
    maskAttributeFn: MaskAttributeFn | undefined;
    maskTextClass: string | RegExp;
    unmaskTextClass: string | RegExp | null;
    maskTextSelector: string | null;
    unmaskTextSelector: string | null;
    inlineStylesheet: boolean;
    maskInputOptions: MaskInputOptions;
    maskTextFn: MaskTextFn | undefined;
    maskInputFn: MaskInputFn | undefined;
    dataURLOptions?: DataURLOptions;
    inlineImages: boolean;
    recordCanvas: boolean;
    keepIframeSrcFn: KeepIframeSrcFn;
    /**
     * `newlyAddedElement: true` skips scrollTop and scrollLeft check
     */
    newlyAddedElement?: boolean;
    cssCaptured?: boolean;
    ignoreCSSAttributes?: Set<string>;
  },
): serializedNode | false {
  const {
    doc,
    mirror,
    blockClass,
    blockSelector,
    unblockSelector,
    maskAllText,
    maskAttributeFn,
    maskTextClass,
    unmaskTextClass,
    maskTextSelector,
    unmaskTextSelector,
    inlineStylesheet,
    maskInputOptions = {},
    maskTextFn,
    maskInputFn,
    dataURLOptions = {},
    inlineImages,
    recordCanvas,
    keepIframeSrcFn,
    newlyAddedElement = false,
    cssCaptured = false,
    ignoreCSSAttributes,
  } = options;
  // Only record root id when document object is not the base document
  const rootId = getRootId(doc, mirror);
  switch (n.nodeType) {
    case n.DOCUMENT_NODE:
      if ((n as Document).compatMode !== 'CSS1Compat') {
        return {
          type: NodeType.Document,
          childNodes: [],
          compatMode: (n as Document).compatMode, // probably "BackCompat"
        };
      } else {
        return {
          type: NodeType.Document,
          childNodes: [],
        };
      }
    case n.DOCUMENT_TYPE_NODE:
      return {
        type: NodeType.DocumentType,
        name: (n as DocumentType).name,
        publicId: (n as DocumentType).publicId,
        systemId: (n as DocumentType).systemId,
        rootId,
      };
    case n.ELEMENT_NODE:
      return serializeElementNode(n as HTMLElement, {
        doc,
        blockClass,
        blockSelector,
        unblockSelector,
        inlineStylesheet,
        maskAttributeFn,
        maskInputOptions,
        maskInputFn,
        dataURLOptions,
        inlineImages,
        recordCanvas,
        keepIframeSrcFn,
        newlyAddedElement,
        rootId,
        maskAllText,
        maskTextClass,
        unmaskTextClass,
        maskTextSelector,
        unmaskTextSelector,
        ignoreCSSAttributes,
      });
    case n.TEXT_NODE:
      return serializeTextNode(n as Text, {
        doc,
        maskAllText,
        maskTextClass,
        unmaskTextClass,
        maskTextSelector,
        unmaskTextSelector,
        maskTextFn,
        maskInputOptions,
        maskInputFn,
        rootId,
        cssCaptured,
      });
    case n.CDATA_SECTION_NODE:
      return {
        type: NodeType.CDATA,
        textContent: '',
        rootId,
      };
    case n.COMMENT_NODE:
      return {
        type: NodeType.Comment,
        textContent: dom.textContent(n as Comment) || '',
        rootId,
      };
    default:
      return false;
  }
}

function getRootId(doc: Document, mirror: Mirror): number | undefined {
  if (!mirror.hasNode(doc)) return undefined;
  const docId = mirror.getId(doc);
  return docId === 1 ? undefined : docId;
}

function serializeTextNode(
  n: Text,
  options: {
    doc: Document;
    needsMask?: boolean;
    maskAllText: boolean;
    maskTextClass: string | RegExp;
    unmaskTextClass: string | RegExp | null;
    maskTextSelector: string | null;
    unmaskTextSelector: string | null;
    maskTextFn: MaskTextFn | undefined;
    maskInputOptions: MaskInputOptions;
    maskInputFn: MaskInputFn | undefined;
    rootId: number | undefined;
    cssCaptured?: boolean;
  },
): serializedNode {
  const {
    maskAllText,
    maskTextClass,
    unmaskTextClass,
    maskTextSelector,
    unmaskTextSelector,
    maskTextFn,
    maskInputOptions,
    maskInputFn,
    rootId,
    cssCaptured,
  } = options;
  // The parent node may not be a html element which has a tagName attribute.
  // So just let it be undefined which is ok in this use case.
  const parent = dom.parentNode(n);
  const parentTagName = parent && (parent as HTMLElement).tagName;
  let textContent: string | null = '';
  const isStyle = parentTagName === 'STYLE' ? true : undefined;
  const isScript = parentTagName === 'SCRIPT' ? true : undefined;
  const isTextarea = parentTagName === 'TEXTAREA' ? true : undefined;
  if (isStyle && textContent) {
    try {
      // try to read style sheet
      if (n.nextSibling || n.previousSibling) {
        // This is not the only child of the stylesheet.
        // We can't read all of the sheet's .cssRules and expect them
        // to _only_ include the current rule(s) added by the text node.
        // So we'll be conservative and keep textContent as-is.
      } else if ((n.parentNode as HTMLStyleElement).sheet?.cssRules) {
        textContent = stringifyStylesheet(
          (n.parentNode as HTMLStyleElement).sheet!,
        );
      }
    } catch (err) {
      console.warn(
        `Cannot get CSS styles from text's parentNode. Error: ${err as string}`,
        n,
      );
    }
    textContent = absoluteToStylesheet(textContent, getHref(options.doc));
  }
  if (isScript) {
    textContent = 'SCRIPT_PLACEHOLDER';
  } else if (!cssCaptured) {
    textContent = dom.textContent(n);
    if (isStyle && textContent) {
      // mutation only: we don't need to use stringifyStylesheet
      // as a <style> text node mutation obliterates any previous
      // programmatic rule manipulation (.insertRule etc.)
      // so the current textContent represents the most up to date state
      textContent = absolutifyURLs(textContent, getHref(options.doc));
    }
  }
  const forceMask = needMaskingText(
    n,
    maskTextClass,
    maskTextSelector,
    unmaskTextClass,
    unmaskTextSelector,
    maskAllText,
  );

  if (!isStyle && !isScript && !isTextarea && textContent && forceMask) {
    textContent = maskTextFn
      ? maskTextFn(textContent, dom.parentElement(n))
      : textContent.replace(/[\S]/g, '*');
  }
  if (isTextarea && textContent && (maskInputOptions.textarea || forceMask)) {
    textContent = maskInputFn
      ? maskInputFn(textContent, n.parentNode as HTMLElement)
      : textContent.replace(/[\S]/g, '*');
  }

  // Handle <option> text like an input value
  if (parentTagName === 'OPTION' && textContent) {
    const isInputMasked = shouldMaskInput({
      type: null,
      tagName: parentTagName,
      maskInputOptions,
    });

    textContent = maskInputValue({
      isMasked: needMaskingText(
        n,
        maskTextClass,
        maskTextSelector,
        unmaskTextClass,
        unmaskTextSelector,
        isInputMasked,
      ),
      element: n as unknown as HTMLElement,
      value: textContent,
      maskInputFn,
    });
  }

  return {
    type: NodeType.Text,
    textContent: textContent || '',
    rootId,
  };
}

/** rr_dataURL of a canvas read synchronously (none for a blank canvas). */
function canvasDataURLNow(
  n: HTMLCanvasElement,
  dataURLOptions: DataURLOptions,
  attributes: attributes,
) {
  if ((n as ICanvas).__context === '2d') {
    // only record this on 2d canvas
    if (!is2DCanvasBlank(n)) {
      attributes.rr_dataURL = n.toDataURL(
        dataURLOptions.type,
        dataURLOptions.quality,
      );
    }
  } else if (!('__context' in n)) {
    // context is unknown, better not call getContext to trigger it
    const canvasDataURL = n.toDataURL(
      dataURLOptions.type,
      dataURLOptions.quality,
    );

    // create blank canvas of same dimensions
    const blankCanvas = n.ownerDocument.createElement('canvas');
    blankCanvas.width = n.width;
    blankCanvas.height = n.height;
    const blankCanvasDataURL = blankCanvas.toDataURL(
      dataURLOptions.type,
      dataURLOptions.quality,
    );

    // no need to save dataURL if it's the same as blank canvas
    if (canvasDataURL !== blankCanvasDataURL) {
      attributes.rr_dataURL = canvasDataURL;
    }
  }
}

function serializeElementNode(
  n: HTMLElement,
  options: {
    doc: Document;
    blockClass: string | RegExp;
    blockSelector: string | null;
    unblockSelector: string | null;
    inlineStylesheet: boolean;
    maskAttributeFn: MaskAttributeFn | undefined;
    maskInputOptions: MaskInputOptions;
    maskInputFn: MaskInputFn | undefined;
    dataURLOptions?: DataURLOptions;
    inlineImages: boolean;
    recordCanvas: boolean;
    keepIframeSrcFn: KeepIframeSrcFn;
    /**
     * `newlyAddedElement: true` skips scrollTop and scrollLeft check
     */
    newlyAddedElement?: boolean;
    rootId: number | undefined;
    maskAllText: boolean;
    maskTextClass: string | RegExp;
    unmaskTextClass: string | RegExp | null;
    maskTextSelector: string | null;
    unmaskTextSelector: string | null;
    ignoreCSSAttributes?: Set<string>;
  },
): serializedNode | false {
  const {
    doc,
    blockClass,
    blockSelector,
    unblockSelector,
    inlineStylesheet,
    maskInputOptions = {},
    maskAttributeFn,
    maskInputFn,
    dataURLOptions = {},
    inlineImages,
    recordCanvas,
    keepIframeSrcFn,
    newlyAddedElement = false,
    rootId,
    maskTextClass,
    unmaskTextClass,
    maskTextSelector,
    unmaskTextSelector,
    ignoreCSSAttributes,
  } = options;
  const needBlock = _isBlockedElement(
    n,
    blockClass,
    blockSelector,
    unblockSelector,
  );
  const tagName = getValidTagName(n);
  // Panopticon item 8: `n` is the inert copy of the page as of the frozen
  // snapshot's start; what a copy does not carry (CSSOM, form state, layout,
  // pixels, media, frames) was read from the live element at that instant
  const fz = frozenNow;
  const live = fz ? fz.live : n;
  let attributes: attributes = {};
  const len = n.attributes.length;
  for (let i = 0; i < len; i++) {
    const attr = n.attributes[i];
    // Looks like `attr.name` can be undefined although the types say differently
    // see: https://github.com/getsentry/sentry-javascript/issues/10292
    if (attr.name && !ignoreAttribute(tagName, attr.name, attr.value)) {
      attributes[attr.name] = transformAttribute(
        doc,
        tagName,
        toLowerCase(attr.name),
        attr.value,
        n,
        maskAttributeFn,
        ignoreCSSAttributes,
      );
    }
  }
  // remote css
  if (tagName === 'link' && inlineStylesheet) {
    //TODO: maybe replace this `.styleSheets` with original one
    const stylesheet = fz
      ? fz.f.sheets.get(live) || undefined
      : Array.from(doc.styleSheets).find((s) => {
          return s.href === (n as HTMLLinkElement).href;
        });
    let cssText: string | null = null;
    if (stylesheet) {
      cssText = fz
        ? frozenSheetText(fz.f, stylesheet)
        : stringifyStylesheet(stylesheet);
    }
    if (cssText) {
      attributes.rel = null;
      attributes.href = null;
      attributes.crossorigin = null;
      attributes._cssText = absoluteToStylesheet(cssText, stylesheet!.href!);
    }
  }
  const styleSheet =
    tagName !== 'style'
      ? null
      : fz
      ? fz.f.sheets.get(live)
      : (n as HTMLStyleElement).sheet;
  if (tagName === 'style' && styleSheet) {
    let cssText = fz
      ? frozenSheetText(fz.f, styleSheet as CSSStyleSheet)
      : stringifyStylesheet(styleSheet as CSSStyleSheet);
    if (cssText) {
      if (n.childNodes.length > 1) {
        cssText = markCssSplits(cssText, n as HTMLStyleElement);
      }
      attributes._cssText = cssText;
    }
  }
  // form fields
  if (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    tagName === 'option'
  ) {
    const el = n as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement
      | HTMLOptionElement;

    const type = getInputType(el);
    const form = fz ? fz.f.form.get(live) : undefined;
    const value = form
      ? form.value
      : getInputValue(el, toUpperCase(tagName), type);
    const checked = form ? form.checked : (el as HTMLInputElement).checked;
    if (type !== 'submit' && type !== 'button' && value) {
      const forceMask = needMaskingText(
        el,
        maskTextClass,
        maskTextSelector,
        unmaskTextClass,
        unmaskTextSelector,
        shouldMaskInput({
          type,
          tagName: toUpperCase(tagName),
          maskInputOptions,
        }),
      );

      attributes.value = maskInputValue({
        isMasked: forceMask,
        element: el,
        value,
        maskInputFn,
      });
    }
    if (checked) {
      attributes.checked = checked;
    }
  }
  if (tagName === 'option') {
    const selected = fz
      ? !!fz.f.form.get(live)?.selected
      : (n as HTMLOptionElement).selected;
    if (selected && !maskInputOptions['select']) {
      attributes.selected = true;
    } else {
      // ignore the html attribute (which corresponds to DOM (n as HTMLOptionElement).defaultSelected)
      // if it's already been changed
      delete attributes.selected;
    }
  }

  if (tagName === 'dialog' && (n as HTMLDialogElement).open) {
    // register what type of dialog is this
    // `modal` or `non-modal`
    // this is used to trigger `showModal()` or `show()` on replay (outside of rrweb-snapshot, in rrweb)
    (attributes as DialogAttributes).rr_open_mode = (
      fz ? fz.f.modal.has(live) : n.matches('dialog:modal')
    )
      ? 'modal'
      : 'non-modal';
  }

  // canvas image data
  // (a blocked canvas is replaced by its placeholder below: never captured)
  const pixelsHook = canvasPixelsHook;
  const hookAtSerialize = assetHook;
  const canvasAttributes = attributes;
  const slot = fz && tagName === 'canvas' ? fz.f.canvas.get(live) : undefined;
  if (slot) {
    // pixels taken when the snapshot started (freezeDocument)
    if (slot.url === undefined) slot.target = attributes;
    else if (slot.url !== null) attributes.rr_dataURL = slot.url;
  } else if (fz && tagName === 'canvas') {
    // blocked, or not recorded: no pixels, as the live serialization decides
  } else if (
    tagName === 'canvas' &&
    recordCanvas &&
    !needBlock &&
    pixelsHook &&
    pixelsHook(n as HTMLCanvasElement, dataURLOptions, (dataURL) => {
      if (dataURL === null) return;
      canvasAttributes.rr_dataURL = dataURL;
      if (hookAtSerialize)
        deferredAssets.push([canvasAttributes, hookAtSerialize]);
    })
  ) {
    // pixels captured now, encoded off the main thread (see CanvasPixelsHook)
  } else if (tagName === 'canvas' && recordCanvas) {
    canvasDataURLNow(n as HTMLCanvasElement, dataURLOptions, attributes);
  }
  // save image offline
  if (tagName === 'img' && inlineImages) {
    if (!canvasService) {
      canvasService = doc.createElement('canvas');
      canvasCtx = canvasService.getContext('2d');
    }
    const image = n as HTMLImageElement;
    const imageSrc: string =
      image.currentSrc || image.getAttribute('src') || '<unknown-src>';
    const priorCrossOrigin = image.crossOrigin;
    const recordInlineImage = () => {
      image.removeEventListener('load', recordInlineImage);
      try {
        canvasService!.width = image.naturalWidth;
        canvasService!.height = image.naturalHeight;
        canvasCtx!.drawImage(image, 0, 0);
        attributes.rr_dataURL = canvasService!.toDataURL(
          dataURLOptions.type,
          dataURLOptions.quality,
        );
      } catch (err) {
        if (image.crossOrigin !== 'anonymous') {
          image.crossOrigin = 'anonymous';
          if (image.complete && image.naturalWidth !== 0)
            recordInlineImage(); // too early due to image reload
          else image.addEventListener('load', recordInlineImage);
          return;
        } else {
          console.warn(
            `Cannot inline img src=${imageSrc}! Error: ${err as string}`,
          );
        }
      }
      if (image.crossOrigin === 'anonymous') {
        priorCrossOrigin
          ? (attributes.crossOrigin = priorCrossOrigin)
          : image.removeAttribute('crossorigin');
      }
    };
    // The image content may not have finished loading yet.
    if (image.complete && image.naturalWidth !== 0) recordInlineImage();
    else image.addEventListener('load', recordInlineImage);
  }
  // media elements
  if (['audio', 'video'].includes(tagName)) {
    const mediaAttributes = attributes as mediaAttributes;
    const m = fz ? fz.f.media.get(live) : (n as HTMLMediaElement);
    mediaAttributes.rr_mediaState = !m || m.paused ? 'paused' : 'played';
    attributes.rr_mediaCurrentTime = m ? m.currentTime : 0;
  }
  // Scroll
  if (!newlyAddedElement) {
    // `scrollTop` and `scrollLeft` are expensive calls because they trigger reflow.
    // Since `scrollTop` & `scrollLeft` are always 0 when an element is added to the DOM.
    // And scrolls also get picked up by rrweb's ScrollObserver
    // So we can safely skip the `scrollTop/Left` calls for newly added elements
    const sc = fz ? fz.f.scroll.get(live) : n;
    if (sc && sc.scrollLeft) {
      attributes.rr_scrollLeft = sc.scrollLeft;
    }
    if (sc && sc.scrollTop) {
      attributes.rr_scrollTop = sc.scrollTop;
    }
  }
  // block element
  if (needBlock) {
    const { width, height } = fz
      ? fz.f.rect.get(live) || { width: 0, height: 0 }
      : n.getBoundingClientRect();
    attributes = {
      class: attributes.class,
      rr_width: `${width}px`,
      rr_height: `${height}px`,
    };
  }
  // iframe
  if (tagName === 'iframe' && !keepIframeSrcFn(attributes.src as string)) {
    // Don't try to access `contentDocument` if iframe is blocked, otherwise it
    // will trigger browser warnings.
    if (
      !needBlock &&
      !(fz
        ? fz.f.iframeDoc.has(live)
        : getIFrameContentDocument(n as HTMLIFrameElement))
    ) {
      // we can't record it directly as we can't see into it
      // preserve the src attribute so a decision can be taken at replay time
      attributes.rr_src = attributes.src;
    }
    delete attributes.src; // prevent auto loading
  }

  let isCustomElement: true | undefined;
  try {
    if (fz ? fz.f.custom.get(tagName) : customElements.get(tagName))
      isCustomElement = true;
  } catch (e) {
    // In case old browsers don't support customElements
  }

  if (assetHook) applyAssetHook(attributes, assetHook);

  return {
    type: NodeType.Element,
    tagName,
    attributes,
    childNodes: [],
    isSVG: isSVGElement(n as Element) || undefined,
    needBlock,
    rootId,
    isCustom: isCustomElement,
  };
}

function lowerIfExists(
  maybeAttr: string | number | boolean | undefined | null,
): string {
  if (maybeAttr === undefined || maybeAttr === null) {
    return '';
  } else {
    return (maybeAttr as string).toLowerCase();
  }
}

export function slimDOMDefaults(
  _slimDOMOptions: SlimDOMOptions | 'all' | true | false | undefined,
) {
  if (_slimDOMOptions === true || _slimDOMOptions === 'all') {
    // if true: set of sensible options that should not throw away any information
    return {
      script: true,
      comment: true,
      headFavicon: true,
      headWhitespace: true,
      headMetaSocial: true,
      headMetaRobots: true,
      headMetaHttpEquiv: true,
      headMetaVerification: true,
      // the following are off for slimDOMOptions === true,
      // as they destroy some (hidden) info:
      headMetaAuthorship: _slimDOMOptions === 'all',
      headMetaDescKeywords: _slimDOMOptions === 'all',
      headTitleMutations: _slimDOMOptions === 'all',
    };
  } else if (_slimDOMOptions) {
    return _slimDOMOptions;
  }
  return {};
}

function slimDOMExcluded(
  sn: serializedNode,
  slimDOMOptions: SlimDOMOptions,
): boolean {
  if (slimDOMOptions.comment && sn.type === NodeType.Comment) {
    // TODO: convert IE conditional comments to real nodes
    return true;
  } else if (sn.type === NodeType.Element) {
    if (
      slimDOMOptions.script &&
      // script tag
      (sn.tagName === 'script' ||
        // (module)preload link
        (sn.tagName === 'link' &&
          (sn.attributes.rel === 'preload' ||
            sn.attributes.rel === 'modulepreload')) ||
        // prefetch link
        (sn.tagName === 'link' &&
          sn.attributes.rel === 'prefetch' &&
          typeof sn.attributes.href === 'string' &&
          extractFileExtension(sn.attributes.href) === 'js'))
    ) {
      return true;
    } else if (
      slimDOMOptions.headFavicon &&
      ((sn.tagName === 'link' && sn.attributes.rel === 'shortcut icon') ||
        (sn.tagName === 'meta' &&
          (lowerIfExists(sn.attributes.name).match(
            /^msapplication-tile(image|color)$/,
          ) ||
            lowerIfExists(sn.attributes.name) === 'application-name' ||
            lowerIfExists(sn.attributes.rel) === 'icon' ||
            lowerIfExists(sn.attributes.rel) === 'apple-touch-icon' ||
            lowerIfExists(sn.attributes.rel) === 'shortcut icon')))
    ) {
      return true;
    } else if (sn.tagName === 'meta') {
      if (
        slimDOMOptions.headMetaDescKeywords &&
        lowerIfExists(sn.attributes.name).match(/^description|keywords$/)
      ) {
        return true;
      } else if (
        slimDOMOptions.headMetaSocial &&
        (lowerIfExists(sn.attributes.property).match(/^(og|twitter|fb):/) || // og = opengraph (facebook)
          lowerIfExists(sn.attributes.name).match(/^(og|twitter):/) ||
          lowerIfExists(sn.attributes.name) === 'pinterest')
      ) {
        return true;
      } else if (
        slimDOMOptions.headMetaRobots &&
        (lowerIfExists(sn.attributes.name) === 'robots' ||
          lowerIfExists(sn.attributes.name) === 'googlebot' ||
          lowerIfExists(sn.attributes.name) === 'bingbot')
      ) {
        return true;
      } else if (
        slimDOMOptions.headMetaHttpEquiv &&
        sn.attributes['http-equiv'] !== undefined
      ) {
        // e.g. X-UA-Compatible, Content-Type, Content-Language,
        // cache-control, X-Translated-By
        return true;
      } else if (
        slimDOMOptions.headMetaAuthorship &&
        (lowerIfExists(sn.attributes.name) === 'author' ||
          lowerIfExists(sn.attributes.name) === 'generator' ||
          lowerIfExists(sn.attributes.name) === 'framework' ||
          lowerIfExists(sn.attributes.name) === 'publisher' ||
          lowerIfExists(sn.attributes.name) === 'progid' ||
          lowerIfExists(sn.attributes.property).match(/^article:/) ||
          lowerIfExists(sn.attributes.property).match(/^product:/))
      ) {
        return true;
      } else if (
        slimDOMOptions.headMetaVerification &&
        (lowerIfExists(sn.attributes.name) === 'google-site-verification' ||
          lowerIfExists(sn.attributes.name) === 'yandex-verification' ||
          lowerIfExists(sn.attributes.name) === 'csrf-token' ||
          lowerIfExists(sn.attributes.name) === 'p:domain_verify' ||
          lowerIfExists(sn.attributes.name) === 'verify-v1' ||
          lowerIfExists(sn.attributes.name) === 'verification' ||
          lowerIfExists(sn.attributes.name) === 'shopify-checkout-api-token')
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Options of serializeNodeWithId (and of the sliced walker, Panopticon RR-017).
 */
export type SerializeNodeOptions = {
  doc: Document;
  mirror: Mirror;
  blockClass: string | RegExp;
  blockSelector: string | null;
  unblockSelector: string | null;
  maskTextClass: string | RegExp;
  unmaskTextClass: string | RegExp | null;
  maskTextSelector: string | null;
  unmaskTextSelector: string | null;
  skipChild: boolean;
  inlineStylesheet: boolean;
  newlyAddedElement?: boolean;
  maskInputOptions?: MaskInputOptions;
  maskAllText: boolean;
  maskAttributeFn: MaskAttributeFn | undefined;
  maskTextFn: MaskTextFn | undefined;
  maskInputFn: MaskInputFn | undefined;
  slimDOMOptions: SlimDOMOptions;
  dataURLOptions?: DataURLOptions;
  keepIframeSrcFn?: KeepIframeSrcFn;
  inlineImages?: boolean;
  recordCanvas?: boolean;
  preserveWhiteSpace?: boolean;
  onSerialize?: (n: Node) => unknown;
  onIframeLoad?: (
    iframeNode: HTMLIFrameElement,
    node: serializedElementNodeWithId,
  ) => unknown;
  iframeLoadTimeout?: number;
  onBlockedImageLoad?: (
    imageEl: HTMLImageElement,
    node: serializedElementNodeWithId,
    rect: DOMRect,
  ) => unknown;
  onStylesheetLoad?: (
    linkNode: HTMLLinkElement,
    node: serializedElementNodeWithId,
  ) => unknown;
  stylesheetLoadTimeout?: number;
  cssCaptured?: boolean;
  ignoreCSSAttributes?: Set<string>;
};

/**
 * First half of serializeNodeWithId: serialize `n` itself, give it an id,
 * run onSerialize, and work out the options its children are serialized
 * with. Children are then visited by the caller (recursively for the
 * synchronous snapshot, from an explicit stack for the sliced one), and
 * serializeNodeTail() runs once they are done. Both halves are exactly the
 * code serializeNodeWithId always ran, split at the child loop, so the two
 * walkers produce byte-identical output.
 */
function serializeNodeHead(
  n: Node,
  options: SerializeNodeOptions,
): {
  serializedNode: serializedNodeWithId;
  /** options for children; null when the node's children are not recorded */
  childOptions: SerializeNodeOptions | null;
  /** the light-DOM children are skipped (a textarea whose value is recorded) */
  skipLightChildren: boolean;
} | null {
  const {
    doc,
    mirror,
    blockClass,
    blockSelector,
    unblockSelector,
    maskAllText,
    maskTextClass,
    unmaskTextClass,
    maskTextSelector,
    unmaskTextSelector,
    skipChild = false,
    inlineStylesheet = true,
    maskInputOptions = {},
    maskAttributeFn,
    maskTextFn,
    maskInputFn,
    slimDOMOptions,
    dataURLOptions = {},
    inlineImages = false,
    recordCanvas = false,
    onSerialize,
    onIframeLoad,
    iframeLoadTimeout = 5000,
    onBlockedImageLoad,
    onStylesheetLoad,
    stylesheetLoadTimeout = 5000,
    keepIframeSrcFn = () => false,
    newlyAddedElement = false,
    cssCaptured = false,
    ignoreCSSAttributes,
  } = options;
  let { preserveWhiteSpace = true } = options;

  const _serializedNode = serializeNode(n, {
    doc,
    mirror,
    blockClass,
    blockSelector,
    maskAllText,
    unblockSelector,
    maskTextClass,
    unmaskTextClass,
    maskTextSelector,
    unmaskTextSelector,
    inlineStylesheet,
    maskInputOptions,
    maskAttributeFn,
    maskTextFn,
    maskInputFn,
    dataURLOptions,
    inlineImages,
    recordCanvas,
    keepIframeSrcFn,
    newlyAddedElement,
    cssCaptured,
    ignoreCSSAttributes,
  });
  if (!_serializedNode) {
    // TODO: dev only
    console.warn(n, 'not serialized');
    return null;
  }

  let id: number | undefined;
  const excluded = () =>
    slimDOMExcluded(_serializedNode, slimDOMOptions) ||
    (!preserveWhiteSpace &&
      _serializedNode.type === NodeType.Text &&
      !_serializedNode.isStyle &&
      !_serializedNode.textContent.trim().length);
  // Panopticon item 8: a frozen snapshot's node (an inert copy) takes the id
  // freezeDocument gave its live node when the snapshot started, and fills
  // the mirror entry made then; onSerialize and the load hooks ran then too
  const fz = frozenNow;
  let serializedNode: serializedNodeWithId;
  if (fz) {
    const shell = fz.f.shells[fz.k];
    if (excluded()) id = IGNORED_NODE;
    else if (shell && shell.id > 0) id = shell.id;
    else id = genId(); // freezeDocument decided otherwise: a fresh id
    if (shell && shell.id === id) {
      for (const key of Object.keys(shell))
        delete (shell as Record<string, unknown>)[key];
      serializedNode = Object.assign(shell, _serializedNode, { id });
    } else {
      serializedNode = Object.assign(_serializedNode, { id });
      if (id !== IGNORED_NODE) fz.mirror.add(fz.live, serializedNode);
      else if (shell) shell.id = IGNORED_NODE;
    }
  } else {
    if (mirror.hasNode(n)) {
      // Reuse the previous id
      id = mirror.getId(n);
    } else if (excluded()) {
      id = IGNORED_NODE;
    } else {
      id = genId();
    }
    serializedNode = Object.assign(_serializedNode, { id });
    // add IGNORED_NODE to mirror to track nextSiblings
    mirror.add(n, serializedNode);
  }

  if (id === IGNORED_NODE) {
    return null; // slimDOM
  }

  if (onSerialize && !fz) {
    onSerialize(n);
  }
  let recordChild = !skipChild;
  if (serializedNode.type === NodeType.Element) {
    recordChild = recordChild && !serializedNode.needBlock;
    // this property was not needed in replay side
    delete serializedNode.needBlock;
    const shadowRootEl = dom.shadowRoot(n);
    if (shadowRootEl && isNativeShadowDom(shadowRootEl))
      serializedNode.isShadowHost = true;
  }
  if (
    (serializedNode.type === NodeType.Document ||
      serializedNode.type === NodeType.Element) &&
    recordChild
  ) {
    if (
      slimDOMOptions.headWhitespace &&
      serializedNode.type === NodeType.Element &&
      serializedNode.tagName === 'head'
      // would impede performance: || getComputedStyle(n)['white-space'] === 'normal'
    ) {
      preserveWhiteSpace = false;
    }
    const bypassOptions = {
      doc,
      mirror,
      blockClass,
      blockSelector,
      maskAllText,
      unblockSelector,
      maskTextClass,
      unmaskTextClass,
      maskTextSelector,
      unmaskTextSelector,
      skipChild,
      inlineStylesheet,
      maskInputOptions,
      maskAttributeFn,
      maskTextFn,
      maskInputFn,
      slimDOMOptions,
      dataURLOptions,
      inlineImages,
      recordCanvas,
      preserveWhiteSpace,
      onSerialize,
      onIframeLoad,
      iframeLoadTimeout,
      onBlockedImageLoad,
      onStylesheetLoad,
      stylesheetLoadTimeout,
      keepIframeSrcFn,
      cssCaptured: false,
      ignoreCSSAttributes,
    };

    const skipLightChildren =
      serializedNode.type === NodeType.Element &&
      serializedNode.tagName === 'textarea' &&
      (serializedNode as elementNode).attributes.value !== undefined;
    // value parameter in DOM reflects the correct value, so ignore childNode
    if (
      !skipLightChildren &&
      serializedNode.type === NodeType.Element &&
      (serializedNode as elementNode).attributes._cssText !== undefined &&
      typeof serializedNode.attributes._cssText === 'string'
    ) {
      bypassOptions.cssCaptured = true;
    }
    return {
      serializedNode,
      childOptions: bypassOptions,
      skipLightChildren,
    };
  }
  return { serializedNode, childOptions: null, skipLightChildren: false };
}

/**
 * Second half of serializeNodeWithId: what runs after the node's children
 * (shadow-child flag, iframe / blocked image / stylesheet load hooks).
 */
function serializeNodeTail(
  n: Node,
  serializedNode: serializedNodeWithId,
  options: SerializeNodeOptions,
): void {
  const {
    mirror,
    blockClass,
    blockSelector,
    unblockSelector,
    maskAllText,
    maskTextClass,
    unmaskTextClass,
    maskTextSelector,
    unmaskTextSelector,
    inlineStylesheet = true,
    maskInputOptions = {},
    maskAttributeFn,
    maskTextFn,
    maskInputFn,
    slimDOMOptions,
    dataURLOptions = {},
    inlineImages = false,
    recordCanvas = false,
    onSerialize,
    onIframeLoad,
    iframeLoadTimeout = 5000,
    onBlockedImageLoad,
    onStylesheetLoad,
    stylesheetLoadTimeout = 5000,
    keepIframeSrcFn = () => false,
    ignoreCSSAttributes,
    doc,
  } = options;
  // serializeNodeHead only turns this off for <head>, which has no hooks below
  const { preserveWhiteSpace = true } = options;
  const parent = dom.parentNode(n);
  if (parent && isShadowRoot(parent) && isNativeShadowDom(parent)) {
    serializedNode.isShadow = true;
  }

  if (
    serializedNode.type === NodeType.Element &&
    serializedNode.tagName === 'iframe' &&
    !serializedNode.needBlock &&
    !_isBlockedElement(
      n as HTMLElement,
      blockClass,
      blockSelector,
      unblockSelector,
    )
  ) {
    onceIframeLoaded(
      n as HTMLIFrameElement,
      () => {
        const iframeDoc = getIFrameContentDocument(n as HTMLIFrameElement);
        if (iframeDoc && onIframeLoad) {
          const serializedIframeNode = serializeNodeWithId(iframeDoc, {
            doc: iframeDoc,
            mirror,
            blockClass,
            blockSelector,
            unblockSelector,
            maskAllText,
            maskTextClass,
            unmaskTextClass,
            maskTextSelector,
            unmaskTextSelector,
            skipChild: false,
            inlineStylesheet,
            maskInputOptions,
            maskAttributeFn,
            maskTextFn,
            maskInputFn,
            slimDOMOptions,
            dataURLOptions,
            inlineImages,
            recordCanvas,
            preserveWhiteSpace,
            onSerialize,
            onIframeLoad,
            iframeLoadTimeout,
            onStylesheetLoad,
            stylesheetLoadTimeout,
            keepIframeSrcFn,
            ignoreCSSAttributes,
          });

          if (serializedIframeNode) {
            onIframeLoad(
              n as HTMLIFrameElement,
              serializedIframeNode as serializedElementNodeWithId,
            );
          }
        }
      },
      iframeLoadTimeout,
    );
  }

  if (
    serializedNode.type === NodeType.Element &&
    serializedNode.tagName === 'img' &&
    !(n as HTMLImageElement).complete &&
    serializedNode.needBlock
  ) {
    const image = n as HTMLImageElement;
    const updateImageDimensions = () => {
      // Check if the element is still in the DOM and not already complete
      if (image.isConnected && !image.complete && onBlockedImageLoad) {
        try {
          const rect = image.getBoundingClientRect();
          // Only proceed if we have valid dimensions
          if (rect.width > 0 && rect.height > 0) {
            onBlockedImageLoad(image, serializedNode, rect);
          }
        } catch (error) {
          // Silently handle errors from getBoundingClientRect
        }
      }
      image.removeEventListener('load', updateImageDimensions);
    };

    // Only add listener if element is still in DOM
    if (image.isConnected) {
      image.addEventListener('load', updateImageDimensions);
    }
  }

  // <link rel=stylesheet href=...>
  if (
    serializedNode.type === NodeType.Element &&
    serializedNode.tagName === 'link' &&
    typeof serializedNode.attributes.rel === 'string' &&
    (serializedNode.attributes.rel === 'stylesheet' ||
      (serializedNode.attributes.rel === 'preload' &&
        typeof serializedNode.attributes.href === 'string' &&
        extractFileExtension(serializedNode.attributes.href) === 'css'))
  ) {
    onceStylesheetLoaded(
      n as HTMLLinkElement,
      () => {
        if (onStylesheetLoad) {
          const serializedLinkNode = serializeNodeWithId(n, {
            doc,
            mirror,
            blockClass,
            blockSelector,
            unblockSelector,
            maskAllText,
            maskTextClass,
            unmaskTextClass,
            maskTextSelector,
            unmaskTextSelector,
            skipChild: false,
            inlineStylesheet,
            maskInputOptions,
            maskAttributeFn,
            maskTextFn,
            maskInputFn,
            slimDOMOptions,
            dataURLOptions,
            inlineImages,
            recordCanvas,
            preserveWhiteSpace,
            onSerialize,
            onIframeLoad,
            iframeLoadTimeout,
            onStylesheetLoad,
            stylesheetLoadTimeout,
            keepIframeSrcFn,
            ignoreCSSAttributes,
          });

          if (serializedLinkNode) {
            onStylesheetLoad(
              n as HTMLLinkElement,
              serializedLinkNode as serializedElementNodeWithId,
            );
          }
        }
      },
      stylesheetLoadTimeout,
    );
  }

  if (serializedNode.type === NodeType.Element) {
    // this property was not needed in replay side
    delete serializedNode.needBlock;
  }
}

/** Serialize the light-DOM and shadow children of a node (synchronous walk). */
function serializeChildren(
  n: Node,
  serializedNode: serializedNodeWithId,
  childOptions: SerializeNodeOptions,
  skipLightChildren: boolean,
) {
  if (
    serializedNode.type !== NodeType.Document &&
    serializedNode.type !== NodeType.Element
  )
    return;
  if (!skipLightChildren) {
    for (const childN of Array.from(dom.childNodes(n))) {
      const serializedChildNode = serializeNodeWithId(childN, childOptions);
      if (serializedChildNode) {
        serializedNode.childNodes.push(serializedChildNode);
      }
    }
  }

  let shadowRootEl: ShadowRoot | null = null;
  if (isElement(n) && (shadowRootEl = dom.shadowRoot(n))) {
    for (const childN of Array.from(dom.childNodes(shadowRootEl))) {
      const serializedChildNode = serializeNodeWithId(childN, childOptions);
      if (serializedChildNode) {
        isNativeShadowDom(shadowRootEl) &&
          (serializedChildNode.isShadow = true);
        serializedNode.childNodes.push(serializedChildNode);
      }
    }
  }
}

export function serializeNodeWithId(
  n: Node,
  options: SerializeNodeOptions,
): serializedNodeWithId | null {
  const head = serializeNodeHead(n, options);
  if (!head) return null;
  const { serializedNode, childOptions, skipLightChildren } = head;
  if (childOptions) {
    serializeChildren(n, serializedNode, childOptions, skipLightChildren);
  }
  serializeNodeTail(n, serializedNode, options);
  return serializedNode;
}

/** snapshot()'s options. */
export type SnapshotOptions = {
  mirror?: Mirror;
  blockClass?: string | RegExp;
  blockSelector?: string | null;
  unblockSelector?: string | null;
  maskAllText?: boolean;
  maskTextClass?: string | RegExp;
  unmaskTextClass?: string | RegExp | null;
  maskTextSelector?: string | null;
  unmaskTextSelector?: string | null;
  inlineStylesheet?: boolean;
  maskAllInputs?: boolean | MaskInputOptions;
  maskAttributeFn?: MaskAttributeFn;
  maskTextFn?: MaskTextFn;
  maskInputFn?: MaskInputFn;
  slimDOM?: 'all' | boolean | SlimDOMOptions;
  dataURLOptions?: DataURLOptions;
  inlineImages?: boolean;
  recordCanvas?: boolean;
  preserveWhiteSpace?: boolean;
  onSerialize?: (n: Node) => unknown;
  onIframeLoad?: (
    iframeNode: HTMLIFrameElement,
    node: serializedElementNodeWithId,
  ) => unknown;
  iframeLoadTimeout?: number;
  onBlockedImageLoad?: (
    imageEl: HTMLImageElement,
    node: serializedElementNodeWithId,
    rect: DOMRect,
  ) => unknown;
  onStylesheetLoad?: (
    linkNode: HTMLLinkElement,
    node: serializedElementNodeWithId,
  ) => unknown;
  stylesheetLoadTimeout?: number;
  keepIframeSrcFn?: KeepIframeSrcFn;
  ignoreCSSAttributes?: Set<string>;
  /** RR-030, for this call only (record() uses setAssetHook instead). */
  assetHook?: AssetHook;
};

/** Normalize snapshot() options into what serializeNodeWithId takes. */
function snapshotSerializeOptions(
  n: Document,
  options?: SnapshotOptions,
): SerializeNodeOptions {
  const {
    mirror = new Mirror(),
    blockClass = 'rr-block',
    blockSelector = null,
    unblockSelector = null,
    maskAllText = false,
    maskTextClass = 'rr-mask',
    unmaskTextClass = null,
    maskTextSelector = null,
    unmaskTextSelector = null,
    inlineStylesheet = true,
    inlineImages = false,
    recordCanvas = false,
    maskAllInputs = false,
    maskAttributeFn,
    maskTextFn,
    maskInputFn,
    slimDOM = false,
    dataURLOptions,
    preserveWhiteSpace,
    onSerialize,
    onIframeLoad,
    iframeLoadTimeout,
    onBlockedImageLoad,
    onStylesheetLoad,
    stylesheetLoadTimeout,
    keepIframeSrcFn = () => false,
    ignoreCSSAttributes = new Set([]),
  } = options || {};
  const maskInputOptions: MaskInputOptions =
    maskAllInputs === true
      ? {
          color: true,
          date: true,
          'datetime-local': true,
          email: true,
          month: true,
          number: true,
          range: true,
          search: true,
          tel: true,
          text: true,
          time: true,
          url: true,
          week: true,
          textarea: true,
          select: true,
        }
      : maskAllInputs === false
      ? {}
      : maskAllInputs;
  const slimDOMOptions = slimDOMDefaults(slimDOM);

  return {
    doc: n,
    mirror,
    blockClass,
    blockSelector,
    unblockSelector,
    maskAllText,
    maskTextClass,
    unmaskTextClass,
    maskTextSelector,
    unmaskTextSelector,
    skipChild: false,
    inlineStylesheet,
    maskInputOptions,
    maskAttributeFn,
    maskTextFn,
    maskInputFn,
    slimDOMOptions,
    dataURLOptions,
    inlineImages,
    recordCanvas,
    preserveWhiteSpace,
    onSerialize,
    onIframeLoad,
    iframeLoadTimeout,
    onBlockedImageLoad,
    onStylesheetLoad,
    stylesheetLoadTimeout,
    keepIframeSrcFn,
    newlyAddedElement: false,
    ignoreCSSAttributes,
  };
}

function snapshot(
  n: Document,
  options?: SnapshotOptions,
): serializedNodeWithId | null {
  if (!options?.assetHook)
    return serializeNodeWithId(n, snapshotSerializeOptions(n, options));
  const prev = setAssetHook(options.assetHook);
  try {
    return serializeNodeWithId(n, snapshotSerializeOptions(n, options));
  } finally {
    setAssetHook(prev);
  }
}

/**
 * Cooperative scheduling for snapshotSliced() (Panopticon RR-017): the
 * recorder decides when a slice has used its budget and how to resume.
 */
export interface SnapshotSlicer {
  /** true when the current slice should end before the next node */
  shouldYield(): boolean;
  /** resolves when the next slice may start */
  yieldSlice(): Promise<void>;
  /**
   * Receives `finishNow`, which runs the rest of the walk synchronously (no
   * more yields) and returns the finished snapshot; the promise then
   * resolves with that same node. It returns null when it cannot finish
   * there: called from inside the walk itself (the walk then finishes
   * without yielding), or after the walk failed.
   */
  control?(finishNow: () => serializedNodeWithId | null): void;
}

/**
 * Panopticon item 8: the page as of one instant, to be serialized later
 * (snapshotSliced). freezeDocument() takes, synchronously:
 *  - an inert copy of the document (importNode into a document without a
 *    browsing context: no script, no custom element constructor, no fetch),
 *    which keeps every node, attribute and text value as they were;
 *  - the live nodes in the same pre-order, so copy k stands for live k;
 *  - what a copy does not carry, read from the live nodes: form state,
 *    scroll offsets, media state, modal dialogs, blocked elements' boxes,
 *    readable iframes, defined custom elements, each <style>/<link>'s
 *    CSSStyleSheet object, and canvas pixels (as ImageBitmaps, through the
 *    canvas pixels hook, or synchronously without one);
 *  - every id the synchronous snapshot would give, in the same order, each
 *    node already in the mirror (an empty entry the walk fills), and
 *    onSerialize plus the iframe / stylesheet / blocked image load hooks
 *    run for each node, as the synchronous snapshot runs them.
 * The page then runs between slices: rrweb's observers record every change
 * with its own time against those ids, and the walk serializes the copy,
 * so the result is byte for byte the synchronous snapshot of the instant
 * the freeze was taken. A stylesheet the page edits through the CSSOM
 * before the walk reaches it is read first (noteSheetMutation).
 * Returns null where a copy cannot stand for the page (open shadow roots,
 * adopted stylesheets, inline images, privacy selectors that depend on
 * state a copy does not have): the caller takes the synchronous snapshot.
 */
export type FrozenDocument = {
  /** live nodes, pre-order; [0] is the document */
  live: Node[];
  /** copies of the document's children (a doctype is its own copy) */
  roots: Node[];
  /** mirror entry by index (null: no id, under a skipped subtree) */
  shells: Array<serializedNodeWithId | null>;
  /** index after each node's subtree */
  end: Int32Array;
  mirror: Mirror;
  options: SerializeNodeOptions;
  form: Map<Node, { value: string; checked: boolean; selected: boolean }>;
  scroll: Map<Node, { scrollLeft: number; scrollTop: number }>;
  media: Map<Node, { paused: boolean; currentTime: number }>;
  modal: Set<Node>;
  rect: Map<Node, { width: number; height: number }>;
  iframeDoc: Set<Node>;
  custom: Map<string, boolean>;
  sheets: Map<Node, CSSStyleSheet | null>;
  /** CSSOM text as of the freeze ('' when unreadable) */
  sheetText: Map<CSSStyleSheet, string>;
  /** base URL each sheet's rules resolve against, as of the freeze */
  sheetHref: Map<CSSStyleSheet, string | null>;
  /** a sheet being stringified rule by rule across slices */
  job: {
    sheet: CSSStyleSheet;
    rules: CSSRule[];
    i: number;
    parts: string[];
  } | null;
  canvas: Map<Node, { url: string | null | undefined; target?: attributes }>;
  /** canvas pixels still on their way */
  pending: number;
  onPixels: (() => void) | null;
};

let frozenNow: {
  f: FrozenDocument;
  k: number;
  live: Node;
  mirror: Mirror;
} | null = null;
/** Frozen snapshots still walking, for noteSheetMutation. */
const walkingFrozen = new Set<FrozenDocument>();

/**
 * Called by rrweb's CSSOM patches before a stylesheet changes: a frozen
 * snapshot that has not serialized that sheet yet reads it now, so it
 * serializes the rules it had when the freeze was taken.
 */
export function noteSheetMutation(
  sheet: CSSStyleSheet | null | undefined,
): void {
  if (!sheet || !walkingFrozen.size) return;
  let root: CSSStyleSheet = sheet;
  for (let i = 0; root.parentStyleSheet && i < 32; i++)
    root = root.parentStyleSheet;
  for (const f of walkingFrozen)
    if (!f.sheetText.has(root) && f.sheetHref.has(root))
      frozenSheetText(f, root);
}

/** The base URL stringifyStylesheet() resolves a sheet's rules against. */
function sheetBase(sh: CSSStyleSheet): string | null {
  let href = sh.href;
  if (!href && sh.ownerNode) href = (sh.ownerNode as Node).baseURI;
  return href;
}

/** A frozen sheet's text: stringifyStylesheet() as of the freeze. */
function frozenSheetText(
  f: FrozenDocument,
  sheet: CSSStyleSheet,
): string | null {
  let t = f.sheetText.get(sheet);
  if (t === undefined) {
    if (!f.job || f.job.sheet !== sheet) startSheetJob(f, sheet);
    finishSheetJob(f, () => false);
    t = f.sheetText.get(sheet) ?? '';
  }
  return t || null;
}

function startSheetJob(f: FrozenDocument, sheet: CSSStyleSheet) {
  let rules: CSSRule[] | null = null;
  try {
    const r = sheet.rules || sheet.cssRules;
    if (r) rules = Array.from(r);
  } catch {
    rules = null; // cross-origin: stringifyStylesheet gives null too
  }
  if (!rules) {
    f.sheetText.set(sheet, '');
    f.job = null;
    return;
  }
  f.job = { sheet, rules, i: 0, parts: [] };
}

/** Stringify rules until done (true) or until `stop()` says the slice is over. */
function finishSheetJob(f: FrozenDocument, stop: () => boolean): boolean {
  const j = f.job;
  if (!j) return true;
  const href = f.sheetHref.get(j.sheet) ?? null;
  try {
    while (j.i < j.rules.length) {
      j.parts.push(stringifyRule(j.rules[j.i++], href));
      if (j.i < j.rules.length && stop()) return false;
    }
    f.sheetText.set(
      j.sheet,
      fixBrowserCompatibilityIssuesInCSS(j.parts.join('')),
    );
  } catch {
    f.sheetText.set(j.sheet, '');
  }
  f.job = null;
  return true;
}

/**
 * Pseudo-classes a copy matches exactly as the live page does: they read the
 * tree and attributes only. Any other pseudo-class or pseudo-element in a
 * privacy selector (element state such as :hover, :checked on an <option>,
 * :indeterminate, custom states, :root on a detached copy, or anything not
 * known here) makes the freeze give up, so the synchronous snapshot decides
 * block and mask on the live page. Fails closed: a token this cannot read
 * (an escape, a ':' inside an attribute value) also gives up.
 */
const COPY_SAFE_PSEUDO = new Set([
  'is',
  'where',
  'not',
  'has',
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'only-of-type',
  'empty',
]);

export function selectorMatchesOnCopy(sel: string): boolean {
  for (const m of sel.matchAll(/:(:?)([-\w]*)/g))
    if (m[1] || !COPY_SAFE_PSEUDO.has(m[2].toLowerCase())) return false;
  return true;
}

const FROZEN_ABORT = new Error('rrweb-snapshot: page cannot be frozen');
const SHADOW_HOSTS = new Set([
  'article',
  'aside',
  'blockquote',
  'body',
  'div',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'main',
  'nav',
  'p',
  'section',
  'span',
]);

/** Element.prototype.shadowRoot's getter from rrweb's untainted prototype. */
function untaintedShadowGetter():
  | ((this: Element) => ShadowRoot | null)
  | null {
  try {
    const get = Object.getOwnPropertyDescriptor(
      dom.getUntaintedPrototype('Element'),
      'shadowRoot',
    )?.get;
    return (get as (this: Element) => ShadowRoot | null) || null;
  } catch {
    return null;
  }
}

export function freezeDocument(
  n: Document,
  options?: SnapshotOptions,
): FrozenDocument | null {
  const o = snapshotSerializeOptions(n, options);
  if (o.inlineImages) return null;
  for (const sel of [
    o.blockSelector,
    o.unblockSelector,
    o.maskTextSelector,
    o.unmaskTextSelector,
  ])
    if (sel && !selectorMatchesOnCopy(sel)) return null;
  if (n.adoptedStyleSheets && n.adoptedStyleSheets.length) return null;
  const slim = o.slimDOMOptions;
  // node kinds: 0 no id (skipped), 1 id, 2 ignored (IGNORED_NODE)
  const live: Node[] = [];
  const kind: number[] = [];
  const endAt: number[] = [];
  const tails: number[] = [];
  const preserveWS: boolean[] = [];
  const blocked: boolean[] = [];
  const f: FrozenDocument = {
    live,
    roots: [],
    shells: [],
    end: null as unknown as Int32Array,
    mirror: o.mirror,
    options: o,
    form: new Map(),
    scroll: new Map(),
    media: new Map(),
    modal: new Set(),
    rect: new Map(),
    iframeDoc: new Set(),
    custom: new Map(),
    sheets: new Map(),
    sheetText: new Map(),
    sheetHref: new Map(),
    job: null,
    canvas: new Map(),
    pending: 0,
    onPixels: null,
  };
  const docSheets = Array.from(n.styleSheets);
  // Only an element with the block class or matching the block selector can
  // be blocked: one native query instead of a match per element.
  let blockCandidates: Set<Element> | null = null;
  try {
    if (typeof o.blockClass === 'string') {
      blockCandidates = new Set(
        Array.from(n.getElementsByClassName(o.blockClass)),
      );
      if (o.blockSelector)
        n.querySelectorAll(o.blockSelector).forEach((e) =>
          blockCandidates!.add(e),
        );
    }
  } catch {
    blockCandidates = null; // an invalid selector: the per-element check decides
  }
  // the untainted shadowRoot getter, looked up once
  let shadowGetter: ((this: Element) => ShadowRoot | null) | null = null;
  const probe = n.documentElement || n.body;
  if (probe) {
    dom.shadowRoot(probe);
    shadowGetter = untaintedShadowGetter();
  }
  const shadowOf = (el: Element): ShadowRoot | null =>
    shadowGetter ? shadowGetter.call(el) : dom.shadowRoot(el);
  // phase 1: read only (nothing changes if the page cannot be frozen)
  const visit = (node: Node, skip: boolean, keepWS: boolean) => {
    const k = live.length;
    live.push(node);
    preserveWS.push(keepWS);
    blocked.push(false);
    let childSkip = skip;
    let childWS = keepWS;
    let lightSkip = false;
    if (skip) kind.push(0);
    else {
      const t = node.nodeType;
      if (
        t === node.DOCUMENT_NODE ||
        t === node.DOCUMENT_TYPE_NODE ||
        t === node.CDATA_SECTION_NODE
      )
        kind.push(1);
      else if (t === node.COMMENT_NODE) kind.push(slim.comment ? 2 : 1);
      else if (t === node.TEXT_NODE) {
        // serializeNodeHead drops a whitespace-only text where white space
        // is not kept (<head>); a <style>'s text serializes as '' once its
        // rules were captured as _cssText
        const parent = node.parentNode as HTMLStyleElement | null;
        let captured = false;
        if (!keepWS && parent && parent.tagName === 'STYLE') {
          try {
            captured = !!(parent.sheet && parent.sheet.cssRules.length);
          } catch {
            // unreadable rules: kept as text
          }
        }
        kind.push(
          !keepWS && (captured || !(node.textContent || '').trim().length)
            ? 2
            : 1,
        );
      } else if (t === node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        // only custom elements and these can host a shadow root
        // (DOM attachShadow's valid shadow host names)
        if (
          (el.localName.includes('-') || SHADOW_HOSTS.has(el.localName)) &&
          shadowOf(el)
        )
          throw FROZEN_ABORT;
        const tagName =
          el.localName.includes(':') ||
          el.localName !== el.localName.toLowerCase()
            ? getValidTagName(el)
            : (el.localName as Lowercase<string>);
        let excluded = false;
        if (tagName === 'script' || tagName === 'link' || tagName === 'meta') {
          const a: attributes = {};
          for (const name of ['rel', 'href', 'name', 'property', 'http-equiv'])
            if (el.hasAttribute(name)) a[name] = el.getAttribute(name);
          excluded = slimDOMExcluded(
            { type: NodeType.Element, tagName, attributes: a, childNodes: [] },
            slim,
          );
        }
        if (excluded) {
          kind.push(2);
        } else {
          kind.push(1);
          const needBlock =
            blockCandidates === null
              ? _isBlockedElement(
                  el,
                  o.blockClass,
                  o.blockSelector,
                  o.unblockSelector,
                )
              : blockCandidates.has(el) &&
                _isBlockedElement(
                  el,
                  o.blockClass,
                  o.blockSelector,
                  o.unblockSelector,
                );
          blocked[k] = needBlock;
          if (el.scrollLeft || el.scrollTop)
            f.scroll.set(el, {
              scrollLeft: el.scrollLeft,
              scrollTop: el.scrollTop,
            });
          if (needBlock) {
            const r = el.getBoundingClientRect();
            f.rect.set(el, { width: r.width, height: r.height });
            childSkip = true;
          }
          if (
            tagName === 'input' ||
            tagName === 'textarea' ||
            tagName === 'select' ||
            tagName === 'option'
          ) {
            const fe = el as HTMLInputElement;
            const value = getInputValue(
              fe,
              toUpperCase(tagName),
              getInputType(fe),
            );
            f.form.set(el, {
              value,
              checked: fe.checked,
              selected: !!(el as unknown as HTMLOptionElement).selected,
            });
            if (tagName === 'textarea' && value) lightSkip = true;
          } else if (tagName === 'audio' || tagName === 'video') {
            const me = el as HTMLMediaElement;
            f.media.set(el, { paused: me.paused, currentTime: me.currentTime });
          } else if (tagName === 'dialog') {
            if ((el as HTMLDialogElement).open && el.matches('dialog:modal'))
              f.modal.add(el);
          } else if (tagName === 'iframe') {
            if (getIFrameContentDocument(el as HTMLIFrameElement))
              f.iframeDoc.add(el);
          } else if (tagName === 'style') {
            const sh = (el as HTMLStyleElement).sheet as CSSStyleSheet | null;
            f.sheets.set(el, sh);
            if (sh) f.sheetHref.set(sh, sheetBase(sh));
          } else if (tagName === 'link' && o.inlineStylesheet) {
            const href = (el as HTMLLinkElement).href;
            const sh = docSheets.find((x) => x.href === href) || null;
            f.sheets.set(el, sh);
            if (sh) f.sheetHref.set(sh, sheetBase(sh));
          } else if (tagName === 'head' && slim.headWhitespace) {
            childWS = false;
          }
          if (tagName.includes('-') && !f.custom.has(tagName)) {
            try {
              f.custom.set(tagName, !!customElements.get(tagName));
            } catch {
              f.custom.set(tagName, false);
            }
          }
          if (tagName === 'iframe' || tagName === 'img' || tagName === 'link')
            tails.push(k);
        }
        if (excluded) childSkip = true;
      } else kind.push(0); // not serialized by rrweb either
      if (kind[k] === 2) childSkip = true;
    }
    for (let c = node.firstChild; c; c = c.nextSibling)
      visit(c, childSkip || (lightSkip && !childSkip), childWS);
    endAt[k] = live.length;
  };
  try {
    visit(n, false, o.preserveWhiteSpace !== false);
  } catch (err) {
    if (err === FROZEN_ABORT) return null;
    throw err;
  }
  // the inert copy, in the same pre-order (index 0 stands for the document)
  const inert = n.implementation.createHTMLDocument('');
  try {
    for (let c = n.firstChild; c; c = c.nextSibling)
      f.roots.push(
        c.nodeType === c.DOCUMENT_TYPE_NODE ? c : inert.importNode(c, true),
      );
  } catch {
    return null;
  }
  f.end = Int32Array.from(endAt);
  // phase 2: ids, mirror entries, hooks and pixels, in the synchronous order
  for (let k = 0; k < live.length; k++) {
    const node = live[k];
    if (kind[k] === 0) {
      f.shells.push(null);
      continue;
    }
    const shell = {
      id: kind[k] === 2 ? IGNORED_NODE : genId(),
    } as serializedNodeWithId;
    f.shells.push(shell);
    o.mirror.add(node, shell);
    if (kind[k] === 2) continue;
    // the recorder's onSerialize registers iframes, stylesheet links and
    // shadow hosts (none here: those pages are not frozen); it does
    // nothing for any other node
    if (o.onSerialize && node.nodeType === node.ELEMENT_NODE) {
      const ln = (node as Element).localName;
      if (ln === 'iframe' || ln === 'link') o.onSerialize(node);
    }
    if (
      o.recordCanvas &&
      !blocked[k] &&
      (node as Element).localName === 'canvas'
    )
      freezeCanvas(f, node as HTMLCanvasElement, o.dataURLOptions || {});
  }
  // load hooks after the children, as serializeNodeTail runs them
  for (const k of tails) {
    const el = live[k] as HTMLElement;
    const tagName = el.localName;
    if (tagName !== 'iframe' && tagName !== 'img' && tagName !== 'link')
      continue;
    const shell = f.shells[k]!;
    Object.assign(shell, {
      type: NodeType.Element,
      tagName,
      attributes: {
        rel: el.getAttribute('rel'),
        href: el.getAttribute('href'),
      },
      childNodes: [],
      needBlock: blocked[k] || undefined,
    });
    serializeNodeTail(el, shell, { ...o, preserveWhiteSpace: preserveWS[k] });
  }
  return f;
}

/** A canvas's pixels as of the freeze. */
function freezeCanvas(
  f: FrozenDocument,
  canvas: HTMLCanvasElement,
  dataURLOptions: DataURLOptions,
) {
  const slot: { url: string | null | undefined; target?: attributes } = {
    url: undefined,
  };
  f.canvas.set(canvas, slot);
  const hookAtFreeze = assetHook;
  const taken =
    canvasPixelsHook &&
    canvasPixelsHook(canvas, dataURLOptions, (dataURL) => {
      slot.url = dataURL;
      if (slot.target && dataURL !== null) {
        slot.target.rr_dataURL = dataURL;
        if (hookAtFreeze) deferredAssets.push([slot.target, hookAtFreeze]);
      }
      f.pending--;
      if (f.pending === 0 && f.onPixels) f.onPixels();
    });
  if (taken) {
    f.pending++;
    return;
  }
  // no worker: read them now, as serializeElementNode would
  const probe: attributes = {};
  canvasDataURLNow(canvas, dataURLOptions, probe);
  slot.url = typeof probe.rr_dataURL === 'string' ? probe.rr_dataURL : null;
}

/**
 * snapshot(), serialized in slices of a frozen copy of the page
 * (freezeDocument; without one it freezes the page now). Nodes are visited
 * in serializeNodeWithId's order and the walk may pause between any two;
 * the copy never changes, so the result is the synchronous snapshot of the
 * freeze, byte for byte. A page that cannot be frozen gets the synchronous
 * snapshot right away.
 */
export async function snapshotSliced(
  n: Document,
  options: SnapshotOptions | undefined,
  slicer: SnapshotSlicer,
  frozen?: FrozenDocument | null,
): Promise<serializedNodeWithId | null> {
  const f = frozen === undefined ? freezeDocument(n, options) : frozen;
  if (!f) {
    const node = snapshot(n, options);
    slicer.control?.(() => node);
    return node;
  }
  const rootOptions = f.options;
  frozenNow = { f, k: 0, live: n, mirror: f.mirror };
  let root: ReturnType<typeof serializeNodeHead>;
  try {
    root = serializeNodeHead(n, rootOptions);
  } finally {
    frozenNow = null;
  }
  if (!root || !root.childOptions) return root ? root.serializedNode : null;
  type Frame = {
    sn: serializedNodeWithId;
    childOptions: SerializeNodeOptions;
    kids: ArrayLike<Node>;
    i: number;
    k: number;
  };
  const stack: Frame[] = [
    {
      sn: root.serializedNode,
      childOptions: root.childOptions,
      kids: f.roots,
      i: 0,
      k: 1,
    },
  ];
  walkingFrozen.add(f);
  let forced = false;
  let walking = false;
  let done = false;
  let failed = false;
  const walk = (): boolean => {
    walking = true;
    try {
      while (stack.length) {
        const fr = stack[stack.length - 1];
        if (fr.i >= fr.kids.length) {
          stack.pop();
          continue;
        }
        // a stylesheet's rules are stringified in slices of their own before
        // its <style>/<link> is serialized (a large sheet is the longest
        // single piece of a snapshot); a CSSOM change meanwhile finishes it
        // first (noteSheetMutation)
        const sheet = f.sheets.get(f.live[fr.k]);
        if (sheet && !f.sheetText.has(sheet)) {
          if (!f.job || f.job.sheet !== sheet) startSheetJob(f, sheet);
          if (!finishSheetJob(f, () => !forced && slicer.shouldYield()))
            return false;
          if (!forced && slicer.shouldYield()) return false;
        }
        const c = fr.kids[fr.i++];
        const k = fr.k;
        fr.k = f.end[k];
        const liveNode = f.live[k];
        if (!liveNode || liveNode.nodeName !== c.nodeName)
          throw new Error('rrweb-snapshot: frozen copy out of step');
        frozenNow = { f, k, live: liveNode, mirror: f.mirror };
        let head: ReturnType<typeof serializeNodeHead>;
        try {
          head = serializeNodeHead(c, fr.childOptions);
        } finally {
          frozenNow = null;
        }
        if (head) {
          (fr.sn as { childNodes: serializedNodeWithId[] }).childNodes.push(
            head.serializedNode,
          );
          if (head.serializedNode.type === NodeType.Element)
            delete head.serializedNode.needBlock;
          if (
            head.childOptions &&
            (head.serializedNode.type === NodeType.Element ||
              head.serializedNode.type === NodeType.Document)
          )
            stack.push({
              sn: head.serializedNode,
              childOptions: head.childOptions,
              kids: head.skipLightChildren ? [] : Array.from(c.childNodes),
              i: 0,
              k: k + 1,
            });
        }
        if (!forced && slicer.shouldYield()) return false;
      }
      done = true;
      walkingFrozen.delete(f);
      return true;
    } catch (err) {
      failed = true;
      walkingFrozen.delete(f);
      throw err;
    } finally {
      walking = false;
    }
  };
  slicer.control?.(() => {
    if (done) return root!.serializedNode;
    forced = true;
    if (walking || failed) return null;
    walk();
    return root!.serializedNode;
  });
  try {
    while (!walk()) {
      await slicer.yieldSlice();
      // finishNow() ran while the page had its turn
      if (done) break;
    }
  } finally {
    walkingFrozen.delete(f);
  }
  return root.serializedNode;
}

export function visitSnapshot(
  node: serializedNodeWithId,
  onVisit: (node: serializedNodeWithId) => unknown,
) {
  function walk(current: serializedNodeWithId) {
    onVisit(current);
    if (
      current.type === NodeType.Document ||
      current.type === NodeType.Element
    ) {
      current.childNodes.forEach(walk);
    }
  }

  walk(node);
}

export function cleanupSnapshot() {
  // allow a new recording to start numbering nodes from scratch
  _id = 1;
}

export default snapshot;
