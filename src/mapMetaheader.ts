import type { DicomDataset } from 'dcmjs'
import * as dcmjs from 'dcmjs'
import { metaheaderTagsToKeep } from './config/dicom/metaheaderTagsToKeep'

const EXPLICIT_LITTLE_ENDIAN = '1.2.840.10008.1.2.1'

export default function mapMetaheader(
  metaHeader: DicomDataset,
  // mapped UID or original depending on activated PS3.15E option
  newInstanceUid: string,
) {
  const naturalMetadata =
    dcmjs.data.DicomMetaDictionary.naturalizeDataset(metaHeader)
  // keep only the bare set of tags needed to make valid metaheader
  for (const tag in naturalMetadata) {
    if (metaheaderTagsToKeep.indexOf(tag) === -1) {
      delete naturalMetadata[tag]
    }
  }
  // Update the instance UID
  naturalMetadata.MediaStorageSOPInstanceUID = newInstanceUid
  // TransferSyntaxUID is preserved from the original metaheader (included in metaheaderTagsToKeep)
  // If missing, set a default
  if (!naturalMetadata.TransferSyntaxUID) {
    naturalMetadata.TransferSyntaxUID = EXPLICIT_LITTLE_ENDIAN
  }
  const mappedMetaheader =
    dcmjs.data.DicomMetaDictionary.denaturalizeDataset(naturalMetadata)
  return mappedMetaheader
}
