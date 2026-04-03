/**
 * Re-export the shared GestureHandler from @next_term/core.
 *
 * The gesture handler is platform-agnostic and lives in core so it can
 * be shared between web (DOM touch events) and native (React Native
 * gesture handler).
 */

export type { GestureConfig } from "@next_term/core";
export { GestureHandler, GestureState } from "@next_term/core";
