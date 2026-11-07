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
} from './snapshot';
import rebuild, {
  buildNodeWithSN,
  addHoverClass,
  createCache,
} from './rebuild';
export * from './types';
export * from './utils';

export type { SnapshotSlicer, SnapshotOptions } from './snapshot';

export {
  snapshot,
  snapshotSliced,
  serializeNodeWithId,
  rebuild,
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
};
