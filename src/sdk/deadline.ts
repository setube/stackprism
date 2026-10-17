import { StackPrismError } from './types.js'

export class DetectionDeadline {
  readonly startedAt = performance.now()
  private readonly endsAt: number
  private readonly expiration: Promise<never>
  private readonly timer: ReturnType<typeof setTimeout>
  private failure?: StackPrismError
  private readonly abort: () => void

  constructor(
    timeoutMs = 30_000,
    private readonly signal?: AbortSignal
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new StackPrismError('INVALID_ARGUMENT', 'timeoutMs must be an integer between 1 and 120000')
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new StackPrismError('INVALID_ARGUMENT', 'signal must be an AbortSignal')
    }
    this.endsAt = this.startedAt + timeoutMs
    let rejectExpiration!: (error: StackPrismError) => void
    this.expiration = new Promise<never>((_, reject) => {
      rejectExpiration = reject
    })
    // Cancellation may arrive between operations; it must not create an unhandled rejection.
    void this.expiration.catch(() => {})
    const expire = (error: StackPrismError) => {
      this.failure ??= error
      rejectExpiration(this.failure)
    }
    this.timer = setTimeout(() => expire(new StackPrismError('TIMEOUT', 'Detection deadline exceeded')), timeoutMs)
    this.abort = () => expire(new StackPrismError('ABORTED', 'Detection cancelled'))
    signal?.addEventListener('abort', this.abort, { once: true })
    if (signal?.aborted) this.abort()
  }

  remaining(): number {
    if (this.failure) throw this.failure
    const remaining = Math.ceil(this.endsAt - performance.now())
    if (remaining <= 0) throw new StackPrismError('TIMEOUT', 'Detection deadline exceeded')
    return remaining
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.remaining()
    return Promise.race([operation(), this.expiration])
  }

  async wait(milliseconds: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await this.run(
        () =>
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, milliseconds)
          })
      )
    } finally {
      clearTimeout(timer)
    }
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.signal?.removeEventListener('abort', this.abort)
  }
}
