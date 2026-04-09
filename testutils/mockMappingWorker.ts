/**
 * Mock mapping worker for testing worker crash recovery.
 *
 * Provides configurable MockWorker instances that simulate normal operation,
 * crashes (onerror/exit), or hangs. Used with vi.doMock (Vitest) to
 * replace the real worker.ts module in tests.
 */

export type MockWorkerBehavior =
  | 'normal'
  | 'crash-onerror'
  | 'crash-exit'
  | 'crash-onerror-and-exit'
  | 'hang'

let mockBehaviors: MockWorkerBehavior[] = []
let mockWorkerIndex = 0
let mockWorkersCreated: MockWorker[] = []

export function configureMockMappingWorkers(
  behaviors: MockWorkerBehavior[],
): void {
  mockBehaviors = [...behaviors]
  mockWorkerIndex = 0
  mockWorkersCreated = []
}

export function getMockWorkersCreated(): MockWorker[] {
  return mockWorkersCreated
}

export function resetMockWorkers(): void {
  mockBehaviors = []
  mockWorkerIndex = 0
  mockWorkersCreated = []
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
      case 'normal': {
        const mapResults = {
          sourceInstanceUID: fileInfo?.name || 'unknown',
          outputFilePath: `output/${fileInfo?.name || 'unknown'}`,
          mappings: {},
          anomalies: [],
          errors: [],
          quarantine: {},
          fileInfo,
        }
        setTimeout(() => {
          if (!this.terminated) {
            this.emitMessage({ response: 'finished', mapResults })
          }
        }, 0)
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
