import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What browsers record with MediaRecorder, plus MP3/WAV for manual tests. Base MIME type → file extension. */
export const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
}

/** 10 MB: far more than the widget's 2-minute recordings (opus voice is well under 1 MB per minute). */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024

/** "audio/webm;codecs=opus" → "audio/webm"; null when the type is not an accepted audio type. */
export function audioType(contentType: string | undefined): string | null {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  return Object.hasOwn(AUDIO_TYPES, base) ? base : null
}

/** Writes the audio under a generated name and returns that name (never a client-supplied one). */
export async function saveAudio(dir: string, bytes: Uint8Array, mime: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const name = `${randomUUID()}.${AUDIO_TYPES[mime] ?? 'bin'}`
  await writeFile(join(dir, name), bytes)
  return name
}

/** Absolute path of a stored file, or null for anything that is not a plain file name. */
export function mediaFile(dir: string, name: string | null): string | null {
  if (!name || /[\\/]/.test(name) || name.startsWith('.')) return null
  return join(dir, name)
}

export async function removeAudio(dir: string, name: string): Promise<void> {
  const file = mediaFile(dir, name)
  if (file) await rm(file, { force: true }).catch(() => {})
}
