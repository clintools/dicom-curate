import * as dcmjs from 'dcmjs'
import collectMappings from './collectMappings'
import mapMetaheader from './mapMetaheader'
import { convertKeywordPathToTagIdPath } from './config/dicom/tagConversion'
import type { TDicomData } from 'dcmjs'
import type { TMappingOptions } from './types'

import { set as _set, unset as _unset, cloneDeep as _cloneDeep } from 'lodash'

export default function curateDict(
  inputFilePath: string,
  inputFileIndex: number,
  dicomData: TDicomData,
  mappingOptions: TMappingOptions,
) {
  //
  // Collect the mappings and apply them to the data
  //
  const [naturalData, mapResults] = collectMappings(
    inputFilePath,
    inputFileIndex,
    dicomData,
    mappingOptions,
  )
  for (let tagPath in mapResults.mappings) {
    const [, operation, , mappedValue] = mapResults.mappings[tagPath]
    switch (operation) {
      case 'delete':
        _unset(naturalData, tagPath)
        break
      case 'replace':
        _set(naturalData, tagPath, mappedValue)
        break
      default:
        console.error(`Bad operation ${operation} in mappings`)
    }
  }

  // apply a hard-coded mapping to the metaheader data since
  // it is of a highly constrained format
  const mappedDicomData = new dcmjs.data.DicomDict(
    // Depending on PS315E UID option, mapped uid or not.
    mapMetaheader(dicomData.meta, naturalData.SOPInstanceUID),
  )
  mappedDicomData.dict =
    dcmjs.data.DicomMetaDictionary.denaturalizeDataset(naturalData)

  // Restore quarantined private tags directly to the final DICOM dict
  // This must be done after denaturalization since private tags aren't in the dictionary
  for (let tagPath in mapResults.quarantine) {
    const quarantinedElement = mapResults.quarantine[tagPath]
    if (!quarantinedElement) continue

    // Convert keyword paths to tag ID paths for restoration
    const tagIdPath = convertKeywordPathToTagIdPath(tagPath)

    // If the quarantined element has DICOM structure (vr and Value), restore it directly
    if (
      quarantinedElement &&
      typeof quarantinedElement === 'object' &&
      'Value' in (quarantinedElement as Partial<{ Value: unknown }>)
    ) {
      // Handle nested paths like "00080413[0].00510014"
      const pathParts = tagIdPath.split('.')
      if (pathParts.length === 2 && pathParts[0].includes('[')) {
        // This is a nested path, handle it specially
        const [sequenceWithIndex, privateTagId] = pathParts
        const arrayMatch = sequenceWithIndex.match(/^(.+)\[(\d+)\]$/)
        if (arrayMatch) {
          const [, sequenceTagId, index] = arrayMatch
          let sequence = mappedDicomData.dict[sequenceTagId]

          // If the sequence doesn't exist, we need to create it
          if (!sequence) {
            // Create the sequence with the private tag already included
            const sequenceItemWithPrivateTag = {
              [privateTagId]: quarantinedElement,
            }
            sequence = {
              vr: 'SQ',
              Value: [sequenceItemWithPrivateTag],
            }
            mappedDicomData.dict[sequenceTagId] = sequence
          } else {
            // Ensure the sequence has a Value array
            if (!sequence.Value) {
              sequence.Value = []
            }

            // Ensure we have enough items in the sequence
            while (sequence.Value.length <= parseInt(index)) {
              sequence.Value.push({})
            }

            if (sequence && sequence.Value && sequence.Value[parseInt(index)]) {
              // Ensure the sequence item is properly structured
              const sequenceItem = sequence.Value[parseInt(index)]

              if (typeof sequenceItem === 'object' && sequenceItem !== null) {
                // Create a new object with the private tag included
                const newSequenceItem = {
                  ...sequenceItem,
                  [privateTagId]: quarantinedElement,
                }
                sequence.Value[parseInt(index)] = newSequenceItem
              }
            }
          }
        }
      } else {
        // Top-level private tag
        _set(mappedDicomData.dict, tagIdPath, quarantinedElement)
      }
    } else {
      // For raw values, we need to create a proper DICOM element structure
      // This is a fallback - ideally all quarantined elements should have proper structure
      _set(mappedDicomData.dict, tagIdPath, {
        vr: 'UN', // Unknown VR for private tags
        Value: Array.isArray(quarantinedElement)
          ? quarantinedElement
          : [quarantinedElement],
      })
    }
  }

  // NOTE: structuredClone would be faster but can't handle functions in mapResults
  // TODO: Investigate if we can avoid cloning entirely or use a shallow clone
  return { dicomData: mappedDicomData, mapResults: _cloneDeep(mapResults) }
}
