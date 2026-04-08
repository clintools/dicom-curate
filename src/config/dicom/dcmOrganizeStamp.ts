import type { TPs315Options } from '../../types'
import { supportedCid7050 } from './cid7050'

export function getDcmOrganizeStamp(options: TPs315Options) {
  const tempOpt = options.retainLongitudinalTemporalInformationOptions
  const tempModified =
    tempOpt === 'Off'
      ? 'REMOVED'
      : tempOpt === 'Full'
        ? 'UNMODIFIED'
        : 'MODIFIED'
  return {
    LongitudinalTemporalInformationModified: tempModified,
    PatientIdentityRemoved: 'YES',
    DeidentificationMethod: 'See dicom-curate README for details',
    DeidentificationMethodCodeSequence: getCid7050Codes(options).map(
      (option) => ({
        CodeValue: option.value,
        CodeMeaning: option.meaning,
        CodingSchemeDesignator: option.scheme,
      }),
    ),
  }
}

export function getCid7050Codes(options: TPs315Options) {
  const seq = [supportedCid7050.basicApplicationConfidentialityProfile]

  Object.entries(options).forEach(([_option, v]) => {
    const option = _option as keyof TPs315Options

    if (option === 'cleanDescriptorsExceptions') {
      // Nothing to do, this is an exception, not defined in PS3.15
      return
    }

    if (v === false || v === 'Off') {
      return
    }

    const item =
      option === 'retainLongitudinalTemporalInformationOptions'
        ? v === 'Full'
          ? supportedCid7050.retainLongitudinalTemporalInformationFullDatesOptions
          : supportedCid7050.retainLongitudinalTemporalInformationModifiedDatesOptions
        : supportedCid7050[option]

    seq.push(item)
  })

  seq.sort((a, b) => Number(a.value) - Number(b.value))

  return seq
}
