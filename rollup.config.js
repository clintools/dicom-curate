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

const umdPlugins = [
  webWorkerLoader({
    targetPlatform: 'browser',
    inline: true, // Inline worker code as blob URLs
    preserveSource: true, // Keep the source code readable
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
      },
    },
    external: [
      'fs',
      'fs/promises',
      'path',
      'worker_threads',
      '@aws-sdk/client-s3',
    ],
    plugins: umdPlugins,
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
      },
    },
    external: [
      'fs',
      'fs/promises',
      'path',
      'worker_threads',
      '@aws-sdk/client-s3',
    ],
    treeshake: true,
    plugins: [...umdPlugins, terser()],
  },
]
