import getParser from './getParser'

describe('getParser.getDicom', () => {
  const naturalData = {
    Modality: 'NM',
    PatientID: '12345',
    EnergyWindowInformationSequence: [
      {
        EnergyWindowRangeSequence: [
          {
            EnergyWindowLowerLimit: 99,
            EnergyWindowUpperLimit: 101,
          },
        ],
      },
    ],
  }

  const parser = getParser('protocolNumber', 'PN123', naturalData, 'Off')

  it('returns top-level and sequence attributes', () => {
    expect(parser.getDicom('Modality')).toBe('NM')
    expect(parser.getDicom('PatientID')).toBe('12345')
    const seq = parser.getDicom('EnergyWindowInformationSequence')
    expect(Array.isArray(seq)).toBe(true)
    expect(seq[0].EnergyWindowRangeSequence[0].EnergyWindowLowerLimit).toBe(99)
  })

  it('returns correct value for valid nested path', () => {
    const value = parser.getDicom(
      'EnergyWindowInformationSequence[0].EnergyWindowRangeSequence[0].EnergyWindowLowerLimit',
    )
    expect(value).toBe(99)
  })

  it('returns undefined for invalid nested path', () => {
    const value = parser.getDicom(
      'EnergyWindowInformationSequence[0].EnergyWindowRangeSequence[1].DoesNotExist',
    )
    expect(value).toBeUndefined()
  })
})
