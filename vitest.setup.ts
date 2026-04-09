// Polyfill TextEncoder/TextDecoder for Node.js test environment
import { TextDecoder, TextEncoder } from 'node:util'

globalThis.TextEncoder = globalThis.TextEncoder || TextEncoder
globalThis.TextDecoder = globalThis.TextDecoder || TextDecoder

// Filter out known dcmjs console errors
const originalConsoleError = console.error
const originalConsoleWarn = console.warn

console.error = (...args) => {
  const message = args[0]?.toString() || ''
  // Suppress dcmjs VR type warnings
  if (message.includes('Invalid vr type') || message.includes('using UN')) {
    return
  }
  originalConsoleError.apply(console, args)
}

console.warn = (...args) => {
  const message = args[0]?.toString() || ''
  // Suppress dcmjs unknown name warnings
  if (message.includes('Unknown name in dataset')) {
    return
  }
  originalConsoleWarn.apply(console, args)
}
