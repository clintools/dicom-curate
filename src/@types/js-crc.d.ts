declare module 'js-crc' {
  // crc32 returns a numeric CRC value. We declare as number to allow bitwise ops.
  export function crc32(input: string | ArrayBuffer | Uint8Array): number
  // crc64: 64-bit CRC. Some consumers return a numeric value (may overflow JS number),
  // others return a hex string. We declare both forms to be safe.
  export function crc64(
    input: string | ArrayBuffer | Uint8Array,
  ): number | string
  // convenience: return lowercase hex string for 64-bit CRC (if the library exposes it)
  export function crc64hex(input: string | ArrayBuffer | Uint8Array): string
}

export {}
