/**
 * TerminalSurface — wraps the native platform view for terminal rendering.
 *
 * In a full implementation this would use requireNativeComponent() or a
 * Fabric component to host a Metal / Vulkan surface. In the JS-fallback
 * mode it renders a plain View that a Skia Canvas can draw into.
 *
 * This module is intentionally thin — the NativeTerminal component handles
 * all logic and passes render commands through.
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalSurfaceProps {
  /** Surface width in device-independent pixels. */
  width: number;
  /** Surface height in device-independent pixels. */
  height: number;
  /** Accessibility label for the terminal view. */
  accessibilityLabel?: string;
  /** Style overrides. */
  style?: Record<string, unknown>;
  /** Children (e.g. Skia Canvas). */
  children?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A placeholder surface component. In production this would be replaced by
 * a native Fabric component that hosts the GPU rendering surface.
 *
 * For now it renders a React Native View-compatible element. Since we can't
 * import `react-native` (it's a peer dep), the component returns a basic
 * React element that RN's View would be swapped into by the consumer.
 */
export const TerminalSurface: React.FC<TerminalSurfaceProps> = ({
  width,
  height,
  accessibilityLabel = 'Terminal',
  style,
  children,
}) => {
  return React.createElement(
    'RCTView',
    {
      style: {
        width,
        height,
        backgroundColor: '#1e1e1e',
        overflow: 'hidden',
        ...style,
      },
      accessibilityLabel,
      accessibilityRole: 'text',
    },
    children,
  );
};
