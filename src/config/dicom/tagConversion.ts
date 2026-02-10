import * as dcmjs from 'dcmjs'

/**
 * Check if a tag identifier is a private tag
 */
export function isPrivateTag(tagId: string): boolean {
  // Check if it's already a tag ID format (8 hex digits)
  if (/^[0-9A-Fa-f]{8}$/.test(tagId)) {
    const group = parseInt(tagId.substring(0, 4), 16)
    return group % 2 === 1
  }
  // If it's a keyword, it's not a private tag
  return false
}

/**
 * Convert a DICOM keyword to its corresponding tag ID
 */
export function convertKeywordToTagId(keyword: string): string {
  // Use dcmjs built-in conversion for standard DICOM keywords
  // For private tags (which don't have keywords), keep as-is
  const tagId = isPrivateTag(keyword)
    ? keyword
    : dcmjs.data.DicomMetaDictionary.nameMap[keyword]?.tag || keyword
  // Remove parentheses and commas, convert to the format used in dictionary keys
  return tagId.replace(/[(),]/g, '').toLowerCase()
}

/**
 * Convert a keyword path to tag ID path for nested DICOM elements
 */
export function convertKeywordPathToTagIdPath(keywordPath: string): string {
  // Handle nested paths like "GeneralMatchingSequence[0].00510014"
  const parts = keywordPath.split('.')
  const convertedParts = parts.map((part) => {
    const arrayMatch = part.match(/^(.+)\[(\d+)\]$/)
    if (arrayMatch) {
      const [, keyword, index] = arrayMatch
      const tagId = convertKeywordToTagId(keyword)
      return `${tagId}[${index}]`
    } else {
      return convertKeywordToTagId(part)
    }
  })

  return convertedParts.join('.')
}
