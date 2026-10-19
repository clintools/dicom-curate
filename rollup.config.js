import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import nodePolyfills from 'rollup-plugin-polyfill-node'
import { terser } from 'rollup-plugin-terser'
import webWorkerLoader from 'rollup-plugin-web-worker-loader'

const basePlugins = [
  typescript({
    tsconfig: './tsconfig.json',
    declaration: false,
    outDir: 'dist',
  }),
  nodeResolve(),
  commonjs(),
  nodePolyfills(),
]

// preserveSource inlines each worker as a function and drops the first and last
// lines of its source at runtime. Terser joins lines, so a minified build must
// use base64 instead or it deletes real worker code.
const umdPlugins = (preserveSource) => [
  webWorkerLoader({
    targetPlatform: 'browser',
    inline: true, // Inline worker code as blob URLs
    preserveSource,
    sourcemap: false,
    extensions: ['.js', '.ts'], // Handle TypeScript files
  }),
  typescript({
    tsconfig: './tsconfig.json',
    declaration: false,
    outDir: 'dist',
  }),
  nodeResolve(),
  commonjs(),
  nodePolyfills(),
]

export default [
  // UMD build – non-minified
  {
    input: 'src/index.umd.ts',
    output: {
      file: 'dist/umd/dicom-curate.umd.js',
      format: 'umd',
      name: 'dicomCurate',
      sourcemap: true,
      globals: {
        fs: 'fs',
        'fs/promises': 'fs.promises',
        path: 'path',
        worker_threads: 'worker_threads',
        '@aws-sdk/client-s3': 'AwsSdkClientS3',
        '@aws-sdk/lib-storage': 'AwsSdkLibStorage',
      },
    },
    external: [
      'fs',
      'fs/promises',
      'path',
      'worker_threads',
      '@aws-sdk/client-s3',
      '@aws-sdk/lib-storage',
    ],
    plugins: umdPlugins(true),
  },

  // UMD build - minified
  {
    input: 'src/index.umd.ts',
    output: {
      file: 'dist/umd/dicom-curate.umd.min.js',
      format: 'umd',
      name: 'dicomCurate',
      sourcemap: true,
      globals: {
        fs: 'fs',
        'fs/promises': 'fs.promises',
        path: 'path',
        worker_threads: 'worker_threads',
        '@aws-sdk/client-s3': 'AwsSdkClientS3',
        '@aws-sdk/lib-storage': 'AwsSdkLibStorage',
      },
    },
    external: [
      'fs',
      'fs/promises',
      'path',
      'worker_threads',
      '@aws-sdk/client-s3',
      '@aws-sdk/lib-storage',
    ],
    treeshake: true,
    // The base64 loader decodes with atob, which yields bytes, not UTF-8
    // characters, so any non-ASCII in the workers would be silently corrupted.
    plugins: [...umdPlugins(false), terser({ format: { ascii_only: true } })],
  },
]
