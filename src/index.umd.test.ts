const { scanFactory, mappingFactory } = vi.hoisted(() => ({
  scanFactory: vi.fn(),
  mappingFactory: vi.fn(),
}))

vi.mock('web-worker:./scanDirectoryWorker', () => ({ default: scanFactory }))
vi.mock('web-worker:./applyMappingsWorker', () => ({
  default: mappingFactory,
}))

describe('UMD entry point', () => {
  it('exposes each inlined worker factory under its own global without starting a worker', async () => {
    await import('./index.umd')
    const globals = globalThis as Record<string, unknown>

    expect(globals.__INLINED_SCAN_WORKER__).toBe(scanFactory)
    expect(globals.__INLINED_MAPPING_WORKER__).toBe(mappingFactory)
    expect(scanFactory).not.toHaveBeenCalled()
    expect(mappingFactory).not.toHaveBeenCalled()
  })
})
