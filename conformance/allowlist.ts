/**
 * Regexes matched against normalised violation keys (`severity::tagPath::message`).
 * Document new entries in conformance/README.md (Allowlist) before adding.
 */
export const CONFORMANCE_ALLOWLIST: RegExp[] = [
  // Which attributes belong to an IOD depends on the dciodvfy build's data
  // dictionary *and* the environment it runs in: the same pinned snapshot
  // emits members on macOS/arm64 that CI's x86_64 Linux does not, so this
  // warning set can never match a pinned baseline.
  /^Warning::.*::Attribute is not present in standard DICOM IOD$/,
]
