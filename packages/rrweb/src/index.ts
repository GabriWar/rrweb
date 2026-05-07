import record from './record';
import {
  Replayer,
  type playerConfig,
  type PlayerState,
  type SpeedState,
  type PlayerMachineState,
  type SpeedMachineState,
} from './replay';
import canvasMutation from './replay/canvas';
import * as utils from './utils';

export {
  EventType,
  IncrementalSource,
  MouseInteractions,
  ReplayerEvents,
} from '@rrweb/types';

// exports style.css from replay
import './replay/styles/style.css';

export type { recordOptions, ReplayPlugin } from './types';
export type {
  canvasMutationParam,
  canvasMutationData,
  eventWithTime,
  fullSnapshotEvent,
  incrementalSnapshotEvent,
  inputData,
} from '@rrweb/types';

export { deserializeArg } from './replay/canvas/deserialize-args';
export { addCustomEvent, freezePage, takeFullSnapshot } from './record';
export type { CanvasManagerConstructorOptions } from './record';
export { CanvasManager } from './record/observers/canvas/canvas-manager';

export {
  record,
  Replayer,
  type playerConfig,
  type PlayerState,
  type SpeedState,
  type PlayerMachineState,
  type SpeedMachineState,
  canvasMutation,
  utils,
};
