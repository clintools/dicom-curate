/**
 * UMD-specific entry point that integrates rollup-plugin-web-worker-loader
 *
 * This file imports the worker scripts using the special 'web-worker:' prefix,
 * which is handled by the rollup-plugin-web-worker-loader plugin to inline
 * the worker code as Blob URLs in the UMD build.
 *
 * The second part of the magic happens in worker.ts.
 */

// @ts-expect-error - Worker imports are handled by rollup-plugin-web-worker-loader
import MappingWorker from 'web-worker:./applyMappingsWorker'

// Make the inlined workers available globally for the worker module to use
// @ts-expect-error - Worker imports are handled by rollup-plugin-web-worker-loader
import ScanWorker from 'web-worker:./scanDirectoryWorker'
;(globalThis as any).__INLINED_SCAN_WORKER__ = ScanWorker(
  globalThis as any,
).__INLINED_MAPPING_WORKER__ = MappingWorker

// Re-export everything from the main index
export * from './index'
