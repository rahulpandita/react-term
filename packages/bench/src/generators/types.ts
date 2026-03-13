export interface Scenario {
  name: string;
  /** Pre-generated payload (~5 MB, aligned to sequence boundaries). */
  data: Uint8Array;
}

/**
 * Fill a buffer by repeating `seq` without splitting sequences at the boundary.
 * Returns a Uint8Array whose length is the largest multiple of seq.length <= targetSize.
 */
export function fillAligned(seq: Uint8Array, targetSize: number): Uint8Array {
  const count = Math.floor(targetSize / seq.length);
  const data = new Uint8Array(count * seq.length);
  for (let i = 0; i < count; i++) {
    data.set(seq, i * seq.length);
  }
  return data;
}
