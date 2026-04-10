import {
  canonicalDTToDicom,
  dicomToCanonicalDT,
  getDicomVR,
  offsetDateTime,
} from './offsetDateTime'

describe('Get DICOM VR', () => {
  it('discovers DA', () => {
    expect(getDicomVR('99990101')).toEqual('DA')
  })

  it('discovers DT', () => {
    expect(getDicomVR('99990101123456.123456')).toEqual('DT')
  })

  it('discovers DT with timezone', () => {
    expect(getDicomVR('99990101123456.123456-0500')).toEqual('DT')
  })

  it('discovers TM', () => {
    expect(getDicomVR('123456.123456')).toEqual('TM')
  })
})

describe('DA/DT/TM to canonical DT', () => {
  it('DA to canonical', () => {
    expect(dicomToCanonicalDT('20230415')).toEqual('20230415000000.000000')
  })

  it('DT to canonical', () => {
    expect(dicomToCanonicalDT('99990101123456.123456')).toEqual(
      '99990101123456.123456',
    )
  })

  it('DT with timezone to canonical', () => {
    expect(dicomToCanonicalDT('99990101123456.123456+0230')).toEqual(
      '99990101123456.123456',
    )
  })

  it('TM to canonical', () => {
    expect(dicomToCanonicalDT('123456.123456')).toEqual('19700101123456.123456')
  })

  it('TM, partial to canonical', () => {
    expect(dicomToCanonicalDT('12')).toEqual('19700101120000.000000')
  })
})

describe('Canonical to DA/DT/TM', () => {
  it('DA from canonical', () => {
    expect(canonicalDTToDicom('20230415000000.000000', '20230415')).toEqual(
      '20230415',
    )
  })

  it('DT from canonical', () => {
    expect(
      canonicalDTToDicom('99990101123456.123456', '99990101123456.123456'),
    ).toEqual('99990101123456.123456')
  })

  it('DT with timezone to canonical', () => {
    expect(
      canonicalDTToDicom('99990101123456.123456', '99990101123456.123456+0230'),
    ).toEqual('99990101123456.123456+0230')
  })

  it('TM to canonical', () => {
    expect(
      canonicalDTToDicom('19700102123456.123456', '123456.123456'),
    ).toEqual('123456.123456')
  })

  it('TM, partial to canonical', () => {
    expect(canonicalDTToDicom('19700101120000.000000', '12')).toEqual('12')
  })

  it('TM, partial with minutes to canonical', () => {
    expect(canonicalDTToDicom('19700101121234.000000', '1200')).toEqual('1212')
  })
})

describe('Offset DICOM value by ISO8601 duration', () => {
  it('offsets DA', () => {
    expect(offsetDateTime('20230415', 'P7D')).toEqual('20230422')
  })

  it('offsets DA negative', () => {
    expect(offsetDateTime('20230415', '-P7D')).toEqual('20230408')
  })

  it('offsets DA via time', () => {
    expect(offsetDateTime('20230415', 'PT24H')).toEqual('20230416')
  })

  it('offsets DT', () => {
    expect(offsetDateTime('99990101123456.123456', 'P7DT5.5S')).toEqual(
      '99990108123501.623456',
    )
  })

  it('offsets DT with timezone', () => {
    expect(offsetDateTime('99990101123456.123456-0500', 'P7DT17M')).toEqual(
      '99990108125156.123456-0500',
    )
  })

  it('offsets DT with timezone, negative', () => {
    expect(
      offsetDateTime('99990101123456.123456-0500', '-P1DT1.123456S'),
    ).toEqual('99981231123455.000000-0500')
  })

  it('offsets TM', () => {
    expect(offsetDateTime('123456.123456', 'PT1.111111S')).toEqual(
      '123457.234567',
    )
  })

  it('offsets TM without effect', () => {
    expect(offsetDateTime('123456.123456', 'P7D')).toEqual('123456.123456')
  })

  it('offsets TM/hours only', () => {
    expect(offsetDateTime('12', 'PT60M')).toEqual('13')
  })

  it('offsets TM/hours only, no effect', () => {
    expect(offsetDateTime('12', 'P7M')).toEqual('12')
  })

  // Additional edge case tests for calendar arithmetic
  it('handles end-of-month overflow (Jan 31 + 1 month)', () => {
    // Jan 31 + 1 month = Feb 31 (doesn't exist) → overflows to March 3
    // This is standard JavaScript Date behavior
    expect(offsetDateTime('20230131', 'P1M')).toEqual('20230303')
  })

  it('handles leap year correctly', () => {
    // Feb 28, 2024 (leap year) + 1 day = Feb 29
    expect(offsetDateTime('20240228', 'P1D')).toEqual('20240229')
    // Feb 29, 2024 + 1 year → Feb 29, 2025 (doesn't exist) → overflows to March 1
    // This is standard JavaScript Date overflow behavior
    expect(offsetDateTime('20240229', 'P1Y')).toEqual('20250301')
  })

  it('handles weeks', () => {
    expect(offsetDateTime('20230415', 'P2W')).toEqual('20230429')
  })

  it('handles complex duration with years, months, days', () => {
    // Test the example from the bug report
    expect(offsetDateTime('20250101123000.000000', 'P1Y2M3DT4H5M6S')).toEqual(
      '20260304163506.000000',
    )
  })

  it('handles negative duration with large fractional carry', () => {
    // 0.1 seconds - 0.9 seconds = -0.8 seconds (should borrow 1 second)
    expect(offsetDateTime('20230101120000.100000', '-PT0.900000S')).toEqual(
      '20230101115959.200000',
    )
  })

  it('handles positive fractional carry', () => {
    // 0.9 seconds + 0.9 seconds = 1.8 seconds (should carry 1 second)
    expect(offsetDateTime('20230101120000.900000', 'PT0.900000S')).toEqual(
      '20230101120001.800000',
    )
  })

  it('handles whitespace in DICOM value', () => {
    expect(offsetDateTime(' 20230415 ', 'P7D')).toEqual('20230422')
    expect(offsetDateTime('  99990101123456.123456  ', 'PT1S')).toEqual(
      '99990101123457.123456',
    )
  })
})
