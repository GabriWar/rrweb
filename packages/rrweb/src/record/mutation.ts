import {
  serializeNodeWithId,
  transformAttribute,
  IGNORED_NODE,
  ignoreAttribute,
  isShadowRoot,
  needMaskingText,
  maskInputValue,
  isNativeShadowDom,
  getInputType,
  toLowerCase,
  getInputValue,
  shouldMaskInput,
} from 'rrweb-snapshot';
import type { observerParam, MutationBufferParam } from '../types';
import type {
  mutationRecord,
  textCursor,
  attributeCursor,
  removedNodeMutation,
  addedNodeMutation,
  IWindow,
} from '@rrweb/types';
import {
  isBlocked,
  isAncestorRemoved,
  isIgnored,
  isSerialized,
  hasShadowRoot,
  isSerializedIframe,
  isSerializedStylesheet,
  inDom,
  getShadowHost,
  closestElementOfNode,
  onRequestAnimationFrame,
  setTimeout,
  clearTimeout,
} from '../utils';
import dom from '@rrweb/utils';
import { StyleDeclarationParser } from './style-declaration-parser';

import { getIFrameContentDocument, getIFrameContentWindow } from 'rrdom';

const moveKey = (id: number, parentId: number) => `${id}@${parentId}`;

/**
 * Per-frame mutation coalescing (Panopticon RR-016). When enabled by
 * record({ coalesceMutations: true }), a MutationObserver callback only
 * buffers its records; every buffer with pending records is emitted once,
 * on the next animation frame (or after COALESCE_FALLBACK_MS when no frame
 * comes, e.g. a hidden tab), as one mutation event. The recorder flushes
 * synchronously before emitting any other event, before a full snapshot and
 * on stop, so the stream order is the same as without coalescing.
 */
const COALESCE_FALLBACK_MS = 100;
let coalesceMutations = false;
const pendingBuffers = new Set<MutationBuffer>();
let flushScheduled = false;
let flushing = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

export function setMutationCoalescing(enabled: boolean) {
  coalesceMutations = enabled;
  if (!enabled) flushCoalescedMutations();
}

export function hasCoalescedMutations(): boolean {
  return pendingBuffers.size > 0 && !flushing;
}

/** Emit every buffered frame's mutations now (no-op when nothing is pending). */
export function flushCoalescedMutations() {
  flushScheduled = false;
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  if (!pendingBuffers.size || flushing) return;
  flushing = true;
  const benchStart =
    typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__
      ? performance.now()
      : 0;
  try {
    const buffers = Array.from(pendingBuffers);
    pendingBuffers.clear();
    buffers.forEach((buf) => buf.emit());
  } finally {
    flushing = false;
  }
  if (typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__) {
    performance.measure('pano:rec:mutation', {
      start: benchStart,
      end: performance.now(),
    });
  }
}

function scheduleCoalescedFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  const hidden =
    typeof document !== 'undefined' && document.visibilityState === 'hidden';
  // rAF does not run in hidden tabs; the timer also covers a tab that is
  // hidden after this frame was requested.
  if (!hidden) onRequestAnimationFrame(flushCoalescedMutations);
  fallbackTimer = setTimeout(flushCoalescedMutations, COALESCE_FALLBACK_MS);
}

/**
 * controls behaviour of a MutationObserver
 */
export default class MutationBuffer {
  private frozen = false;
  private locked = false;

  private texts: textCursor[] = [];
  private attributes: attributeCursor[] = [];
  private attributeMap = new WeakMap<Node, attributeCursor>();
  private removes: removedNodeMutation[] = [];
  private mapRemoves: Node[] = [];

  private movedMap: Record<string, true> = {};

  /**
   * the browser MutationObserver emits multiple mutations after
   * a delay for performance reasons, making tracing added nodes hard
   * in our `processMutations` callback function.
   * For example, if we append an element el_1 into body, and then append
   * another element el_2 into el_1, these two mutations may be passed to the
   * callback function together when the two operations were done.
   * Generally we need to trace child nodes of newly added nodes, but in this
   * case if we count el_2 as el_1's child node in the first mutation record,
   * then we will count el_2 again in the second mutation record which was
   * duplicated.
   * To avoid of duplicate counting added nodes, we use a Set to store
   * added nodes and its child nodes during iterate mutation records. Then
   * collect added nodes from the Set which have no duplicate copy. But
   * this also causes newly added nodes will not be serialized with id ASAP,
   * which means all the id related calculation should be lazy too.
   */
  private addedSet = new Set<Node>();
  private movedSet = new Set<Node>();
  private droppedSet = new Set<Node>();
  private removesSubTreeCache = new Set<Node>();

  private mutationCb: observerParam['mutationCb'];
  private blockClass: observerParam['blockClass'];
  private blockSelector: observerParam['blockSelector'];
  private unblockSelector: observerParam['unblockSelector'];
  private maskAllText: observerParam['maskAllText'];
  private maskTextClass: observerParam['maskTextClass'];
  private unmaskTextClass: observerParam['unmaskTextClass'];
  private maskTextSelector: observerParam['maskTextSelector'];
  private unmaskTextSelector: observerParam['unmaskTextSelector'];
  private inlineStylesheet: observerParam['inlineStylesheet'];
  private maskInputOptions: observerParam['maskInputOptions'];
  private maskAttributeFn: observerParam['maskAttributeFn'];
  private maskTextFn: observerParam['maskTextFn'];
  private maskInputFn: observerParam['maskInputFn'];
  private keepIframeSrcFn: observerParam['keepIframeSrcFn'];
  private recordCanvas: observerParam['recordCanvas'];
  private inlineImages: observerParam['inlineImages'];
  private slimDOMOptions: observerParam['slimDOMOptions'];
  private dataURLOptions: observerParam['dataURLOptions'];
  private doc: observerParam['doc'];
  private mirror: observerParam['mirror'];

  // managers: convenience references to per-recording singletons
  private iframeManager: observerParam['iframeManager'];
  private stylesheetManager: observerParam['stylesheetManager'];
  private shadowDomManager: observerParam['shadowDomManager'];
  private processedNodeManager: observerParam['processedNodeManager'];
  private canvasManager: observerParam['canvasManager'];
  private ignoreCSSAttributes: observerParam['ignoreCSSAttributes'];
  private styleDeclarationParser!: StyleDeclarationParser;

  public init(options: MutationBufferParam) {
    (
      [
        'mutationCb',
        'blockClass',
        'blockSelector',
        'unblockSelector',
        'maskAllText',
        'maskTextClass',
        'unmaskTextClass',
        'maskTextSelector',
        'unmaskTextSelector',
        'inlineStylesheet',
        'maskInputOptions',
        'maskAttributeFn',
        'maskTextFn',
        'maskInputFn',
        'keepIframeSrcFn',
        'recordCanvas',
        'inlineImages',
        'slimDOMOptions',
        'dataURLOptions',
        'doc',
        'mirror',
        'iframeManager',
        'stylesheetManager',
        'shadowDomManager',
        'processedNodeManager',
        'canvasManager',
        'ignoreCSSAttributes',
      ] as const
    ).forEach((key) => {
      // just a type trick, the runtime result is correct
      this[key] = options[key] as never;
    });

    this.styleDeclarationParser = new StyleDeclarationParser(this.doc);
  }

  public freeze() {
    this.frozen = true;
  }

  public unfreeze() {
    this.frozen = false;
    this.emit();
  }

  public isFrozen() {
    return this.frozen;
  }

  public lock() {
    this.locked = true;
  }

  public unlock() {
    this.locked = false;
    this.emit();
  }

  public processMutations = (mutations: mutationRecord[]) => {
    const benchStart =
      typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__
        ? performance.now()
        : 0;
    mutations.forEach(this.processMutation); // adds mutations to the buffer
    if (coalesceMutations && !this.locked && !this.frozen) {
      pendingBuffers.add(this);
      scheduleCoalescedFlush();
    } else {
      this.emit(); // clears buffer if not locked/frozen
    }
    if (typeof __PANO_BENCH__ !== 'undefined' && __PANO_BENCH__) {
      performance.measure('pano:rec:mutation', {
        start: benchStart,
        end: performance.now(),
      });
    }
  };

  public emit = () => {
    if (this.frozen || this.locked) {
      return;
    }

    // delay any modification of the mirror until this function
    // so that the mirror for takeFullSnapshot doesn't get mutated while it's event is being processed

    const adds: addedNodeMutation[] = [];
    const addedIds = new Set<number>();

    while (this.mapRemoves.length) {
      this.mirror.removeNodeFromMap(this.mapRemoves.shift()!);
    }

    for (const n of this.movedSet) {
      const parentNode = dom.parentNode(n);
      if (
        this.removesSubTreeCache.has(parentNode as Node) &&
        !this.movedSet.has(parentNode as Node)
      ) {
        continue;
      }
      this.addedSet.add(n);
    }

    let n: Node | null = null;
    let parentNode: Node | null = null;
    let parentId = -1;
    let nextSibling: Node | null = null;
    let ancestorBad = false;
    const missingParents = new Set<Node>();
    const iter = this.addedSet.values();
    let curr = iter.next();
    while (this.addedSet.size) {
      if (n !== null && this.addedSet.has(dom.previousSibling(n) as Node)) {
        // reuse parentNode, parentId, ancestorBad
        nextSibling = n; // n is a good next sibling
        n = dom.previousSibling(n) as Node;
      } else {
        if (!this.addedSet.has(curr.value as Node)) {
          // having the `iter` here rather than picking directly from this.addedSet
          // ensures we don't get caught re-traversing 'tombstones' in the Set
          // (we reuse curr in multiple iterations until it's ancestors and nextSiblings are serialized)
          curr = iter.next();
        }
        n = curr.value as Node;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          parentNode = dom.parentNode(n);
          if (this.addedSet.has(parentNode as Node)) {
            // start at top of added tree so as not to serialize children before their parents (parentId requirement)
            n = parentNode as Node;
            continue;
          }
          break;
        }

        if (missingParents.has(parentNode as Node)) {
          parentNode = null;
        } else if (parentNode) {
          // we have a new parentNode for a 'row' of DOM children
          // perf: we reuse these calculations across all child nodes

          if (!inDom(parentNode)) {
            ancestorBad = true;
          } else {
            ancestorBad =
              isSelfOrAncestorInSet(this.droppedSet, parentNode) ||
              this.removesSubTreeCache.has(parentNode);

            if (ancestorBad && isSelfOrAncestorInSet(this.movedSet, n)) {
              // not bad, just moved
              ancestorBad = false;
            }
          }

          if (this.addedSet.has(dom.lastChild(parentNode) as Node)) {
            // jump instead of crawling nextSibling to nextSibling
            n = dom.lastChild(parentNode) as Node;
            nextSibling = null;
          } else {
            // eslint-disable-next-line no-constant-condition
            while (true) {
              nextSibling = dom.nextSibling(n);
              if (this.addedSet.has(nextSibling as Node)) {
                // keep going as we can't serialize a node before it's next sibling (nextId requirement)
                n = nextSibling as Node;
                continue;
              }
              break;
            }
          }

          parentId = isShadowRoot(parentNode)
            ? this.mirror.getId(getShadowHost(n))
            : this.mirror.getId(parentNode);

          // If the node is the direct child of a shadow root, we treat the shadow host as its parent node.
          if (
            parentId === -1 &&
            parentNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE
          ) {
            const shadowHost = dom.host(parentNode as ShadowRoot);
            parentId = this.mirror.getId(shadowHost);
          }
        }
      }

      this.addedSet.delete(n); // don't re-iterate

      if (!parentNode || parentId === -1) {
        missingParents.add(n); // ensure any added child nodes can also early-out
        continue;
      } else if (ancestorBad) {
        // it's possible we could unify missingParents and this.droppedSet
        // but would need to check the subtleties
        this.droppedSet.add(n);
        continue;
      }

      let cssCaptured = false;
      if (n.nodeType === Node.TEXT_NODE) {
        const parentTag = (parentNode as Element).tagName;
        if (parentTag === 'TEXTAREA') {
          // genTextAreaValueMutation already called via parent
          continue;
        } else if (parentTag === 'STYLE' && addedIds.has(parentId)) {
          // css content will be recorded via parent's _cssText attribute when
          // mutation adds entire <style> element
          cssCaptured = true;
        }
      }

      let nextId = nextSibling ? this.mirror.getId(nextSibling) : null;
      while (nextId === IGNORED_NODE) {
        nextSibling = nextSibling && dom.nextSibling(nextSibling);
        nextId = nextSibling && this.mirror.getId(nextSibling);
      }
      if (nextId === -1) {
        // sibling not included in addedNodes, but
        // no id as not yet serialized?
        console.warn(
          "Couldn't record new node. Couldn't find mirror id for nextSibling:",
          nextSibling,
        );
        n = null; // don't iterate to previousSibling as we haven't successful serialized this node
        continue;
      }
      const sn = serializeNodeWithId(n, {
        doc: this.doc,
        mirror: this.mirror,
        blockClass: this.blockClass,
        blockSelector: this.blockSelector,
        maskAllText: this.maskAllText,
        unblockSelector: this.unblockSelector,
        maskTextClass: this.maskTextClass,
        unmaskTextClass: this.unmaskTextClass,
        maskTextSelector: this.maskTextSelector,
        unmaskTextSelector: this.unmaskTextSelector,
        skipChild: true,
        newlyAddedElement: true,
        inlineStylesheet: this.inlineStylesheet,
        maskInputOptions: this.maskInputOptions,
        maskAttributeFn: this.maskAttributeFn,
        maskTextFn: this.maskTextFn,
        maskInputFn: this.maskInputFn,
        slimDOMOptions: this.slimDOMOptions,
        dataURLOptions: this.dataURLOptions,
        recordCanvas: this.recordCanvas,
        inlineImages: this.inlineImages,
        onSerialize: (currentN) => {
          if (
            isSerializedIframe(currentN, this.mirror) &&
            !isBlocked(
              currentN,
              this.blockClass,
              this.blockSelector,
              this.unblockSelector,
              false,
            )
          ) {
            this.iframeManager.addIframe(currentN as HTMLIFrameElement);
          }
          if (isSerializedStylesheet(currentN, this.mirror)) {
            this.stylesheetManager.trackLinkElement(
              currentN as HTMLLinkElement,
            );
          }
          if (hasShadowRoot(n as Node)) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.shadowDomManager.addShadowRoot(
              dom.shadowRoot(n as Node)!,
              this.doc,
            );
          }
        },
        onIframeLoad: (iframe, childSn) => {
          if (
            isBlocked(
              iframe,
              this.blockClass,
              this.blockSelector,
              this.unblockSelector,
              false,
            )
          ) {
            return;
          }

          this.iframeManager.attachIframe(iframe, childSn);
          const contentWindow = getIFrameContentWindow(iframe);
          if (contentWindow) {
            this.canvasManager.addWindow(contentWindow as IWindow);
          }
          this.shadowDomManager.observeAttachShadow(iframe);
        },
        onStylesheetLoad: (link, childSn) => {
          this.stylesheetManager.attachLinkElement(link, childSn);
        },
        cssCaptured,
        onBlockedImageLoad: (_imageEl, serializedNode, { width, height }) => {
          this.mutationCb({
            adds: [],
            removes: [],
            texts: [],
            attributes: [
              {
                id: serializedNode.id,
                attributes: {
                  style: {
                    width: `${width}px`,
                    height: `${height}px`,
                  },
                },
              },
            ],
          });
        },
        ignoreCSSAttributes: this.ignoreCSSAttributes,
      });
      if (sn) {
        adds.push({
          parentId,
          nextId,
          node: sn,
        });
        addedIds.add(sn.id);
      }
    }

    const payload = {
      texts: this.texts
        .map((text) => {
          const n = text.node;
          const parent = dom.parentNode(n);
          if (parent && (parent as Element).tagName === 'TEXTAREA') {
            // the node is being ignored as it isn't in the mirror, so shift mutation to attributes on parent textarea
            this.genTextAreaValueMutation(parent as HTMLTextAreaElement);
          }
          return {
            id: this.mirror.getId(n),
            value: text.value,
          };
        })
        // no need to include them on added elements, as they have just been serialized with up to date attribubtes
        .filter((text) => !addedIds.has(text.id))
        // text mutation's id was not in the mirror map means the target node has been removed
        .filter((text) => this.mirror.has(text.id)),
      attributes: this.attributes
        .map((attribute) => {
          const { attributes } = attribute;
          if (typeof attributes.style === 'string') {
            const diffAsStr = JSON.stringify(attribute.styleDiff);
            const unchangedAsStr = JSON.stringify(attribute._unchangedStyles);
            // check if the style diff is actually shorter than the regular string based mutation
            // (which was the whole point of #464 'compact style mutation').
            if (diffAsStr.length < attributes.style.length) {
              // also: CSSOM fails badly when var() is present on shorthand properties, so only proceed with
              // the compact style mutation if these have all been accounted for
              if (
                (diffAsStr + unchangedAsStr).split('var(').length ===
                attributes.style.split('var(').length
              ) {
                attributes.style = attribute.styleDiff;
              }
            }
          }
          return {
            id: this.mirror.getId(attribute.node),
            attributes: attributes,
          };
        })
        // no need to include them on added elements, as they have just been serialized with up to date attribubtes
        .filter((attribute) => !addedIds.has(attribute.id))
        // attribute mutation's id was not in the mirror map means the target node has been removed
        .filter((attribute) => this.mirror.has(attribute.id)),
      removes: this.removes,
      adds,
    };
    // payload may be empty if the mutations happened in some blocked elements
    if (
      !payload.texts.length &&
      !payload.attributes.length &&
      !payload.removes.length &&
      !payload.adds.length
    ) {
      return;
    }

    // reset
    this.texts = [];
    this.attributes = [];
    this.attributeMap = new WeakMap<Node, attributeCursor>();
    this.removes = [];
    this.addedSet = new Set<Node>();
    this.movedSet = new Set<Node>();
    this.droppedSet = new Set<Node>();
    this.removesSubTreeCache = new Set<Node>();
    this.movedMap = {};

    this.mutationCb(payload);
  };

  private genTextAreaValueMutation = (textarea: HTMLTextAreaElement) => {
    let item = this.attributeMap.get(textarea);
    if (!item) {
      item = {
        node: textarea,
        attributes: {},
        styleDiff: {},
        _unchangedStyles: {},
      };
      this.attributes.push(item);
      this.attributeMap.set(textarea, item);
    }
    const value = Array.from(
      dom.childNodes(textarea),
      (cn) => dom.textContent(cn) || '',
    ).join('');
    item.attributes.value = maskInputValue({
      isMasked: shouldMaskInput({
        type: getInputType(textarea),
        tagName: textarea.tagName.toUpperCase() as Uppercase<string>,
        maskInputOptions: this.maskInputOptions,
      }),
      element: textarea,
      value,
      maskInputFn: this.maskInputFn,
    });
  };

  private processMutation = (m: mutationRecord) => {
    if (isIgnored(m.target, this.mirror, this.slimDOMOptions)) {
      return;
    }
    switch (m.type) {
      case 'characterData': {
        const value = dom.textContent(m.target);

        if (
          !isBlocked(
            m.target,
            this.blockClass,
            this.blockSelector,
            this.unblockSelector,
            false,
          ) &&
          value !== m.oldValue
        ) {
          this.texts.push({
            value:
              needMaskingText(
                m.target,
                this.maskTextClass,
                this.maskTextSelector,
                this.unmaskTextClass,
                this.unmaskTextSelector,
                this.maskAllText,
              ) && value
                ? this.maskTextFn
                  ? this.maskTextFn(value, closestElementOfNode(m.target))
                  : value.replace(/[\S]/g, '*')
                : value,
            node: m.target,
          });
        }
        break;
      }

      case 'attributes': {
        const target = m.target as HTMLElement;
        const tagNameLower = toLowerCase(target.tagName);
        let attributeName = m.attributeName as string;
        let value = (m.target as HTMLElement).getAttribute(attributeName);

        if (attributeName === 'value') {
          const type = getInputType(target);
          const tagName = target.tagName as unknown as Uppercase<string>;
          value = getInputValue(target as HTMLInputElement, tagName, type);

          const isInputMasked = shouldMaskInput({
            maskInputOptions: this.maskInputOptions,
            tagName,
            type,
          });

          const forceMask = needMaskingText(
            m.target,
            this.maskTextClass,
            this.maskTextSelector,
            this.unmaskTextClass,
            this.unmaskTextSelector,
            isInputMasked,
          );

          value = maskInputValue({
            isMasked: forceMask,
            element: target,
            value,
            maskInputFn: this.maskInputFn,
          });
        }
        if (
          isBlocked(
            m.target,
            this.blockClass,
            this.blockSelector,
            this.unblockSelector,
            false,
          ) ||
          value === m.oldValue
        ) {
          return;
        }

        let item = this.attributeMap.get(m.target);
        if (
          tagNameLower === 'iframe' &&
          attributeName === 'src' &&
          !this.keepIframeSrcFn(value as string)
        ) {
          const iframeDoc = getIFrameContentDocument(
            target as HTMLIFrameElement,
          );
          if (!iframeDoc) {
            // we can't record it directly as we can't see into it
            // preserve the src attribute so a decision can be taken at replay time
            attributeName = 'rr_src';
          } else {
            return;
          }
        }
        if (!item) {
          item = {
            node: m.target,
            attributes: {},
            styleDiff: {},
            _unchangedStyles: {},
          };
          this.attributes.push(item);
          this.attributeMap.set(m.target, item);
        }

        // Keep this property on inputs that used to be password inputs
        // This is used to ensure we do not unmask value when using e.g. a "Show password" type button
        if (
          attributeName === 'type' &&
          tagNameLower === 'input' &&
          (m.oldValue || '').toLowerCase() === 'password'
        ) {
          target.setAttribute('data-rr-is-password', 'true');
        }

        if (!ignoreAttribute(tagNameLower, attributeName, value)) {
          // overwrite attribute if the mutations was triggered in same time
          item.attributes[attributeName] = transformAttribute(
            this.doc,
            tagNameLower,
            toLowerCase(attributeName),
            value,
            target,
            this.maskAttributeFn,
          );
          if (attributeName === 'style') {
            const oldStyle = m.oldValue
              ? this.styleDeclarationParser.parse(m.oldValue)
              : null;
            for (const pname of Array.from(target.style)) {
              const newValue = target.style.getPropertyValue(pname);
              const newPriority = target.style.getPropertyPriority(pname);
              if (
                newValue !== (oldStyle?.getPropertyValue(pname) || '') ||
                newPriority !== (oldStyle?.getPropertyPriority(pname) || '')
              ) {
                if (newPriority === '') {
                  item.styleDiff[pname] = newValue;
                } else {
                  item.styleDiff[pname] = [newValue, newPriority];
                }
              } else {
                // for checking
                item._unchangedStyles[pname] = [newValue, newPriority];
              }
            }
            if (oldStyle) {
              for (const pname of Array.from(oldStyle)) {
                if (target.style.getPropertyValue(pname) === '') {
                  // "if not set, returns the empty string"
                  item.styleDiff[pname] = false; // delete
                }
              }
            }
          } else if (attributeName === 'open' && target.tagName === 'DIALOG') {
            if (target.matches('dialog:modal')) {
              item.attributes['rr_open_mode'] = 'modal';
            } else {
              item.attributes['rr_open_mode'] = 'non-modal';
            }
          }
        }
        break;
      }
      case 'childList': {
        /**
         * Parent is blocked, ignore all child mutations
         */
        if (
          isBlocked(
            m.target,
            this.blockClass,
            this.blockSelector,
            this.unblockSelector,
            true,
          )
        ) {
          return;
        }

        m.addedNodes.forEach((n) => this.genAdds(n, m.target));
        m.removedNodes.forEach((n) => {
          if (!inDom(n)) {
            this.shadowDomManager.removeShadowRootsIn(n);
          }
          const nodeId = this.mirror.getId(n);
          const parentId = isShadowRoot(m.target)
            ? this.mirror.getId(dom.host(m.target))
            : this.mirror.getId(m.target);
          if (
            isBlocked(
              m.target,
              this.blockClass,
              this.blockSelector,
              this.unblockSelector,
              false,
            ) ||
            isIgnored(n, this.mirror, this.slimDOMOptions) ||
            !isSerialized(n, this.mirror)
          ) {
            return;
          }
          // removed node has not been serialized yet, just remove it from the Set
          if (this.addedSet.has(n)) {
            deepDelete(this.addedSet, n);
            this.droppedSet.add(n);
          } else if (this.addedSet.has(m.target) && nodeId === -1) {
            /**
             * If target was newly added and removed child node was
             * not serialized, it means the child node has been removed
             * before callback fired, so we can ignore it because
             * newly added node will be serialized without child nodes.
             * TODO: verify this
             */
          } else if (isAncestorRemoved(m.target, this.mirror)) {
            /**
             * If parent id was not in the mirror map any more, it
             * means the parent node has already been removed. So
             * the node is also removed which we do not need to track
             * and replay.
             */
          } else if (
            this.movedSet.has(n) &&
            this.movedMap[moveKey(nodeId, parentId)]
          ) {
            deepDelete(this.movedSet, n);
          } else {
            this.removes.push({
              parentId,
              id: nodeId,
              isShadow:
                isShadowRoot(m.target) && isNativeShadowDom(m.target)
                  ? true
                  : undefined,
            });
            processRemoves(n, this.removesSubTreeCache);
          }
          this.mapRemoves.push(n);
        });
        break;
      }
      default:
        break;
    }
  };

  /**
   * Make sure you check if `n`'s parent is blocked before calling this function
   * */
  private genAdds = (n: Node, target?: Node) => {
    // this node was already recorded in other buffer, ignore it
    if (this.processedNodeManager.inOtherBuffer(n, this)) return;

    // if n is added to set, there is no need to travel it and its' children again
    if (this.addedSet.has(n) || this.movedSet.has(n)) return;

    if (this.mirror.hasNode(n)) {
      if (isIgnored(n, this.mirror, this.slimDOMOptions)) {
        return;
      }
      this.movedSet.add(n);
      let targetId: number | null = null;
      if (target && this.mirror.hasNode(target)) {
        targetId = this.mirror.getId(target);
      }
      if (targetId && targetId !== -1) {
        this.movedMap[moveKey(this.mirror.getId(n), targetId)] = true;
      }
    } else {
      this.addedSet.add(n);
      this.droppedSet.delete(n);
    }

    // if this node is blocked `serializeNode` will turn it into a placeholder element
    // but we have to remove it's children otherwise they will be added as placeholders too
    if (
      !isBlocked(
        n,
        this.blockClass,
        this.blockSelector,
        this.unblockSelector,
        false,
      )
    ) {
      dom.childNodes(n).forEach((childN) => this.genAdds(childN));
      if (hasShadowRoot(n)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        dom.childNodes(dom.shadowRoot(n)!).forEach((childN) => {
          this.processedNodeManager.add(childN, this);
          this.genAdds(childN, n);
        });
      }
    }
  };
}

/**
 * Some utils to handle the mutation observer DOM records.
 * It should be more clear to extend the native data structure
 * like Set and Map, but currently Typescript does not support
 * that.
 */
function deepDelete(addsSet: Set<Node>, n: Node) {
  addsSet.delete(n);
  dom.childNodes(n).forEach((childN) => deepDelete(addsSet, childN));
}

function processRemoves(n: Node, cache: Set<Node>) {
  const queue = [n];

  while (queue.length) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const next = queue.pop()!;
    if (cache.has(next)) continue;
    cache.add(next);
    dom.childNodes(next).forEach((n) => queue.push(n));
  }

  return;
}

function isSelfOrAncestorInSet(set: Set<Node>, n: Node): boolean {
  if (set.size === 0) return false;
  return _isSelfOrAncestorInSet(set, n);
}

function _isSelfOrAncestorInSet(set: Set<Node>, n: Node): boolean {
  if (set.has(n)) {
    return true;
  }
  const parent = dom.parentNode(n);
  if (!parent) {
    return false;
  }
  return _isSelfOrAncestorInSet(set, parent);
}
