/**
 * Re-export the shared GestureHandler from @react-term/core.
 *
 * The gesture handler is platform-agnostic and lives in core so it can
 * be shared between web (DOM touch events) and native (React Native
 * gesture handler).
 */
export { GestureHandler, GestureState } from '@react-term/core';
export type { GestureConfig } from '@react-term/core';
