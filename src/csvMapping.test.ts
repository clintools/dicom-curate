import {
  extractColumnMappings,
  extractCsvMappings,
  getCsvMapping,
  type Row,
  type TMappedValues,
} from './csvMapping'

const csvText = 'old,new,ignore\noldV1,newV1,ignoreV1\noldV2,newV2,ignoreV2\n'

const mapping: TMappedValues = {
  oldToNew: {
    value: () => 'unused',
    lookup: (row: Row) => row['old'],
    replace: (row: Row) => row['new'],
  },
  newToOld: {
    value: () => 'unused',
    lookup: (row: Row) => row['new'],
    replace: (row: Row) => row['old'],
  },
}

describe('extractCsvMappings', () => {
  it('extracts column mappings from CSV text', () => {
    expect(extractCsvMappings(csvText, mapping)).toEqual({
      rows: [
        { old: 'oldV1', new: 'newV1', ignore: 'ignoreV1' },
        { old: 'oldV2', new: 'newV2', ignore: 'ignoreV2' },
      ],
      rowIndexByFieldValue: {
        oldToNew: { oldV1: 0, oldV2: 1 },
        newToOld: { newV1: 0, newV2: 1 },
      },
    })
  })

  it('gets the correct mapping for a given value', () => {
    const columnMappings = extractCsvMappings(csvText, mapping)

    expect(getCsvMapping(columnMappings, mapping, 'oldToNew', 'oldV1')).toEqual(
      'newV1',
    )

    expect(getCsvMapping(columnMappings, mapping, 'oldToNew', 'oldV2')).toEqual(
      'newV2',
    )

    expect(getCsvMapping(columnMappings, mapping, 'newToOld', 'newV1')).toEqual(
      'oldV1',
    )
  })
})

describe('extractColumnMappings with 2-key specification', () => {
  const rows = [
    {
      PatNamePatId: 'Pi^Jane=1234',
      CenterSubjectId: 'XX01-003',
      PatNameIDSeriesDesc: 'Pi^Jane=1234=Custom CT',
      Timepoint: 'Visit 1',
      ScanName: 'CT',
      Comment: '',
    },
    {
      PatNamePatId: 'Pi^Jane=1234',
      CenterSubjectId: 'XX01-003',
      PatNameIDSeriesDesc: 'Pi^Jane=1234=Head_SAG T1 IRSPGR 1mm ISO',
      Timepoint: 'Visit 2',
      ScanName: 'PET-CT',
      Comment: '',
    },
    {
      PatNamePatId: 'Doe^John=ABCD',
      CenterSubjectId: 'NN01-001',
      PatNameIDSeriesDesc: 'Doe^John=ABCD=PET TK AC PSMA',
      Timepoint: 'Visit 3',
      ScanName: 'PET',
      Comment: '',
    },
    {
      PatNamePatId: 'Doe^John=ABCD',
      CenterSubjectId: 'NN01-001',
      PatNameIDSeriesDesc: 'Doe^John=ABCD=Custom CT',
      Timepoint: 'Visit 3',
      ScanName: 'CT',
      Comment: '',
    },
  ]

  const mapping2: TMappedValues = {
    centerSubjectId: {
      value: (parser) =>
        ['PatientName', 'PatientID'].map(parser.getDicom).join('='),
      lookup: (row) => row['PatNamePatId'],
      replace: (row) => row['CenterSubjectId'],
    },
    timepoint: {
      value: (parser) =>
        ['PatientName', 'PatientID', 'SeriesDescription']
          .map(parser.getDicom)
          .join('='),
      lookup: (row) => row['PatNameIDSeriesDesc'],
      replace: (row) => row['Timepoint'],
    },
    scanName: {
      value: (parser) =>
        ['PatientName', 'PatientID', 'SeriesDescription']
          .map(parser.getDicom)
          .join('='),
      lookup: (row) => row['PatNameIDSeriesDesc'],
      replace: (row) => row['ScanName'],
    },
  }

  it('extracts column mappings for a 2-key specification', () => {
    expect(extractColumnMappings(rows, mapping2)).toEqual({
      rowIndexByFieldValue: {
        centerSubjectId: {
          // Multiple rows can have the same PatNamePatId, we expect them
          // all to have the same value (here, same centerSubjectId)
          'Doe^John=ABCD': 3,
          'Pi^Jane=1234': 1,
        },
        scanName: {
          'Doe^John=ABCD=Custom CT': 3,
          'Doe^John=ABCD=PET TK AC PSMA': 2,
          'Pi^Jane=1234=Custom CT': 0,
          'Pi^Jane=1234=Head_SAG T1 IRSPGR 1mm ISO': 1,
        },
        timepoint: {
          'Doe^John=ABCD=Custom CT': 3,
          'Doe^John=ABCD=PET TK AC PSMA': 2,
          'Pi^Jane=1234=Custom CT': 0,
          'Pi^Jane=1234=Head_SAG T1 IRSPGR 1mm ISO': 1,
        },
      },
      rows: [
        {
          CenterSubjectId: 'XX01-003',
          Comment: '',
          PatNameIDSeriesDesc: 'Pi^Jane=1234=Custom CT',
          PatNamePatId: 'Pi^Jane=1234',
          ScanName: 'CT',
          Timepoint: 'Visit 1',
        },
        {
          CenterSubjectId: 'XX01-003',
          Comment: '',
          PatNameIDSeriesDesc: 'Pi^Jane=1234=Head_SAG T1 IRSPGR 1mm ISO',
          PatNamePatId: 'Pi^Jane=1234',
          ScanName: 'PET-CT',
          Timepoint: 'Visit 2',
        },
        {
          CenterSubjectId: 'NN01-001',
          Comment: '',
          PatNameIDSeriesDesc: 'Doe^John=ABCD=PET TK AC PSMA',
          PatNamePatId: 'Doe^John=ABCD',
          ScanName: 'PET',
          Timepoint: 'Visit 3',
        },
        {
          CenterSubjectId: 'NN01-001',
          Comment: '',
          PatNameIDSeriesDesc: 'Doe^John=ABCD=Custom CT',
          PatNamePatId: 'Doe^John=ABCD',
          ScanName: 'CT',
          Timepoint: 'Visit 3',
        },
      ],
    })
  })
})
