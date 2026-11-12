import type { TranscribeOptions, TranscribeResult, Transcriber, TranscriberHealth } from '../src/transcription/client'

/** In-memory Transcriber: `answer` decides each result (call numbers start at 1). */
export class FakeTranscriber implements Transcriber {
  calls: Array<{ bytes: number; mime: string; timeoutMs: number }> = []
  healthy: TranscriberHealth | null = { ok: true, model: 'fake', loaded: true, error: null }

  constructor(private readonly answer: (call: number) => TranscribeResult | Promise<TranscribeResult>) {}

  async transcribe(audio: Uint8Array<ArrayBuffer>, opts: TranscribeOptions): Promise<TranscribeResult> {
    this.calls.push({ bytes: audio.length, mime: opts.mime, timeoutMs: opts.timeoutMs })
    return this.answer(this.calls.length)
  }

  async health(): Promise<TranscriberHealth | null> {
    return this.healthy
  }
}

export const said = (text: string): TranscribeResult => ({ ok: true, text, durationS: 2, processingS: 0.5, model: 'fake' })
