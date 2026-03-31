/**
 * Mock mapping worker for testing worker crash recovery.
 *
 * Provides configurable MockWorker instances that simulate normal operation,
 * crashes (onerror/exit), or hangs. Used with jest.unstable_mockModule to
 * replace the real worker.ts module in tests.
 */

export type MockWorkerBehavior =
  | 'normal'
  | 'slow'
  | 'slow-then-fast'
  | 'crash-onerror'
  | 'crash-exit'
  | 'crash-onerror-and-exit'
  | 'hang'

let mockBehaviors: MockWorkerBehavior[] = []
let mockWorkerIndex = 0
let mockWorkersCreated: MockWorker[] = []
/** Shared counter for slow-then-fast: after this many total responses,
 *  workers switch from slow to fast. */
let slowThenFastThreshold = 0
let totalResponses = 0

export function configureMockMappingWorkers(
  behaviors: MockWorkerBehavior[],
  options?: { slowThenFastThreshold?: number },
): void {
  mockBehaviors = [...behaviors]
  mockWorkerIndex = 0
  mockWorkersCreated = []
  slowThenFastThreshold = options?.slowThenFastThreshold ?? 0
  totalResponses = 0
}

export function getMockWorkersCreated(): MockWorker[] {
  return mockWorkersCreated
}

export function resetMockWorkers(): void {
  mockBehaviors = []
  mockWorkerIndex = 0
  mockWorkersCreated = []
  slowThenFastThreshold = 0
  totalResponses = 0
}

export class MockWorker {
  public onerror: ((event: any) => void) | null = null
  public behavior: MockWorkerBehavior
  public terminated = false
  public messagesReceived: any[] = []

  private messageListeners: ((event: { data: any }) => void)[] = []
  private exitListeners: ((code: number) => void)[] = []

  constructor(behavior: MockWorkerBehavior) {
    this.behavior = behavior
  }

  addEventListener(event: string, listener: any): void {
    if (event === 'message') {
      this.messageListeners.push(listener)
    }
  }

  on(event: string, listener: any): void {
    if (event === 'exit') {
      this.exitListeners.push(listener)
    } else if (event === 'message') {
      this.messageListeners.push(listener)
    }
  }

  postMessage(data: any): void {
    if (this.terminated) return
    this.messagesReceived.push(data)

    if (data.request === 'fileInfoIndex') return
    if (data.request !== 'apply') return

    const fileInfo = data.fileInfo

    switch (this.behavior) {
      case 'normal':
      case 'slow':
      case 'slow-then-fast': {
        const mapResults = {
          sourceInstanceUID: fileInfo?.name || 'unknown',
          outputFilePath: `output/${fileInfo?.name || 'unknown'}`,
          mappings: {},
          anomalies: [],
          errors: [],
          quarantine: {},
          fileInfo,
        }
        // 'slow' adds a fixed delay so the scan worker builds up a queue
        // and triggers backpressure before workers start returning results.
        // 'slow-then-fast' starts slow then switches to instant responses
        // after slowThenFastThreshold total responses across all workers.
        let delay = 0
        if (this.behavior === 'slow') {
          delay = 100
        } else if (this.behavior === 'slow-then-fast') {
          delay = totalResponses < slowThenFastThreshold ? 100 : 0
        }
        setTimeout(() => {
          if (!this.terminated) {
            totalResponses++
            this.emitMessage({ response: 'finished', mapResults })
          }
        }, delay)
        break
      }
      case 'crash-onerror': {
        setTimeout(() => {
          if (!this.terminated && this.onerror) {
            this.onerror({
              message: 'Simulated worker crash (onerror)',
            } as unknown as Event)
          }
        }, 0)
        break
      }
      case 'crash-exit': {
        setTimeout(() => {
          if (!this.terminated) {
            for (const listener of this.exitListeners) {
              listener(1)
            }
          }
        }, 0)
        break
      }
      case 'crash-onerror-and-exit': {
        setTimeout(() => {
          if (!this.terminated) {
            if (this.onerror) {
              this.onerror({
                message: 'Simulated worker crash (double)',
              } as unknown as Event)
            }
            for (const listener of this.exitListeners) {
              listener(1)
            }
          }
        }, 0)
        break
      }
      case 'hang': {
        break
      }
    }
  }

  terminate(): void {
    this.terminated = true
  }

  private emitMessage(data: any): void {
    for (const listener of this.messageListeners) {
      listener({ data })
    }
  }
}

export function getNextMockBehavior(): MockWorkerBehavior {
  const behavior: MockWorkerBehavior =
    mockWorkerIndex < mockBehaviors.length
      ? mockBehaviors[mockWorkerIndex]
      : 'normal'
  mockWorkerIndex++
  return behavior
}

export function registerMockWorker(mock: MockWorker): void {
  mockWorkersCreated.push(mock)
}
