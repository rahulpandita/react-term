import type { ScrollInputMode } from "@next_term/web";

export function getComparisonScrollInputMode(isEmbedded: boolean): ScrollInputMode {
  return isEmbedded ? "page" : "terminal";
}

export function getEmbeddedParentOrigin(search: string, referrer: string): string {
  const configuredOrigin = new URLSearchParams(search).get("parentOrigin");
  for (const candidate of [configuredOrigin, referrer]) {
    if (!candidate) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      // Try the next explicit source before using the non-sensitive wildcard fallback.
    }
  }
  return "*";
}

export function shouldForwardEmbeddedTouch(
  deltaX: number,
  deltaY: number,
  startedInXtermViewport: boolean,
): boolean {
  return !startedInXtermViewport && deltaY !== 0 && Math.abs(deltaY) > Math.abs(deltaX);
}

export function shouldForwardEmbeddedWheel(
  deltaX: number,
  deltaY: number,
  startedInXtermViewport: boolean,
): boolean {
  return !startedInXtermViewport && deltaY !== 0 && Math.abs(deltaY) >= Math.abs(deltaX);
}
