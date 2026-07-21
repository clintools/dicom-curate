import type { TNaturalData } from 'dcmjs'
import * as dcmjs from 'dcmjs'
import { get as _get } from 'lodash'
import { getCsvMapping, type TColumnMappings } from './csvMapping'
import { protectUid as rawProtectUid } from './deidentifyPS315E'
import type { TCurationSpecification, TParser } from './types'

export const FILEBASENAME: symbol = Symbol('fileBasename')
export const FILENAME: symbol = Symbol('filename')

export default function getParser(
  inputPathPattern: string,
  inputFilePath: string,
  naturalData: TNaturalData,
  dicomPS315EOptions: TCurationSpecification['dicomPS315EOptions'],
  columnMappings?: TColumnMappings,
  additionalData?: TCurationSpecification['additionalData'],
  naturalMetaData?: TNaturalData,
): TParser {
  function protectUid(uid: string): string {
    let protectedUid = uid

    if (dicomPS315EOptions !== 'Off') {
      const { retainUIDsOption } = dicomPS315EOptions

      protectedUid = rawProtectUid(uid, retainUIDsOption)
    }

    return protectedUid
  }

  function getDicom(attrName: string) {
    if (attrName in dcmjs.data.DicomMetaDictionary.dictionary) {
      // if in hex like "(0008,0100)", convert to text key
      attrName = dcmjs.data.DicomMetaDictionary.dictionary[attrName].name
    }
    // Use lodash _get to resolve nested DICOM attribute paths
    return _get(naturalData, attrName)
  }

  function getFilePathComp(
    component: string | number | typeof FILENAME | typeof FILEBASENAME,
  ) {
    const patternParts = inputPathPattern.split('/')
    const fileParts = inputFilePath.split('/')

    let idx: number
    if (typeof component === 'number') {
      // numeric indexing (supports negatives)
      idx =
        component < 0
          ? fileParts.length + component // -1 → last, -2 → second-to-last, etc.
          : component
    } else if (typeof component === 'symbol') {
      // force last‐segment lookup on FILENAME or FILEBASENAME
      idx = fileParts.length - 1
    } else {
      // string lookup against pattern
      idx = patternParts.indexOf(component)
    }

    // return the segment if in range, else empty string
    const segment = fileParts[idx] ?? ''

    // Return last component without a suffix
    if (component === FILEBASENAME) {
      return segment.replace(/\.[^/.]+$/, '')
    }

    return segment
  }

  function getFrom(source: string, identifier: string) {
    return source === 'dicom'
      ? getDicom(identifier)
      : getFilePathComp(identifier)
  }

  const getMapping =
    !additionalData || !additionalData.mapping || !columnMappings
      ? undefined
      : // key: one of the keys defined in the `mapping` object
        (() => {
          const mapping = additionalData.mapping
          return function getMapping(key: string) {
            const { value: valueFn } = mapping[key]
            const value = valueFn({ getDicom, getFilePathComp, getFrom })

            return getCsvMapping(columnMappings, mapping, key, value)
          }
        })()

  // Reads the file meta information group (group 0002), which getDicom cannot
  // see because it operates on the dataset alone. Needed to identify a file by
  // MediaStorageSOPClassUID (e.g. for a DICOMDIR disguised as a .DCM).
  //
  // Values are always the ORIGINAL ones, even in postExclude where getDicom has
  // already switched to de-identified values — the meta group is captured once
  // and never re-read. Only string values are returned; a non-string meta value
  // (e.g. the OB FileMetaInformationVersion) reads as undefined.
  function getMetaDicom(attrName: string): string | undefined {
    if (!naturalMetaData) return undefined
    if (attrName in dcmjs.data.DicomMetaDictionary.dictionary) {
      // if in hex like "(0002,0002)", convert to text key
      attrName = dcmjs.data.DicomMetaDictionary.dictionary[attrName].name
    }
    const value = _get(naturalMetaData, attrName)
    return typeof value === 'string' ? value : undefined
  }

  function missingDicom(attrName: string) {
    const value = getDicom(attrName)
    return typeof value === 'undefined' || value === ''
  }

  return {
    getFrom,
    getFilePathComp,
    getMapping,
    getDicom,
    getMetaDicom,
    missingDicom,
    protectUid,
    // TODO: Phase this out in favor of ISO8601 duration handling.
    // Example of this logic:
    // ContentDate:
    //   parser.addDays(parser.getDicom('StudyDate'), parser.getMapping(
    //     parser.getDicom('PatientID'), 'CURR_ID', 'DATE_OFFSET')),
    addDays: (dicomDateString: string, offsetDays: number) => {
      const year = Number(dicomDateString.slice(0, 4))
      const monthIndex = Number(dicomDateString.slice(4, 6)) - 1
      const day = Number(dicomDateString.slice(6, 8))
      const date = new Date(year, monthIndex, day)
      let time = date.getTime()
      const millisecondsPerDay = 1000 * 60 * 60 * 24
      time += offsetDays * millisecondsPerDay
      date.setTime(time)
      const yearString = date.getFullYear()
      const monthString = (date.getMonth() + 1).toString().padStart(2, '0')
      const dayString = date.getDate().toString().padStart(2, '0')
      return yearString + monthString + dayString
    },
    FILENAME,
    FILEBASENAME,
  }
}
