import picomatch from 'picomatch'

/**
 * Tests for excludedPathGlobs feature.
 *
 * The excludedPathGlobs option on OrganizeOptions accepts glob patterns
 * (picomatch syntax) that are converted to regexes in the main thread
 * and passed to the scan worker. The worker tests each file path against
 * these regexes to decide whether to skip scanning.
 *
 * Paths tested are full file paths as seen by the scanner:
 * - S3: the full object key (e.g., "study_test/logs/file.txt")
 * - Filesystem: relative path from the input directory root (e.g., "myDir/logs/file.txt")
 * - Browser: prefix/filename built during directory traversal
 */
describe('excludedPathGlobs', () => {
  // Helper: convert a glob to a regex (same as curateMany does) and test a path
  function matchesGlob(glob: string, path: string): boolean {
    const regex = picomatch.makeRe(glob)
    return regex.test(path)
  }

  describe('**/logs/** pattern', () => {
    const pattern = '**/logs/**'

    it('matches file path with logs directory', () => {
      expect(matchesGlob(pattern, 'study_test/logs/output.txt')).toBe(true)
    })

    it('matches file path with nested logs directory', () => {
      expect(matchesGlob(pattern, 'study_test/sub/logs/output.txt')).toBe(true)
    })

    it('matches deep file path in logs', () => {
      expect(
        matchesGlob(pattern, 'study_test/logs/subdir/report_20260305.txt'),
      ).toBe(true)
    })

    it('does not match file path without logs directory', () => {
      expect(
        matchesGlob(
          pattern,
          'study_test/provider/subject/timepoint/scan/file.dcm',
        ),
      ).toBe(false)
    })

    it('matches bare "logs" path (picomatch ** matches zero segments after)', () => {
      // This is expected: **/logs/** matches "study_test/logs" because ** can
      // match zero trailing segments. In practice, actual files always have
      // content after the directory, so this edge case is harmless.
      expect(matchesGlob(pattern, 'study_test/logs')).toBe(true)
    })

    it('matches relative file path with logs directory', () => {
      expect(matchesGlob(pattern, 'myDir/logs/output.txt')).toBe(true)
    })
  })

  describe('**/.hidden_dir/** pattern', () => {
    const pattern = '**/.hidden_dir/**'

    it('matches hidden directory', () => {
      expect(matchesGlob(pattern, 'myDir/.hidden_dir/results.json')).toBe(true)
    })

    it('does not match regular file path', () => {
      expect(matchesGlob(pattern, 'myDir/patient/scan/file.dcm')).toBe(false)
    })
  })

  describe('**/cache.json pattern', () => {
    const pattern = '**/cache.json'

    it('matches cache.json at any depth', () => {
      expect(matchesGlob(pattern, 'myDir/cache.json')).toBe(true)
    })

    it('matches cache.json at root', () => {
      expect(matchesGlob(pattern, 'cache.json')).toBe(true)
    })

    it('does not match other json files', () => {
      expect(matchesGlob(pattern, 'myDir/other.json')).toBe(false)
    })
  })

  describe('patterns should not match DICOM file paths', () => {
    const patterns = ['**/logs/**', '**/.hidden_dir/**', '**/cache.json']

    const dicomPaths = [
      'study_test/provider/XX01_0001/Baseline/CT/00001.dcm',
      'study_test/provider/XX01_0001/Baseline/PT-ORIGINAL_PRIMARY=3/00013.dcm',
      'myDir/patient/scan/file.dcm',
      'data/file',
    ]

    for (const dicomPath of dicomPaths) {
      it(`none of the patterns match "${dicomPath}"`, () => {
        for (const pattern of patterns) {
          expect(matchesGlob(pattern, dicomPath)).toBe(false)
        }
      })
    }
  })

  describe('regex serialization round-trip', () => {
    it('regex source string can be reconstructed in worker', () => {
      const glob = '**/logs/**'
      const regex = picomatch.makeRe(glob)
      const serialized = regex.source

      // Simulate what the worker does: reconstruct from source string
      const reconstructed = new RegExp(serialized)

      expect(reconstructed.test('study_test/logs/file.txt')).toBe(true)
      expect(reconstructed.test('study_test/provider/file.dcm')).toBe(false)
    })

    it('handles multiple patterns', () => {
      const globs = ['**/logs/**', '**/.hidden_dir/**']
      const regexSources = globs.map((g) => picomatch.makeRe(g).source)

      // Simulate worker compilation
      const regexes = regexSources.map((s) => new RegExp(s))

      const logPath = 'study_test/logs/output.txt'
      expect(regexes.some((re) => re.test(logPath))).toBe(true)

      const dicomPath = 'study_test/provider/file.dcm'
      expect(regexes.some((re) => re.test(dicomPath))).toBe(false)
    })
  })
})
