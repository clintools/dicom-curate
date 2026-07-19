/**
 * Regexes matched against normalised violation keys (`severity::tagPath::message`).
 * Document new entries in conformance/README.md (Allowlist) before adding.
 */
export const CONFORMANCE_ALLOWLIST: RegExp[] = [
  // Which attributes belong to an IOD depends on the dciodvfy build's data
  // dictionary, so this warning set differs across dicom3tools versions
  // (local vs CI apt) and can never match a pinned baseline.
  /^Warning::.*::Attribute is not present in standard DICOM IOD$/,
]
