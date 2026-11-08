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

/** Hand the element's large values to the asset hook (RR-030). */
function applyAssetHook(attributes: attributes, hook: AssetHook) {
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
    const stylesheet = Array.from(doc.styleSheets).find((s) => {
      return s.href === (n as HTMLLinkElement).href;
    });
    let cssText: string | null = null;
    if (stylesheet) {
      cssText = stringifyStylesheet(stylesheet);
    }
    if (cssText) {
      attributes.rel = null;
      attributes.href = null;
      attributes.crossorigin = null;
      attributes._cssText = absoluteToStylesheet(cssText, stylesheet!.href!);
    }
  }
  if (tagName === 'style' && (n as HTMLStyleElement).sheet) {
    let cssText = stringifyStylesheet(
      (n as HTMLStyleElement).sheet as CSSStyleSheet,
    );
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
    const value = getInputValue(el, toUpperCase(tagName), type);
    const checked = (el as HTMLInputElement).checked;
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
    if ((n as HTMLOptionElement).selected && !maskInputOptions['select']) {
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
    (attributes as DialogAttributes).rr_open_mode = n.matches('dialog:modal')
      ? 'modal'
      : 'non-modal';
  }

  // canvas image data
  if (tagName === 'canvas' && recordCanvas) {
    if ((n as ICanvas).__context === '2d') {
      // only record this on 2d canvas
      if (!is2DCanvasBlank(n as HTMLCanvasElement)) {
        attributes.rr_dataURL = (n as HTMLCanvasElement).toDataURL(
          dataURLOptions.type,
          dataURLOptions.quality,
        );
      }
    } else if (!('__context' in n)) {
      // context is unknown, better not call getContext to trigger it
      const canvasDataURL = (n as HTMLCanvasElement).toDataURL(
        dataURLOptions.type,
        dataURLOptions.quality,
      );

      // create blank canvas of same dimensions
      const blankCanvas = doc.createElement('canvas');
      blankCanvas.width = (n as HTMLCanvasElement).width;
      blankCanvas.height = (n as HTMLCanvasElement).height;
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
    mediaAttributes.rr_mediaState = (n as HTMLMediaElement).paused
      ? 'paused'
      : 'played';
    attributes.rr_mediaCurrentTime = (n as HTMLMediaElement).currentTime;
  }
  // Scroll
  if (!newlyAddedElement) {
    // `scrollTop` and `scrollLeft` are expensive calls because they trigger reflow.
    // Since `scrollTop` & `scrollLeft` are always 0 when an element is added to the DOM.
    // And scrolls also get picked up by rrweb's ScrollObserver
    // So we can safely skip the `scrollTop/Left` calls for newly added elements
    if (n.scrollLeft) {
      attributes.rr_scrollLeft = n.scrollLeft;
    }
    if (n.scrollTop) {
      attributes.rr_scrollTop = n.scrollTop;
    }
  }
  // block element
  if (needBlock) {
    const { width, height } = n.getBoundingClientRect();
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
    if (!needBlock && !getIFrameContentDocument(n as HTMLIFrameElement)) {
      // we can't record it directly as we can't see into it
      // preserve the src attribute so a decision can be taken at replay time
      attributes.rr_src = attributes.src;
    }
    delete attributes.src; // prevent auto loading
  }

  let isCustomElement: true | undefined;
  try {
    if (customElements.get(tagName)) isCustomElement = true;
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
  if (mirror.hasNode(n)) {
    // Reuse the previous id
    id = mirror.getId(n);
  } else if (
    slimDOMExcluded(_serializedNode, slimDOMOptions) ||
    (!preserveWhiteSpace &&
      _serializedNode.type === NodeType.Text &&
      !_serializedNode.isStyle &&
      !_serializedNode.textContent.trim().length)
  ) {
    id = IGNORED_NODE;
  } else {
    id = genId();
  }

  const serializedNode = Object.assign(_serializedNode, { id });
  // add IGNORED_NODE to mirror to track nextSiblings
  mirror.add(n, serializedNode);

  if (id === IGNORED_NODE) {
    return null; // slimDOM
  }

  if (onSerialize) {
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
 * snapshot(), serialized in slices: an explicit-stack walk that visits nodes
 * in exactly serializeNodeWithId's order (children, then the shadow root,
 * then the node's load hooks) and may pause between any two nodes. Each
 * node is serialized atomically (a stylesheet's text included), so a page
 * that does not change while slicing gets byte-identical output.
 *
 * The page can run between slices. The recorder keeps rrweb's mutation
 * buffers locked meanwhile, so every change is still recorded; here a node
 * that left its parent since the parent's children were listed is skipped
 * (a move re-adds it through the buffer), and a node is never serialized
 * twice.
 */
export async function snapshotSliced(
  n: Document,
  options: SnapshotOptions | undefined,
  slicer: SnapshotSlicer,
): Promise<serializedNodeWithId | null> {
  const rootOptions = snapshotSerializeOptions(n, options);
  const root = serializeNodeHead(n, rootOptions);
  if (!root) return null;
  const seen = new WeakSet<Node>([n]);
  type Frame = {
    n: Node;
    sn: serializedNodeWithId;
    options: SerializeNodeOptions;
    childOptions: SerializeNodeOptions;
    queue: Node[];
    i: number;
    parent: Node;
    shadowStarted: boolean;
    markShadow: boolean;
  };
  const stack: Frame[] = [];
  const finish = (
    node: Node,
    sn: serializedNodeWithId,
    opts: SerializeNodeOptions,
    markShadow: boolean,
  ) => {
    serializeNodeTail(node, sn, opts);
    if (markShadow) sn.isShadow = true;
  };
  const open = (
    node: Node,
    head: NonNullable<ReturnType<typeof serializeNodeHead>>,
    opts: SerializeNodeOptions,
    markShadow: boolean,
  ) => {
    if (
      !head.childOptions ||
      (head.serializedNode.type !== NodeType.Document &&
        head.serializedNode.type !== NodeType.Element)
    ) {
      finish(node, head.serializedNode, opts, markShadow);
      return;
    }
    stack.push({
      n: node,
      sn: head.serializedNode,
      options: opts,
      childOptions: head.childOptions,
      queue: head.skipLightChildren ? [] : Array.from(dom.childNodes(node)),
      i: 0,
      parent: node,
      shadowStarted: false,
      markShadow,
    });
  };
  /**
   * The page ran during the yield: an open ancestor may have become blocked
   * (block class / selector added between slices). Its queued children must
   * not be serialized and the ones already serialized are dropped, so the
   * output is what a synchronous snapshot taken now gives for that element:
   * the blocked placeholder, no children (privacy, TOCTOU). The dropped
   * nodes leave the mirror too, so later text / attribute mutations of them
   * are filtered out like for any node a snapshot never saw.
   */
  const { blockClass, blockSelector, unblockSelector, mirror } = rootOptions;
  const recheckBlocked = () => {
    for (let k = 0; k < stack.length; k++) {
      const f = stack[k];
      if (
        !isElement(f.n) ||
        !_isBlockedElement(
          f.n as HTMLElement,
          blockClass,
          blockSelector,
          unblockSelector,
        )
      )
        continue;
      stack.length = k;
      forgetChildren(f.sn, mirror);
      // same id (the mirror has the node), no second onSerialize
      const head = serializeNodeHead(f.n, { ...f.options, onSerialize: undefined });
      const sn = f.sn as unknown as Record<string, unknown>;
      for (const key of Object.keys(sn)) delete sn[key];
      if (head) Object.assign(sn, head.serializedNode);
      finish(f.n, f.sn, f.options, f.markShadow);
      return;
    }
  };
  let forced = false;
  let walking = false;
  let done = false;
  let failed = false;
  /** Walk until the end (true) or until a slice should yield (false). */
  const walk = (): boolean => {
    walking = true;
    try {
      while (stack.length) {
        const f = stack[stack.length - 1];
        if (f.i < f.queue.length) {
          const child = f.queue[f.i++];
          // listed when the parent was visited; the page may have moved it since
          if (seen.has(child) || dom.parentNode(child) !== f.parent) continue;
          seen.add(child);
          const head = serializeNodeHead(child, f.childOptions);
          if (head) {
            (f.sn as { childNodes: serializedNodeWithId[] }).childNodes.push(
              head.serializedNode,
            );
            const shadowChild =
              f.parent !== f.n && isNativeShadowDom(f.parent as ShadowRoot);
            open(child, head, f.childOptions, shadowChild);
          }
          if (!forced && slicer.shouldYield()) return false;
          continue;
        }
        if (!f.shadowStarted) {
          f.shadowStarted = true;
          let shadowRootEl: ShadowRoot | null = null;
          if (isElement(f.n) && (shadowRootEl = dom.shadowRoot(f.n))) {
            f.queue = Array.from(dom.childNodes(shadowRootEl));
            f.i = 0;
            f.parent = shadowRootEl;
            continue;
          }
        }
        stack.pop();
        finish(f.n, f.sn, f.options, f.markShadow);
      }
      done = true;
      return true;
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      walking = false;
    }
  };
  open(n, root, rootOptions, false);
  slicer.control?.(() => {
    if (done) return root.serializedNode;
    forced = true;
    if (walking || failed) return null;
    // the page ran since the last slice, as after any yield
    recheckBlocked();
    walk();
    return root.serializedNode;
  });
  while (!walk()) {
    await slicer.yieldSlice();
    // finishNow() ran while the page had its turn
    if (done) break;
    recheckBlocked();
  }
  return root.serializedNode;
}

/** Remove every node serialized under `sn` from the mirror (not `sn` itself). */
function forgetChildren(sn: serializedNodeWithId, mirror: Mirror) {
  if (sn.type !== NodeType.Document && sn.type !== NodeType.Element) return;
  for (const child of sn.childNodes) {
    forgetChildren(child, mirror);
    const node = mirror.getNode(child.id);
    if (node) mirror.removeNodeFromMap(node);
  }
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
