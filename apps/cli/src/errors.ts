/** Locally detected input errors: messages must be safe to show verbatim. */
export class CliUsageError extends Error {
  override name = 'CliUsageError'

  constructor(message: string, public readonly nextStep: string) {
    super(message)
  }
}

/** A successful HTTP response which does not satisfy the expected API shape. */
export class CliResponseError extends Error {
  override name = 'CliResponseError'

  constructor(message: string, public readonly nextStep: string) {
    super(message)
  }
}
