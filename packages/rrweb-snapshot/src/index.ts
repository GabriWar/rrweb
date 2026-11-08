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

export type { SnapshotSlicer, SnapshotOptions } from './snapshot';

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
};
