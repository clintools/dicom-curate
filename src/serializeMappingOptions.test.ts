import {
  deserializeMappingOptions,
  serializeMappingOptions,
} from './serializeMappingOptions'
import type { TMappingOptions } from './types'

describe('serializeMappingOptions with none specification', () => {
  it('serializes none as curationSpecStr none', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: 'none',
      skipWrite: true,
      skipModifications: true,
      skipValidation: true,
      dateOffset: 'P1D',
    }

    const serialized = serializeMappingOptions(mappingOptions)

    expect(serialized.curationSpecStr).toBe('none')
    expect(serialized.skipWrite).toBe(true)
    expect(serialized.skipModifications).toBe(true)
    expect(serialized.skipValidation).toBe(true)
    expect(serialized.dateOffset).toBe('P1D')
  })

  it('deserializes curationSpecStr none back to none literal', () => {
    const deserialized = deserializeMappingOptions({
      curationSpecStr: 'none',
      skipWrite: false,
      skipModifications: true,
      skipValidation: false,
      dateOffset: 'P2D',
    })

    expect(deserialized.curationSpec).toBe('none')
    expect(deserialized.skipWrite).toBe(false)
    expect(deserialized.skipModifications).toBe(true)
    expect(deserialized.skipValidation).toBe(false)
    expect(deserialized.dateOffset).toBe('P2D')
  })

  it('round-trips none mapping options without mutating other fields', () => {
    const original: TMappingOptions = {
      curationSpec: 'none',
      skipWrite: false,
      skipModifications: false,
      skipValidation: true,
      dateOffset: 'P3D',
    }

    const serialized = serializeMappingOptions(original)
    const roundTripped = deserializeMappingOptions(serialized)

    expect(roundTripped).toEqual(original)
  })

  it('serializes function specs as source strings', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: () => [],
    }

    const serialized = serializeMappingOptions(mappingOptions)

    expect(serialized.curationSpecStr).toContain('=>')
  })
})

describe('function specification deserialization', () => {
  it('deserializes and invokes a function curation spec', () => {
    const serialized = serializeMappingOptions({
      curationSpec: () => [],
    })

    const { curationSpec } = deserializeMappingOptions(serialized)

    expect(typeof curationSpec).toBe('function')
    if (typeof curationSpec !== 'function') {
      throw new Error('expected function curation spec')
    }
    expect(curationSpec()).toEqual([])
  })

  it('round-trips skip flags with a function curation spec', () => {
    const original: TMappingOptions = {
      curationSpec: () => [],
      skipWrite: true,
      skipModifications: false,
      skipValidation: true,
      dateOffset: 'P1D',
    }

    const roundTripped = deserializeMappingOptions(
      serializeMappingOptions(original),
    )

    expect(roundTripped.skipWrite).toBe(true)
    expect(roundTripped.skipModifications).toBe(false)
    expect(roundTripped.skipValidation).toBe(true)
    expect(roundTripped.dateOffset).toBe('P1D')
    const { curationSpec: roundTrippedSpec } = roundTripped
    if (typeof roundTrippedSpec !== 'function') {
      throw new Error('expected function curation spec')
    }
    expect(roundTrippedSpec()).toEqual([])
  })
})
