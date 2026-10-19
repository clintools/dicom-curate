import { describeWorkerError } from './describeWorkerError'

describe('describeWorkerError', () => {
  it('points a message-less browser load failure at the bundler fix', () => {
    expect(describeWorkerError(new Event('error'))).toMatch(
      /^Worker script failed to load or parse\..*optimizeDeps\.exclude/,
    )
  })

  it('keeps the message of a runtime error event', () => {
    expect(describeWorkerError({ message: 'boom' })).toBe('boom')
  })

  it('keeps the message of a Node worker_threads Error', () => {
    expect(describeWorkerError(new Error('x'))).toBe('x')
  })
})
