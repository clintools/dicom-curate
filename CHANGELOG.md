## [0.20.2](https://github.com/clintools/dicom-curate/compare/v0.20.1...v0.20.2) (2026-02-18)

### Performance Improvements

- read only 4 bytes for DICOM signature check in Node scanner ([0118264](https://github.com/clintools/dicom-curate/commit/01182640059388b69931645cb4c8acac5e86abcd))

## [0.20.1](https://github.com/clintools/dicom-curate/compare/v0.20.0...v0.20.1) (2026-02-18)

### Bug Fixes

- handle scan worker errors to prevent pipeline deadlock ([229f2ae](https://github.com/clintools/dicom-curate/commit/229f2ae3e9251b62ab11b4c7990d3c0a5d71420f))
- pass mapping errors back to progress callback ([b9b4087](https://github.com/clintools/dicom-curate/commit/b9b40875d501121375c0a04bd2548ce6904f0e44))

# [0.20.0](https://github.com/clintools/dicom-curate/compare/v0.19.0...v0.20.0) (2026-02-10)

### Features

- update repository config in package json for oidc releases ([#208](https://github.com/clintools/dicom-curate/issues/208)) ([46a7af5](https://github.com/clintools/dicom-curate/commit/46a7af5b184abdef432fb7796c7463bff4263257))

# [0.19.0](https://github.com/clintools/dicom-curate/compare/v0.18.0...v0.19.0) (2026-02-10)

### Features

- trigger semantic-release ([8ed3845](https://github.com/clintools/dicom-curate/commit/8ed3845ac026f4c24a312be4c0c6731c936a4be5))

# [0.18.0](https://github.com/clintools/dicom-curate/compare/v0.17.0...v0.18.0) (2026-02-10)

### Features

- lint files and trigger release ([ea0351a](https://github.com/clintools/dicom-curate/commit/ea0351a6443879ec88898baf72d5861f7be4ccb6))

# [0.17.0](https://github.com/clintools/dicom-curate/compare/v0.16.1...v0.17.0) (2026-02-10)

### Features

- add support for nested path access in getDicom ([0629d2a](https://github.com/clintools/dicom-curate/commit/0629d2ae84504516a642b223fa02da4a1c31fb8f))

## [0.16.1](https://github.com/bebbi/dicom-curate/compare/v0.16.0...v0.16.1) (2025-12-09)

### Bug Fixes

- provide correct outputFilePath for skipped files ([14aa187](https://github.com/bebbi/dicom-curate/commit/14aa1872a41ba085a5bbf95346975d3196bacfc7))

# [0.16.0](https://github.com/bebbi/dicom-curate/compare/v0.15.1...v0.16.0) (2025-12-04)

### Features

- allow THTTPHeaderProvider to be async ([1391081](https://github.com/bebbi/dicom-curate/commit/1391081b54ff3f5e2306baa9051430b7f7c10195))

## [0.15.1](https://github.com/bebbi/dicom-curate/compare/v0.15.0...v0.15.1) (2025-12-04)

### Bug Fixes

- replace iso8601-duration toSeconds date arithmetic with native js date calcs ([ce1ad51](https://github.com/bebbi/dicom-curate/commit/ce1ad517687ebf82c731f5cc451b72d2ef75216e))
- use THashMethod type in OrganizeOptions ([b951054](https://github.com/bebbi/dicom-curate/commit/b951054d6540dacb1af931c618a5961b8386b738))

# [0.15.0](https://github.com/bebbi/dicom-curate/compare/v0.14.1...v0.15.0) (2025-11-29)

### Features

- add support for S3 bucket input and output ([1cb82a7](https://github.com/bebbi/dicom-curate/commit/1cb82a70208ca6ae4171c998110681352b0b0308))

## [0.14.1](https://github.com/bebbi/dicom-curate/compare/v0.14.0...v0.14.1) (2025-11-26)

### Bug Fixes

- mantain transferSyntaxUID to avoid corrupted images ([32bfcb6](https://github.com/bebbi/dicom-curate/commit/32bfcb613716ba2d2d90e1b724e351c09cb70d95))

# [0.14.0](https://github.com/bebbi/dicom-curate/compare/v0.13.0...v0.14.0) (2025-11-25)

### Features

- add the option to request HTTP headers dynamically before use ([bdc4af7](https://github.com/bebbi/dicom-curate/commit/bdc4af7e53481069149a27152227b7ad9da365ee))
- do calculate preMappedHash even if we didn't get one to compare it against ([921a4be](https://github.com/bebbi/dicom-curate/commit/921a4beb040552ea7ad65298430cb019c412869a))
- extend README, clean up code and support adding any HTTP header ([b68fb87](https://github.com/bebbi/dicom-curate/commit/b68fb87ac429ae6be487e24913391d38667fea1f))
- have the output filenames prefixed with OUTPUT_FILE_PREFIX in provided file info ([2c831a7](https://github.com/bebbi/dicom-curate/commit/2c831a76dbbb8a705b894f5a234cff312397e9fb))
- implement a first pass at rsync mode with upload to url ([2abcc50](https://github.com/bebbi/dicom-curate/commit/2abcc503dbe343cde59eac13760f39ee233952a6))
- support http input for curation ([da757b7](https://github.com/bebbi/dicom-curate/commit/da757b774f1133ea1df53b3044d15d94edda621b))
- support only having postMappedHash+using target file name in previous file info ([6d3db60](https://github.com/bebbi/dicom-curate/commit/6d3db604bb2d9306365fb9707e1e348324866cf1))

# [0.13.0](https://github.com/bebbi/dicom-curate/compare/v0.12.0...v0.13.0) (2025-11-20)

### Features

- add option to stop collecting TMapResults ([b3bcff2](https://github.com/bebbi/dicom-curate/commit/b3bcff262872eae812838a6235211f80df3e0b58))

# [0.12.0](https://github.com/bebbi/dicom-curate/compare/v0.11.0...v0.12.0) (2025-11-11)

### Features

- ensure patient birth/death date in alt calendar is also protected ([aa64bbe](https://github.com/bebbi/dicom-curate/commit/aa64bbead87323a097b9a64b3080f13eb608b47c))
- manual review and extension of attributes to protect that are not in PS3.15E1.1 ([b47dc7e](https://github.com/bebbi/dicom-curate/commit/b47dc7ee40e9ff809a7100ba43996a90dd6b82b1))

# [0.11.0](https://github.com/bebbi/dicom-curate/compare/v0.10.1...v0.11.0) (2025-11-03)

### Bug Fixes

- fix 'pnpm test' with @noble/hashes ([2943fe4](https://github.com/bebbi/dicom-curate/commit/2943fe43203aa6cdf08982a529075ee64ccc3a34))

### Features

- enable use in Node.JS CJS applications ([38004bf](https://github.com/bebbi/dicom-curate/commit/38004bf4f7b4ed471a5f0902e4d91bf0e30cbbaf))

## [0.10.1](https://github.com/bebbi/dicom-curate/compare/v0.10.0...v0.10.1) (2025-10-30)

### Bug Fixes

- remove retainUidsOption Off completely from the README ([61bf82c](https://github.com/bebbi/dicom-curate/commit/61bf82c8dda94437c1f591e18a98f9e520624038)), closes [#161](https://github.com/bebbi/dicom-curate/issues/161)

# [0.10.0](https://github.com/bebbi/dicom-curate/compare/v0.9.0...v0.10.0) (2025-10-27)

### Features

- handle worker files in UMD build ([43bcf28](https://github.com/bebbi/dicom-curate/commit/43bcf2862eb9605d01101d6855a64b25c49ac073))
- node.js environment support ([9c39240](https://github.com/bebbi/dicom-curate/commit/9c3924009b89fb7011832b93f5adb6269e4fe3c0))

# [0.9.0](https://github.com/bebbi/dicom-curate/compare/v0.8.5...v0.9.0) (2025-10-23)

### Features

- reset scanAnomalies for all input types ([baf945c](https://github.com/bebbi/dicom-curate/commit/baf945c79d19b7b46d6ac7c2bbdaa06ba1ae0246))

## [0.8.5](https://github.com/bebbi/dicom-curate/compare/v0.8.4...v0.8.5) (2025-10-21)

### Bug Fixes

- remove also the remaining caching ([6a9076b](https://github.com/bebbi/dicom-curate/commit/6a9076b6c671ead46dad86896f2c2df5e786eff0))
- remove uid cache due to issues with multiple workers ([d1f1a2e](https://github.com/bebbi/dicom-curate/commit/d1f1a2e70fb4761b1b54657e4d6e2c9c07bbc596))
- remove unique file name check/cache ([0e06103](https://github.com/bebbi/dicom-curate/commit/0e06103bf49b9e4b1af561dcfeaccc6fb103ffca))

## [0.8.4](https://github.com/bebbi/dicom-curate/compare/v0.8.3...v0.8.4) (2025-10-21)

### Bug Fixes

- update release and ci pipelines to include typecheck and lint steps ([ab20cd6](https://github.com/bebbi/dicom-curate/commit/ab20cd61673727f554439d5f8b9e5867ff80d60a))

## [0.8.3](https://github.com/bebbi/dicom-curate/compare/v0.8.2...v0.8.3) (2025-10-20)

### Bug Fixes

- prevent global state mutation in composeSpecs causing stack overflow ([ae8f909](https://github.com/bebbi/dicom-curate/commit/ae8f909488daf248cafef7fe95f3250bd038217a))
- resolve CD linting errors in composeSpecs tests ([819824d](https://github.com/bebbi/dicom-curate/commit/819824d341c8f0e200ff4a4b88017e332339a5d1))

## [0.8.2](https://github.com/bebbi/dicom-curate/compare/v0.8.1...v0.8.2) (2025-09-17)

### Bug Fixes

- add missing conditionals in collectMappings to safely call getMappings ([15bde4f](https://github.com/bebbi/dicom-curate/commit/15bde4f880edb064d34c71a1472f052b00b9f571))

## [0.8.1](https://github.com/bebbi/dicom-curate/compare/v0.8.0...v0.8.1) (2025-09-16)

### Bug Fixes

- fix sample composite spec hostProps context availability ([b537a34](https://github.com/bebbi/dicom-curate/commit/b537a34a3af6c70eb1d082192daa6ea6dcff01fb))

# [0.8.0](https://github.com/bebbi/dicom-curate/compare/v0.7.1...v0.8.0) (2025-09-16)

### Bug Fixes

- exclude RegExp objects from deep merging ([49729f7](https://github.com/bebbi/dicom-curate/commit/49729f7e4048491af6abea79a538893aea7025fa))
- handle empty cleanDescriptorsExceptions arrays for backwards compatibility ([ac943cd](https://github.com/bebbi/dicom-curate/commit/ac943cdd2e0fb2282b9a339d202f1b26d1e0fcf3))
- preserve composeSpecs arrays before spread operation ([412d9b3](https://github.com/bebbi/dicom-curate/commit/412d9b3bc43506e718b0e248101ceac0fd8743a4))

### Features

- add composite spec draft ([1fc5f16](https://github.com/bebbi/dicom-curate/commit/1fc5f1623e44318ed54f3f585daf9d33c477926c))
- add explicit reset support to cleanDescriptorsExceptions ([d751048](https://github.com/bebbi/dicom-curate/commit/d751048ddbeb0fd030f87f0f94cc9c8e7f6774ff))
- export composeSpecs and SpecPart type ([7fb5664](https://github.com/bebbi/dicom-curate/commit/7fb566423896c8c882d9067ded7c06c443be1241))

### Reverts

- Revert "fix: handle empty cleanDescriptorsExceptions arrays for backwards compatibility" ([dad53e2](https://github.com/bebbi/dicom-curate/commit/dad53e2d1f6b141f01d0c37d02ad0d7d7ec966c3))

## [0.7.1](https://github.com/bebbi/dicom-curate/compare/v0.7.0...v0.7.1) (2025-09-09)

### Bug Fixes

- add missing conditional ([dd09a01](https://github.com/bebbi/dicom-curate/commit/dd09a01cb4cb76838a34324ec85b1473bd4df521))
- resolve warning around missing case statement braces ([88b0910](https://github.com/bebbi/dicom-curate/commit/88b091082f188d45167db89948ea67ad4502dbc4))

# [0.7.0](https://github.com/bebbi/dicom-curate/compare/v0.6.1...v0.7.0) (2025-09-02)

### Bug Fixes

- correct wrongly spelled DICOM names (e.g. 'PatientsWeight' is corrected to 'PatientWeight') ([fb4e6a4](https://github.com/bebbi/dicom-curate/commit/fb4e6a4ac0fd185b7cc921bd855295037da7ace7))

### Features

- simplify TCurationSpecification ([40602ec](https://github.com/bebbi/dicom-curate/commit/40602ecd5e2d4c53e26b16c08d66b6cb0acc83a9))

## [0.6.1](https://github.com/bebbi/dicom-curate/compare/v0.6.0...v0.6.1) (2025-09-02)

### Bug Fixes

- add correct block scope for case statements ([cebdd9e](https://github.com/bebbi/dicom-curate/commit/cebdd9ef8c91c2b425187458ff36beb0630d7f12))

# [0.6.0](https://github.com/bebbi/dicom-curate/compare/v0.5.1...v0.6.0) (2025-09-01)

### Features

- handle DICOM files with VR length violations ([d0a23fd](https://github.com/bebbi/dicom-curate/commit/d0a23fd707fe9a9aa1a846d99d458d415085c777))

## [0.5.1](https://github.com/bebbi/dicom-curate/compare/v0.5.0...v0.5.1) (2025-08-29)

### Bug Fixes

- add no-verify to internal (CI) semantic-release commits ([6cd4887](https://github.com/bebbi/dicom-curate/commit/6cd4887eef27629fba608a0afba7fab95f4fe027))
- disable husky in release pipeline ([f1403b4](https://github.com/bebbi/dicom-curate/commit/f1403b4cad4d6f1b7279968ed0c1bcee4b140e26))
- get semantic-release going again ([be190d7](https://github.com/bebbi/dicom-curate/commit/be190d7e17396e1a4891333151485961edac717c))
- make esbuild (ESM) output equivalent with bebbiscript versions ([af98589](https://github.com/bebbi/dicom-curate/commit/af985892538ee01c9dc4518b5d40abf571a2e549))

# [0.5.0](https://github.com/bebbi/dicom-curate/compare/v0.4.1...v0.5.0) (2025-08-21)

### Features

- add file-exclusions to anomalies array in mapresults ([8ac59d6](https://github.com/bebbi/dicom-curate/commit/8ac59d601c05ca93a0bc2cd208e8d9030deae788))
- implement file-exclusion logic into scanDirectoryWorker and specifications ([b9a3552](https://github.com/bebbi/dicom-curate/commit/b9a3552a158a1b931a4b0b42b5af3952415e3f55))

## [0.4.1](https://github.com/bebbi/dicom-curate/compare/v0.4.0...v0.4.1) (2025-08-13)

### Bug Fixes

- handle nested private tags and temporal offsets with leading/trailing whitespace ([1783214](https://github.com/bebbi/dicom-curate/commit/178321492963dd0eaa6165fc0a882c188576415d))

# [0.4.0](https://github.com/bebbi/dicom-curate/compare/v0.3.0...v0.4.0) (2025-07-27)

### Features

- default outputFilePathComponents are not relying original instance UIDs ([a2fc7cf](https://github.com/bebbi/dicom-curate/commit/a2fc7cf2c3e6a8a121be00396bb6e88390516e14))
- parser exposes the protectUid function to protect instance uids ([32efaa6](https://github.com/bebbi/dicom-curate/commit/32efaa6fe4bc1992ea039ac19f7a9c347931603f))
- scan directory worker passes the sequence number of the file to process within the directory ([4e65a45](https://github.com/bebbi/dicom-curate/commit/4e65a45e5569b7ae9c66d6f53584cfda0d142d55))

# [0.3.0](https://github.com/bebbi/dicom-curate/compare/v0.2.0...v0.3.0) (2025-07-16)

### Features

- `curateMany` returns a promise that resolves when all is done ([0d97606](https://github.com/bebbi/dicom-curate/commit/0d9760673649d2addce8c1bdab5ab85e8ea2d690))
- `onProgress` is called when job is done with a response of `done` and the `mapResultsList` ([a343261](https://github.com/bebbi/dicom-curate/commit/a343261f63eb41f8c0601969a50296332d730891))

# [0.2.0](https://github.com/bebbi/dicom-curate/compare/v0.1.2...v0.2.0) (2025-07-03)

### Features

- add UMD build output using Rollup ([6fdaeb5](https://github.com/bebbi/dicom-curate/commit/6fdaeb542a122ca8bc28b43ef54ca28e04ca675e))

## [0.1.2](https://github.com/bebbi/dicom-curate/compare/v0.1.1...v0.1.2) (2025-06-07)

### Bug Fixes

- add build step to npm publish ([7e624be](https://github.com/bebbi/dicom-curate/commit/7e624be5efd1bfc797c6e25b15291bf133b3a081))

## [0.1.1](https://github.com/bebbi/dicom-curate/compare/v0.1.0...v0.1.1) (2025-06-07)

### Bug Fixes

- add debug log ([0894383](https://github.com/bebbi/dicom-curate/commit/08943833e90369805ba513e9a4fa7138a0cab90c))
- do release workflow as a registered app circumvents branch protection ([ac4cbe7](https://github.com/bebbi/dicom-curate/commit/ac4cbe7c2b99a1e6949616c43185f7aab36a3199))
- permissions in action, assign identity ([047ba67](https://github.com/bebbi/dicom-curate/commit/047ba67eda2cbfafcf2a8e0e8d055f6dfb7e5574))
