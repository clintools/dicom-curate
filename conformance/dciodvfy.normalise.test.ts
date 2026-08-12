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

  it('redacts the person name echoed in dubious-PN messages', () => {
    const v = normaliseViolation({
      severity: 'Warning',
      rawLine:
        'Warning - </ReferringPhysicianName(0008,0090)[1]> - Value dubious for this VR [PN] = <Example Name> - Retired Person Name form',
    })
    expect(v).toBe(
      'Warning::</ReferringPhysicianName(0008,0090)[1]>::Value dubious for this VR [PN] = <redacted> - Retired Person Name form',
    )
  })

  it('redacts dubious-PN values containing the field separator', () => {
    const v = normaliseViolation({
      severity: 'Warning',
      rawLine:
        'Warning - </PatientName(0010,0010)[1]> - Value dubious for this VR [PN] = <SMITH - JOHN> - Retired Person Name form',
    })
    expect(v).toBe(
      'Warning::</PatientName(0010,0010)[1]>::Value dubious for this VR [PN] = <redacted> - Retired Person Name form',
    )
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
