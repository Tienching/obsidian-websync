/** A lossless byte-level patch for a single changed span. */
export interface ByteDelta {
  prefixLength: number;
  suffixLength: number;
  middle: Uint8Array;
}

export function createByteDelta(base: Uint8Array, next: Uint8Array): ByteDelta {
  let prefixLength = 0;
  const maximum = Math.min(base.length, next.length);
  while (prefixLength < maximum && base[prefixLength] === next[prefixLength]) prefixLength += 1;
  let suffixLength = 0;
  while (suffixLength < maximum - prefixLength
    && base[base.length - 1 - suffixLength] === next[next.length - 1 - suffixLength]) suffixLength += 1;
  return { prefixLength, suffixLength, middle: next.slice(prefixLength, next.length - suffixLength) };
}

export function applyByteDelta(base: Uint8Array, delta: ByteDelta): Uint8Array {
  const { prefixLength, suffixLength, middle } = delta;
  if (!Number.isSafeInteger(prefixLength) || prefixLength < 0
    || !Number.isSafeInteger(suffixLength) || suffixLength < 0
    || prefixLength + suffixLength > base.length) {
    throw new Error("Invalid byte delta");
  }
  const result = new Uint8Array(prefixLength + middle.length + suffixLength);
  result.set(base.subarray(0, prefixLength), 0);
  result.set(middle, prefixLength);
  result.set(base.subarray(base.length - suffixLength), prefixLength + middle.length);
  return result;
}
