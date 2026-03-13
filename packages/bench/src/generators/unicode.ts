import { fillAligned, type Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;

/** CJK + emoji mix — exercises multi-byte UTF-8 decode path. */
export function unicode(): Scenario {
  const sample = new TextEncoder().encode("你好世界🚀🎉こんにちは🌍abc漢字テスト✨Hello");
  return { name: "unicode", data: fillAligned(sample, SIZE) };
}
