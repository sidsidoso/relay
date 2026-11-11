/** A provider failure with a stable code; the engine logs `message` on the run and hands off. */
export class ProviderError extends Error {
  constructor(readonly code: string, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ProviderError'
  }
}
