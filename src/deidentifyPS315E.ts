import type { TNaturalData } from 'dcmjs'
import * as dcmjs from 'dcmjs'
import { get as _get } from 'lodash'
import { getDcmOrganizeStamp } from './config/dicom/dcmOrganizeStamp'
import dummyValues from './config/dicom/dummyValues'
import { elementNamesToAlwaysKeep } from './config/dicom/elementNamesToAlwaysKeep'
import { ps315EElements as rawPs315EElements } from './config/dicom/ps315EElements'
import { retainAdditionalIds } from './config/dicom/retainAdditionalIds'
import { convertKeywordToTagId } from './config/dicom/tagConversion'
import { uidRegistryPS3_06_A1 } from './config/dicom/uidRegistryPS3_06_A1'
import hashUid from './hashUid'
import { offsetDateTime } from './offsetDateTime'
import type {
  Iso8601Duration,
  TMapResults,
  TPs315EElement,
  TPs315Options,
} from './types'

const nameMap = dcmjs.data.DicomMetaDictionary.nameMap

// Deal with dcmjs quirk of labeling retired tags with a
// "RETIRED_" prefix
function getVr(keyword: string) {
  const element = nameMap[keyword] ?? nameMap[`RETIRED_${keyword}`]
  return element?.vr
}

function temporalVr(vr: string) {
  return vr === 'DT' || vr === 'DA' || vr === 'TM'
}

function removeRetiredPrefix(name: string) {
  return name.startsWith('RETIRED_') ? name.slice(8) : name
}

export function protectUid(uid: string, retainUIDsOption: string): string {
  return hashUid(uid)
}

const elementNamesToAlwaysKeepSet = new Set(elementNamesToAlwaysKeep)

// Special conditions for some PS3.15 E1.1 elements.
const ps315EElements = rawPs315EElements.map((elm) => {
  switch (elm.keyword) {
    case 'EncapsulatedDocument': {
      return {
        ...elm,
        exceptCondition: (data: TNaturalData) => data.Modality === 'DOC',
        // Unless it's a DOC modality, we can remove this tag.
        basicProfile: 'X',
      }
    }
    case 'VerifyingObserverSequence': {
      return {
        ...elm,
        exceptCondition: (data: TNaturalData) => data.Modality === 'SR',
        // Unless it's a SR modality, we can remove this tag.
        // It is only optional in "KO" modality
        basicProfile: 'X',
      }
    }
    default:
      return elm
  }
})

export default function deidentifyPS315E({
  naturalData,
  dicomPS315EOptions,
  dateOffset,
  mapResults,
  originalDicomDict,
}: {
  naturalData: TNaturalData
  dicomPS315EOptions: TPs315Options
  dateOffset?: Iso8601Duration
  mapResults: TMapResults
  originalDicomDict?: Record<string, any>
}) {
  // Helper function to get original DICOM element from nested path
  function getOriginalDicomElement(path: string, tagName: string): any {
    if (!originalDicomDict) return null

    if (!path) {
      // Top-level element
      return originalDicomDict[tagName]
    }

    // Parse nested path like "GeneralMatchingSequence[0]."
    const pathParts = path.split('.')
    let current = originalDicomDict

    for (const part of pathParts) {
      if (!part) continue // Skip empty parts from trailing dots

      const arrayMatch = part.match(/^(.+)\[(\d+)\]$/)
      if (arrayMatch) {
        const [, sequenceName, index] = arrayMatch
        const tagId = convertKeywordToTagId(sequenceName)
        if (
          current[tagId] &&
          current[tagId].Value &&
          current[tagId].Value[parseInt(index)]
        ) {
          current = current[tagId].Value[parseInt(index)]
        } else {
          return null
        }
      } else {
        const tagId = convertKeywordToTagId(part)
        if (current[tagId]) {
          current = current[tagId]
        } else {
          return null
        }
      }
    }

    return current[tagName] ?? null
  }

  const {
    cleanDescriptorsOption,
    cleanDescriptorsExceptions,
    retainLongitudinalTemporalInformationOptions,
    retainPatientCharacteristicsOption,
    retainDeviceIdentityOption,
    retainUIDsOption,
    retainSafePrivateOption,
    retainInstitutionIdentityOption,
  } = dicomPS315EOptions

  const taggedps315EEls = ps315EElements.reduce(
    (acc: TPs315EElement[], item: TPs315EElement) => {
      acc.push(item)
      return acc
    },
    [],
  )

  let cleanPolicy = taggedps315EEls.map(({ basicProfile, ...rest }) => {
    return {
      ...rest,
      rule: basicProfile.match(/[^/]*$/)?.[0] ?? '',
    }
  })
  const taggedps315EElSet = new Set(cleanPolicy.map((item) => item.keyword))

  const instanceUids: string[] = []

  // We handle UIs separately
  cleanPolicy = cleanPolicy.filter((p) => {
    const vr = getVr(p.keyword)

    if (vr === 'UI') {
      instanceUids.push(p.keyword)
      return false
    }
    if (p.rule === 'U*') {
      // already handled with deep UI cleaning approach
      return false
    }

    return true
  })

  if (retainPatientCharacteristicsOption) {
    retainPatientCharacteristicsOption.forEach((keyword: string) => {
      // Filter out elements from policy if they match subset
      // but only if they are eligible.
      // If matches an element but is not eligible, keep in filter.
      // We keep independent of 'K' or 'C'.
      cleanPolicy = cleanPolicy.filter(
        (p) => p.keyword !== keyword || !('rtnPatCharsOpt' in p),
      )
    })
  }

  // These are all 'K' -> simply remove from cleanPolicy.
  if (retainInstitutionIdentityOption) {
    cleanPolicy = cleanPolicy.filter((p) => !('rtnInstIdOpt' in p))
  }

  const datesToRetain = new Set<string>()
  // On any date modifications, consider retainDeviceIdentityOption
  if (
    retainLongitudinalTemporalInformationOptions !== 'Full' &&
    retainDeviceIdentityOption
  ) {
    cleanPolicy.forEach((p) => {
      if (
        'rtnDevIdOpt' in p &&
        // We still remove the 'C's which are mostly AETitles
        p.rtnDevIdOpt === 'K' &&
        temporalVr(getVr(p.keyword))
      ) {
        datesToRetain.add(p.keyword)
      }
    })
  }

  // Now that we know the dates to maintain, we can apply retainDeviceInfoOption
  if (retainDeviceIdentityOption) {
    cleanPolicy = cleanPolicy.filter((p) => p.rtnDevIdOpt !== 'K')
  }

  // Any level of keeping or offsetting longitudinal info, remove them from cleanPolicy
  if (retainLongitudinalTemporalInformationOptions !== 'Off') {
    // Just remove all temporal VRs from cleanPolicy, that's it.
    cleanPolicy = cleanPolicy.filter((p) => !temporalVr(getVr(p.keyword)))
  }

  const cleanPolicyMap = Object.fromEntries(
    cleanPolicy.map((item) => [item.keyword, item]),
  )

  // Now collect the standard mappings with a
  // recursive function to handle sequences (naturalData is a top-level instance of data).
  // Calls modify mapResults in the outer function scope.
  function collectMappingsInData(data: TNaturalData, path = '') {
    // names here can have a 'RETIRED_' prefix!
    for (const name in data) {
      if (/^_.*/.test(name)) {
        continue // ignore tags marked internal with leading underscore
      }
      const attrPath = path + name
      if (name in nameMap) {
        // means it's a known name
        const vr = nameMap[name].vr

        // Remove optional RETIRED_ prefix as below we check against
        // dictionaries that don't work this way.
        const normalName = removeRetiredPrefix(name)
        if (
          // We should clean it
          normalName in cleanPolicyMap &&
          // Either cleanDescOpt is off (we handle those separately) or
          // if it's on, it's not one of the exception tags
          (!cleanDescriptorsOption ||
            cleanDescriptorsExceptions === false ||
            !cleanDescriptorsExceptions.includes(normalName)) &&
          // No condition for an exception applies
          !cleanPolicyMap[normalName].exceptCondition?.(data) &&
          data[name] !== ''
        ) {
          const { rule } = cleanPolicyMap[normalName]
          switch (rule) {
            case 'Z': {
              mapResults.mappings[attrPath] = [
                data[name],
                'replace',
                'PS3.15E',
                vr === 'SQ' ? [] : '',
              ]
              break
            }
            case 'D': {
              mapResults.mappings[attrPath] = [
                data[name],
                'replace',
                'PS3.15E',
                dummyValues[vr],
              ]
              break
            }
            default: {
              if (rule !== 'X') {
                mapResults.anomalies.push(
                  `don't know how to handle PS3.15E rule ${rule} for ${normalName}.`,
                )
              }
              mapResults.mappings[attrPath] = [
                data[name],
                'delete',
                'PS3.15E',
                undefined,
              ]
            }
          }
        } else if (temporalVr(vr) && data[name] !== '') {
          // This is a date not in cleanOpts and we proceed per longitud option
          const dateOpt = retainLongitudinalTemporalInformationOptions
          // datesToRetain implies retainDeviceidentifiers option
          if (dateOpt !== 'Full' && !datesToRetain.has(normalName)) {
            if (dateOpt === 'Off') {
              mapResults.mappings[attrPath] = [
                data[name],
                'delete',
                'removeTemporalOpt',
                undefined,
              ]
            } else if (dateOpt === 'Offset') {
              let failed = false

              if (typeof dateOffset !== 'undefined') {
                try {
                  mapResults.mappings[attrPath] = [
                    data[name],
                    'replace',
                    'offsetTemporalOpt',
                    offsetDateTime(data[name], dateOffset),
                  ]
                } catch (e) {
                  failed = true
                  mapResults.errors.push(
                    `Offset calculation failed, date mapping failed for attribute ${attrPath}: "${data[name]}". Removing date.`,
                  )
                }
              } else {
                failed = true
                mapResults.errors.push(
                  `Missing dateOffset, date mapping failed for attribute ${attrPath}: "${data[name]}". Removing date.`,
                )
              }

              if (failed) {
                mapResults.mappings[attrPath] = [
                  data[name],
                  'delete',
                  'removeTemporalOpt',
                  undefined,
                ]
              }
            }
          }
        } else if (
          vr === 'UI' &&
          retainUIDsOption !== 'On' &&
          data[name] !== ''
        ) {
          // Convert UIDs mentioned in 3.15 anyway, and then additionally those
          // that are not well-known class UIDs. The reason for latter is that
          // after subtracting PS3.15 from PS6, we still see instance UIDs such
          // as e.g. ReferencedColorPaletteInstanceUID.
          // Note that we err on the side of privacy; this is not strictly about
          // class vs instance UIDs as we want to de-identify edge cases such as
          // Private Class UIDs as those would be considered identifiable.
          const uid = data[name]
          if (
            // UID explicitly mentioned in PS3.15.
            instanceUids.indexOf(normalName) !== -1 &&
            // UID is not a known class UID.
            !(uid in uidRegistryPS3_06_A1)
          ) {
            // UIDs that need to be mapped
            const mappedUID = protectUid(uid, retainUIDsOption)

            mapResults.mappings[attrPath] = [
              uid,
              'replace',
              'notRetainInstanceUID',
              mappedUID,
            ]
          }
        } else if (
          // PS3.15 E1.1.1, Clean Descriptors:
          // "For example, one approach is to remove all description and
          // comment Attributes except Series Description (0008,103E), since
          // this Attribute rarely contains identifying or diagnosis information
          // yet is typically a reliable source of useful information about the
          // acquisition technique populated automatically from modality device
          // protocols, though it still could be cleaned as described in Note 2"
          // Note: Removes tags which contain Comment|Desciprion at any location
          // inside the string.
          cleanDescriptorsOption &&
          normalName.match(/Comment|Description/) &&
          (cleanDescriptorsExceptions === false ||
            !cleanDescriptorsExceptions.includes(normalName)) &&
          data[name] !== ''
        ) {
          mapResults.mappings[attrPath] = [
            data[name],
            'delete',
            'cleanDescriptors',
            undefined,
          ]
        } else if (
          normalName in retainAdditionalIds &&
          (!retainDeviceIdentityOption ||
            !retainAdditionalIds[normalName] ||
            !retainAdditionalIds[normalName].rtnDevIdOpt) &&
          data[name] !== ''
        ) {
          mapResults.mappings[attrPath] = [
            data[name],
            'delete',
            'notInRtnAdditionalIds',
            undefined,
          ]
        } else if (
          !elementNamesToAlwaysKeepSet.has(normalName) &&
          // Some 3.15 options allow us to keep more of the tagged elements by reducing
          // elements from the cleanProfile.
          // Therefore, after the specific options are applied, elements to keep could be
          // in the taggedps315EElSet.
          !taggedps315EElSet.has(normalName) &&
          data[name] !== ''
        ) {
          mapResults.anomalies.push(
            `instance contains attribute ${normalName} that is not defined in elementNamesToAlwaysKeep.  Marking it for deletion.`,
          )
          mapResults.mappings[attrPath] = [
            data[name],
            'delete',
            'notInElmtsToKeep',
            undefined,
          ]
        }

        // Sequences can also be descriptors, so recurse into them outside the
        // if/else conditions, as there is no need to recurse if the SQ has been
        // marked for (full) replace or deletion before.
        if (vr === 'SQ' && !mapResults.mappings[attrPath]) {
          let subDataIndex = 0
          for (const subData of Object.values(data[name]) as TNaturalData[]) {
            const subPath = `${path}${name}[${subDataIndex}].`
            collectMappingsInData(subData, subPath)
            subDataIndex += 1
          }
        }
      } else {
        const isUnknownPrivateTag =
          /^[0-9A-Fa-f]{8}$/.test(name) &&
          (Number(name[3]) % 2 === 1 ||
            name[3] === 'B' ||
            name[3] === 'D' ||
            name[3] === 'F')
        // We have no dictionary entry for this.
        if (isUnknownPrivateTag) {
          // Private tag handling.
          // TODO: add option for `allowlist` of private tags taken from 3.15E and TCIA table
          if (retainSafePrivateOption === 'Off') {
            mapResults.mappings[attrPath] = [
              data[name],
              'delete',
              'notRetainSafePrivate',
              undefined,
            ]
          } else {
            // We keep the private tag but register its value for checking.
            // Store the full DICOM element structure, not just the value
            // For private tags, we need to preserve the original structure
            const originalElement = getOriginalDicomElement(path, name)
            if (originalElement) {
              // Store the original DICOM element structure (with vr and Value)
              mapResults.quarantine[attrPath] = originalElement
            } else {
              // Fallback to the naturalized value if original not available
              mapResults.quarantine[attrPath] = data[name]
            }
          }
        } else {
          mapResults.anomalies.push(
            `instance contains attribute ${name} that is not in dictionary.  Marking it for deletion.`,
          )
          mapResults.mappings[attrPath] = [
            data[name],
            'delete',
            'notInDcmjsDictionary',
            undefined,
          ]
        }
      }
    }
  }

  collectMappingsInData(naturalData)

  Object.entries(getDcmOrganizeStamp(dicomPS315EOptions)).forEach(
    ([attrPath, newValue]) => {
      const oldValue = _get(naturalData, attrPath)
      if (oldValue !== newValue) {
        mapResults.mappings[attrPath] = [
          oldValue,
          'replace',
          'dicom-curate',
          newValue,
        ]
      }
    },
  )
}

export const defaultPs315Options: TPs315Options = {
  cleanDescriptorsOption: true,
  cleanDescriptorsExceptions: [],
  retainLongitudinalTemporalInformationOptions: 'Off',
  retainPatientCharacteristicsOption: false,
  retainDeviceIdentityOption: false,
  retainUIDsOption: 'Off',
  retainSafePrivateOption: 'Off',
  retainInstitutionIdentityOption: false,
}
