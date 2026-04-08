/**
 * Create a UID similar to a UUIDv5‐based UID, but using SHA‑256.
 *
 * The function:
 * 1. Combines the namespace (converted to bytes) and the input uid.
 * 2. Computes a SHA‑256 hash of the combined data.
 * 3. Truncates the hash to 16 bytes.
 * 4. Adjusts the bytes so that the result looks like a UUIDv5 (version and variant bits set).
 * 5. Converts each byte to a 3‑digit padded string, strips any leading zeros,
 *    and then prepends uuidBasedUIDPrefix.
 *
 * @param uid A unique identifier string.
 * @returns A mapped UID string.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { parse as uuidParse } from 'uuid'

// value defined here:
// https://www.rfc-editor.org/rfc/rfc9562#name-uuid-version-5
const oidNamespace = '6ba7b812-9dad-11d1-80b4-00c04fd430c8'
const uuidBasedUIDPrefix = '2.25.'

/**
 * Create a hashed UID based on SHA‑256.
 *
 * This function:
 * 1. Converts the given namespace and uid to byte arrays.
 * 2. Concatenates them and computes a SHA‑256 hash.
 * 3. Truncates the hash to the first 16 bytes.
 * 4. Converts each byte to a 3‑digit padded string and removes any leading zeros.
 * 5. Prepends the uuidBasedUIDPrefix (e.g. "2.25") to the resulting string.
 *
 * Note: Unlike the original v5‑style implementation, this version does not adjust bits
 * to mimic UUID version/variant, in order to maximize entropy.
 *
 * @param uid A unique identifier string.
 * @returns A mapped UID string.
 */
export default function hashUid(uid: string): string {
  // Convert the namespace UUID string into its 16-byte representation.
  const namespaceArray = new Uint8Array(uuidParse(oidNamespace))

  // Convert the uid into a UTF-8 byte ar*ray.
  const encoder = new TextEncoder()
  const uidBytes = encoder.encode(uid)

  // Concatenate namespace bytes and uid bytes.
  const combined = new Uint8Array(namespaceArray.length + uidBytes.length)
  combined.set(namespaceArray)
  combined.set(uidBytes, namespaceArray.length)

  // Compute the SHA‑256 hash of the combined data.
  const fullHash = sha256(combined) // 32 bytes

  // Truncate to the first 19 bytes to "fill" the DICOM UID space to the max (<=64 chars)
  const hashBytes = fullHash.slice(0, 19)

  // Convert each byte to a 3-digit padded string.
  let hashedString = ''
  for (const byte of hashBytes) {
    hashedString += String(byte).padStart(3, '0')
  }
  // Remove any leading zeros.
  hashedString = hashedString.replace(/^0+/, '')

  // Prepend the prefix and return the final UID.
  return uuidBasedUIDPrefix + hashedString
}
