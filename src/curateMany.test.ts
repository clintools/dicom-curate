import {
  describe,
  beforeEach,
  it,
  expect,
  vi,
  type MockedFunction,
} from "vitest";

async function flushAsyncSetup() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
describe("curateMany", () => {
  let curateMany: typeof import("./index").curateMany;
  let mappingWorkerPool: typeof import("./mappingWorkerPool");
  let composeSpecsModule: typeof import("./composeSpecs");

  let capturedProgressCallback: ((msg: any) => void) | undefined;

  function emitDone(result: Record<string, unknown> = {}) {
    if (!capturedProgressCallback) {
      throw new Error("Progress callback was not captured");
    }

    capturedProgressCallback({
      response: "done",
      fileCount: 1,
      fileErrors: 0,
      warnings: [],
      elapsedSeconds: 0,
      ...result,
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    capturedProgressCallback = undefined;

    vi.doMock("./mappingWorkerPool", () => ({
      availableMappingWorkers: [],
      dispatchMappingJobs: vi.fn(),
      filesToProcess: [],
      getLastWorkerProgressTime: vi.fn(() => Date.now()),
      getWorkerCurrentFile: vi.fn(() => new Map()),
      getWorkersActive: vi.fn(() => 0),
      initializeMappingWorkers: vi.fn(
        async (
          _skipCollectingMappings: unknown,
          _fileInfoIndex: unknown,
          progressCallback: (msg: any) => void,
        ) => {
          capturedProgressCallback = progressCallback;
        },
      ),
      markScanPaused: vi.fn(),
      scanAnomalies: [],
      setDirectoryScanFinished: vi.fn(),
      setMappingWorkerOptions: vi.fn(),
      setScanResumeCallback: vi.fn(),
      setTotalDiscoveredFiles: vi.fn(),
      terminateAllWorkers: vi.fn(),
    }));

    vi.doMock("./composeSpecs", () => ({
      composeSpecs: vi.fn(() => ({
        dicomPS315EOptions: "Off",
      })),
    }));

    vi.doMock("./worker", () => ({
      createWorker: vi.fn(),
    }));

    mappingWorkerPool = await import("./mappingWorkerPool");
    composeSpecsModule = await import("./composeSpecs");
    ({ curateMany } = await import("./index"));
  });

  it("rejects immediately for a pre-aborted signal and does not start worker initialization", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      curateMany({
        inputType: "http",
        inputUrls: ["https://example.com/file.dcm"],
        curationSpec: "none",
        signal: controller.signal,
      } as any),
    ).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(mappingWorkerPool.initializeMappingWorkers).not.toHaveBeenCalled();
    expect(mappingWorkerPool.terminateAllWorkers).not.toHaveBeenCalled();
  });

  it("rejects when initializeMappingWorkers fails inside the async IIFE", async () => {
    (
      mappingWorkerPool.initializeMappingWorkers as MockedFunction<
        typeof mappingWorkerPool.initializeMappingWorkers
      >
    ).mockRejectedValueOnce(new Error("init failed"));

    await expect(
      curateMany({
        inputType: "http",
        inputUrls: ["https://example.com/file.dcm"],
        curationSpec: "none",
      } as any),
    ).rejects.toThrow("init failed");

    expect(mappingWorkerPool.initializeMappingWorkers).toHaveBeenCalledTimes(1);
    expect(mappingWorkerPool.setMappingWorkerOptions).not.toHaveBeenCalled();
  });

  it("rejects when collectMappingOptions throws inside the async IIFE", async () => {
    (
      composeSpecsModule.composeSpecs as MockedFunction<
        typeof composeSpecsModule.composeSpecs
      >
    ).mockReturnValueOnce({
      dicomPS315EOptions: {
        retainLongitudinalTemporalInformationOptions: "Offset",
      },
    } as any);

    await expect(
      curateMany({
        inputType: "http",
        inputUrls: ["https://example.com/file.dcm"],
        curationSpec: () => ({}),
        dateOffset: "not-an-iso8601-offset",
      } as any),
    ).rejects.toThrow(
      'When using "Offset" for retainLongitudinalTemporalInformationOptions',
    );

    expect(mappingWorkerPool.initializeMappingWorkers).toHaveBeenCalledTimes(1);
    expect(mappingWorkerPool.setMappingWorkerOptions).not.toHaveBeenCalled();
    expect(mappingWorkerPool.dispatchMappingJobs).not.toHaveBeenCalled();
  });

  it("rejects with AbortError if aborted while async setup is still in progress", async () => {
    let resolveInit!: () => void;
    (
      mappingWorkerPool.initializeMappingWorkers as MockedFunction<
        typeof mappingWorkerPool.initializeMappingWorkers
      >
    ).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );

    const controller = new AbortController();

    const promise = curateMany({
      inputType: "http",
      inputUrls: ["https://example.com/file.dcm"],
      curationSpec: "none",
      signal: controller.signal,
    } as any);

    controller.abort();

    await expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(mappingWorkerPool.terminateAllWorkers).toHaveBeenCalledTimes(1);

    resolveInit();
    await Promise.resolve();
  });

  it("resolves on the happy path for http input", async () => {
    const promise = curateMany({
      inputType: "http",
      inputUrls: [
        "https://example.com/file1.dcm",
        "https://example.com/file2.dcm",
      ],
      curationSpec: "none",
    } as any);

    await flushAsyncSetup();

    emitDone({
      fileCount: 2,
      elapsedSeconds: 1,
    });

    const result = await promise;

    expect(result).toMatchObject({
      response: "done",
      fileCount: 2,
      elapsedSeconds: 1,
    });
    expect(mappingWorkerPool.initializeMappingWorkers).toHaveBeenCalledTimes(1);
    expect(mappingWorkerPool.setMappingWorkerOptions).toHaveBeenCalledTimes(1);
    expect(mappingWorkerPool.dispatchMappingJobs).toHaveBeenCalled();
    expect(mappingWorkerPool.setDirectoryScanFinished).toHaveBeenCalledWith(
      true,
    );
    expect(mappingWorkerPool.filesToProcess).toHaveLength(2);
  });

  it("forwards progress messages to the caller before resolving", async () => {
    const onProgress = vi.fn();

    const promise = curateMany(
      {
        inputType: "http",
        inputUrls: ["https://example.com/file.dcm"],
        curationSpec: "none",
      } as any,
      onProgress,
    );

    await Promise.resolve();

    if (!capturedProgressCallback) {
      throw new Error("Progress callback was not captured");
    }

    capturedProgressCallback({
      response: "progress",
      completedFileCount: 1,
      totalFileCount: 1,
      currentFile: "file.dcm",
    });

    emitDone({
      fileCount: 1,
      elapsedSeconds: 1,
    });

    await expect(promise).resolves.toMatchObject({
      response: "done",
      fileCount: 1,
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ response: "progress" }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ response: "done" }),
    );
  });
});
