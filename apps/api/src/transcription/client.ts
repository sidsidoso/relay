import type { FetchLike } from '../agent/providers/types'

export type TranscribeError = 'timeout' | 'offline' | `http_${number}` | 'unreadable'
export type TranscribeResult =
  | { ok: true; text: string; durationS: number; processingS: number; model: string }
  | { ok: false; error: TranscribeError }
export type TranscribeOptions = { mime: string; timeoutMs: number; language?: string }
export type TranscriberHealth = { ok: boolean; model: string | null; loaded: boolean; error: string | null }

/** Spec §5: never throws; every failure is a stable code. */
export interface Transcriber {
  transcribe(audio: Uint8Array<ArrayBuffer>, opts: TranscribeOptions): Promise<TranscribeResult>
  /** null when the service is unreachable or does not answer with a health document. */
  health(timeoutMs?: number): Promise<TranscriberHealth | null>
}

export const HEALTH_TIMEOUT_MS = 3_000

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Talks to services/transcriber over HTTP. */
export class HttpTranscriber implements Transcriber {
  private readonly url: string
  private readonly language?: string
  private readonly fetch: FetchLike

  constructor(opts: { url: string; language?: string; fetch?: FetchLike }) {
    this.url = opts.url.replace(/\/+$/, '')
    this.language = opts.language
    this.fetch = opts.fetch ?? globalThis.fetch
  }

  async transcribe(audio: Uint8Array<ArrayBuffer>, { mime, timeoutMs, language }: TranscribeOptions): Promise<TranscribeResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const headers: Record<string, string> = { 'content-type': mime }
    const lang = language ?? this.language
    if (lang) headers['x-language'] = lang
    try {
      const res = await this.fetch(`${this.url}/transcribe`, { method: 'POST', headers, body: audio, signal: controller.signal })
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        // 503: the model is still loading (or failed to load) — like a service that is not there yet.
        return { ok: false, error: res.status === 503 ? 'offline' : `http_${res.status}` }
      }
      const body: unknown = await res.json()
      if (!isRecord(body) || typeof body.text !== 'string') return { ok: false, error: 'unreadable' }
      return {
        ok: true,
        text: body.text,
        durationS: typeof body.duration_s === 'number' ? body.duration_s : 0,
        processingS: typeof body.processing_s === 'number' ? body.processing_s : 0,
        model: typeof body.model === 'string' ? body.model : 'unknown',
      }
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, error: 'timeout' }
      if (err instanceof SyntaxError) return { ok: false, error: 'unreadable' }
      return { ok: false, error: 'offline' }
    } finally {
      clearTimeout(timer)
    }
  }

  async health(timeoutMs = HEALTH_TIMEOUT_MS): Promise<TranscriberHealth | null> {
    try {
      const res = await this.fetch(`${this.url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return null
      const body: unknown = await res.json()
      if (!isRecord(body) || typeof body.loaded !== 'boolean') return null
      return {
        ok: body.ok === true,
        model: typeof body.model === 'string' ? body.model : null,
        loaded: body.loaded,
        error: typeof body.error === 'string' ? body.error : null,
      }
    } catch {
      return null
    }
  }
}
