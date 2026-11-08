import snapshot, {
  snapshotSliced,
  serializeNodeWithId,
  transformAttribute,
  ignoreAttribute,
  slimDOMDefaults,
  visitSnapshot,
  cleanupSnapshot,
  distanceToMatch,
  createMatchPredicate,
  needMaskingText,
  classMatchesRegex,
  IGNORED_NODE,
  genId,
  filterCSSPropertiesFromInlineStyle,
  setAssetHook,
  setCanvasPixelsHook,
  applyDeferredAssetHooks,
  setAssetDeferral,
  freezeDocument,
  noteSheetMutation,
} from './snapshot';
import rebuild, {
  buildNodeWithSN,
  addHoverClass,
  createCache,
  createSandboxedIframe,
  rebuildIntoSandboxedIframe,
} from './rebuild';
export * from './types';
// Legacy broad export kept for compatibility. New internal imports should
// prefer snapshot-utils.ts / rebuild-utils.ts domain entrypoints.
export * from './utils';

export type {
  SnapshotSlicer,
  SnapshotOptions,
  CanvasPixelsHook,
  FrozenDocument,
} from './snapshot';

export {
  snapshot,
  snapshotSliced,
  serializeNodeWithId,
  rebuild,
  createSandboxedIframe,
  rebuildIntoSandboxedIframe,
  buildNodeWithSN,
  addHoverClass,
  createCache,
  transformAttribute,
  ignoreAttribute,
  slimDOMDefaults,
  visitSnapshot,
  cleanupSnapshot,
  distanceToMatch,
  createMatchPredicate,
  needMaskingText,
  classMatchesRegex,
  IGNORED_NODE,
  genId,
  filterCSSPropertiesFromInlineStyle,
  setAssetHook,
  setCanvasPixelsHook,
  applyDeferredAssetHooks,
  setAssetDeferral,
  freezeDocument,
  noteSheetMutation,
};
