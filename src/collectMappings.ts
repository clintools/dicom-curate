import * as dcmjs from 'dcmjs'
import { composeSpecs } from './composeSpecs'
import deidentifyPS315E from './deidentifyPS315E'
import getParser from './getParser'
import { get as _get } from 'lodash'

import type { TMappingOptions, TMapResults } from './types'
import type { TDicomData, TNaturalData } from 'dcmjs'

export default function collectMappings(
  inputFilePath: string,
  inputFileIndex: number,
  dicomData: TDicomData,
  mappingOptions: TMappingOptions,
): [TNaturalData, TMapResults] {
  const mapResults: TMapResults = {
    // original UID for this dicomData
    sourceInstanceUID: '',
    // assembled string of path components
    outputFilePath: '',
    mappings: {},
    // a list of text strings describing any unexpected contents of the data
    anomalies: [],
    errors: [],
    quarantine: {},
  }

  if (mappingOptions.curationSpec === 'none') {
    return [
      dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomData.dict),
      mapResults,
    ]
  }

  // Make make the naturalized data so parser code operates on with tags not hex
  const naturalData = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dicomData.dict,
  )
  mapResults.sourceInstanceUID = naturalData.SOPInstanceUID

  const finalSpec = composeSpecs(mappingOptions.curationSpec())

  // protect filename if we de-identify
  const finalFilePath =
    finalSpec.dicomPS315EOptions === 'Off'
      ? inputFilePath
      : inputFilePath.slice(0, inputFilePath.lastIndexOf('/') + 1) +
        `${String(inputFileIndex + 1).padStart(5, '0')}.dcm`

  // create a parser object to be used in the eval'ed mappingFunctions
  const parser = getParser(
    finalSpec.inputPathPattern,
    finalFilePath,
    naturalData,
    finalSpec.dicomPS315EOptions,
    mappingOptions.columnMappings,
    finalSpec.additionalData,
  )

  // List all validation errors
  if (!mappingOptions.skipValidation) {
    mapResults.errors = finalSpec
      .errors(parser)
      .filter(([, failure]) => failure)
      .map(([message]) => message)
  }

  // Return listing for the "two-pass add mapping" scenario
  if (finalSpec.additionalData?.type === 'listing') {
    const { lookups, info, collect } = finalSpec.additionalData.collect(parser)
    const collectByValue = collect.map((item) => {
      const [, , lookupField] = item
      const lookupValue = lookups[lookupField]
      return [...item, lookupValue] as [...typeof item, typeof lookupValue]
    })

    // FIXME: Bug in dcmjs
    const cleanedInfo = info.map((item) => {
      if (
        Array.isArray(item[1]) &&
        item[1].length === 1 &&
        typeof item[1][0] === 'object' &&
        'Alphabetic' in item[1][0] &&
        /^\d+$/.test(item[1][0].Alphabetic)
      ) {
        return [item[0], item[1][0].Alphabetic] as typeof item
      } else {
        return item
      }
    })

    mapResults.listing = { info: cleanedInfo, collectByValue }
  }

  if (!mappingOptions.skipModifications) {
    mapResults.outputFilePath = finalSpec
      .outputFilePathComponents(parser)
      .join('/')
  }

  if (finalSpec.dicomPS315EOptions !== 'Off') {
    deidentifyPS315E({
      naturalData,
      dicomPS315EOptions: finalSpec.dicomPS315EOptions,
      dateOffset: mappingOptions.dateOffset,
      mapResults,
      originalDicomDict: dicomData.dict,
    })
  }

  // Moving this after collectMappingsInData as this should take precedence.
  // collect the tag mappings before assigning them into dicomData
  // - Note the mappingFunctions return a dictionary called 'dicomModifications' of functions to call
  //   for each tag they want to map
  if (!mappingOptions.skipModifications) {
    const dicomMap = finalSpec.modifyDicomHeader(parser)
    for (let attrPath in dicomMap) {
      // This overrides any default action if attrPath is the same
      mapResults.mappings[attrPath] = [
        _get(naturalData, attrPath),
        'replace',
        'mappingFunction',
        dicomMap[attrPath],
      ]
    }
  }

  return [naturalData, mapResults]
}
