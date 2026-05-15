# E2E smoke tests

Minimal system-level checks for Dicom Curate: temp input/output dirs, real scan and mapping workers (from `dist/esm/`), and assertions on outputs plus unchanged sources.

## Run

```bash
pnpm test:e2e
```

This runs `pnpm build:esm` first, then Vitest with `vitest.e2e.config.ts`. Unit/integration tests under `src/` are excluded from the default `pnpm test` run via `e2e/**` in the main Vitest config.

## Scenarios

| Test | What it exercises |
|------|-------------------|
| Single valid DICOM | One file under `study/subject/`, curated output path, source hash unchanged |
| Multiple files | `createTestDicomDir(3)` batch layout, three outputs |
| Empty input directory | Scan + mapping workers complete with zero files, no outputs |
| PS3.15 de-identification | Built pipeline with `dicomPS315EOptions` enabled (not `Off`) |
| Progress callback | `onProgress` receives a terminal `done` message |
| Invalid / problem files | Valid DICOM plus non-DICOM and bad signature; anomalies in `mapResultsList`, only valid file written |

## Layout

- `e2e/smoke.test.ts` — `curateMany` scenarios
- `e2e/helpers.ts` — workspace, overlap guard, hashes, minimal specs
- Reuses `testutils/minimalDicom.ts` and `testutils/dicomFixtures.ts`

## CI

After `pnpm build`, run `pnpm exec vitest run --config vitest.e2e.config.ts --pool=forks` (build already produced `dist/esm/` workers).
