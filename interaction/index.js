import { InteractionSystem } from './interaction-system.js';

export { CONFIG, INTERFACE_VERSION } from './config.js';
export { FiringMachine } from './firing-machine.js';

/**
 * Create the QI-XI gesture/interaction system.
 *
 * No camera or DOM access happens here. The visual layer owns the page, the
 * Three.js scene and the render loop; this object owns progress and input.
 */
export function createInteractionSystem(options) {
  return new InteractionSystem(options);
}
