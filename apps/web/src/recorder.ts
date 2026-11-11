/** The widget stops recording here; the API accepts up to 10 MB, far more than 2 minutes of opus. */
export const MAX_RECORDING_MS = 120_000

const PREFERRED = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']

export type Recording = {
  /** The audio when recording stops (stop() or the time limit); null after cancel() or when nothing was captured. */
  done: Promise<Blob | null>
  stop(): void
  cancel(): void
}

export function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

export async function startRecording(maxMs = MAX_RECORDING_MS): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const mimeType = PREFERRED.find((t) => MediaRecorder.isTypeSupported(t))
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  let cancelled = false
  let limit: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<Blob | null>((resolve) => {
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => {
      clearTimeout(limit)
      stream.getTracks().forEach((t) => t.stop())
      resolve(cancelled || chunks.length === 0 ? null : new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }))
    }
  })
  const stop = () => { if (recorder.state !== 'inactive') recorder.stop() }
  limit = setTimeout(stop, maxMs)
  recorder.start()
  return { done, stop, cancel: () => { cancelled = true; stop() } }
}
