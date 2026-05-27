/**
 * Unit tests for dciodvfy output parsing and normalisation (no dciodvfy binary).
 * See README.md — "dciodvfy.normalise.test.ts".
 */
import { describe, expect, it } from 'vitest'
import { normaliseViolation } from './dciodvfy'

describe('normaliseViolation', () => {
  it('drops filesystem path prefix from -new lines', () => {
    const v = normaliseViolation({
      severity: 'Error',
      rawLine:
        'Error - /tmp/foo.dcm - </StudyDate(0008,0020)> - Missing attribute - Module=<X>',
    })
    expect(v).toBe(
      'Error::</StudyDate(0008,0020)>::Missing attribute - Module=<X>',
    )
  })

  it('strips filesystem path from fallback when no tag segment follows', () => {
    const a = normaliseViolation({
      severity: 'Error',
      rawLine: 'Error - /tmp/foo.dcm - Not a tag - Some message',
    })
    const b = normaliseViolation({
      severity: 'Error',
      rawLine: 'Error - /var/other.dcm - Not a tag - Some message',
    })
    expect(a).toBe(b)
    expect(a).toBe('Error::Not a tag - Some message')
  })

  it('collapses per-character UI invalid-value messages', () => {
    const v = normaliseViolation({
      severity: 'Error',
      rawLine:
        "Error - </MediaStorageSOPInstanceUID(0002,0003)[1]> - Value invalid for this VR [UI] = <x> - Character invalid for this VR = 'x' (0x78)",
    })
    expect(v).toBe(
      'Error::</MediaStorageSOPInstanceUID(0002,0003)[1]>::Value invalid for this VR [UI]',
    )
  })
})
