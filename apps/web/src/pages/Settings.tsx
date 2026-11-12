import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, type Settings } from '../api'
import { KnowledgeEditor } from '../components/KnowledgeEditor'

type Form = { instructions: string; keywords: string; turnLimit: string; handoffMessage: string; transcriptionEnabled: boolean }
type Status = 'loading' | 'idle' | 'saving' | 'saved' | 'invalid' | 'error'

const toForm = (s: Settings): Form => ({
  instructions: s.instructions, keywords: s.handoffKeywords.join(', '), turnLimit: String(s.turnLimit),
  handoffMessage: s.handoffMessage, transcriptionEnabled: s.transcriptionEnabled,
})
const fromForm = (f: Form): Settings => ({
  instructions: f.instructions,
  handoffKeywords: f.keywords.split(',').map((k) => k.trim()).filter(Boolean),
  turnLimit: Number(f.turnLimit),
  handoffMessage: f.handoffMessage,
  transcriptionEnabled: f.transcriptionEnabled,
})

export function SettingsPage({ onLogout }: { onLogout: () => void }) {
  const [form, setForm] = useState<Form | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [invalid, setInvalid] = useState<string[]>([])
  const saving = useRef(false)

  const expired = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) { onLogout(); return true }
    return false
  }

  useEffect(() => {
    api.settings().then((r) => { setForm(toForm(r.settings)); setStatus('idle') }, (err) => { if (!expired(err)) setStatus('error') })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!form || saving.current) return
    saving.current = true
    setStatus('saving')
    setInvalid([])
    try {
      const r = await api.saveSettings(fromForm(form))
      setForm(toForm(r.settings))
      setStatus('saved')
    } catch (err) {
      if (expired(err)) return
      if (err instanceof ApiError && err.code === 'invalid_request') { setInvalid(err.fields); setStatus('invalid') } else setStatus('error')
    } finally {
      saving.current = false
    }
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => (f ? { ...f, [k]: v } : f)); if (status === 'saved') setStatus('idle') }
  const bad = (field: keyof Settings) => invalid.includes(field)

  return (
    <div className="settings">
      <header className="topbar">
        <strong>Relay</strong>
        <a href="/">Inbox</a>
        <span>Settings</span>
      </header>
      {status === 'loading' && <p className="empty">Loading…</p>}
      {status === 'error' && !form && <p role="alert" className="error">Could not load the settings.</p>}
      {form && (
        <form className="settings-form" onSubmit={save}>
          <h2>Agent</h2>
          <label>Instructions
            <textarea rows={6} value={form.instructions} aria-invalid={bad('instructions')} onChange={(e) => set('instructions', e.target.value)} />
          </label>
          <label>Handoff keywords (comma-separated)
            <input value={form.keywords} aria-invalid={bad('handoffKeywords')} onChange={(e) => set('keywords', e.target.value)} />
          </label>
          <label>Turn limit
            <input type="number" min={1} max={100} value={form.turnLimit} aria-invalid={bad('turnLimit')} onChange={(e) => set('turnLimit', e.target.value)} />
          </label>
          <label>Handoff message
            <textarea rows={2} value={form.handoffMessage} aria-invalid={bad('handoffMessage')} onChange={(e) => set('handoffMessage', e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.transcriptionEnabled} onChange={(e) => set('transcriptionEnabled', e.target.checked)} />
            Transcribe voice messages
          </label>
          <div className="settings-actions">
            <button type="submit" disabled={status === 'saving'}>Save settings</button>
            {status === 'saved' && <span className="muted" role="status">Saved</span>}
            {status === 'invalid' && <p role="alert" className="error">Check the highlighted fields.</p>}
            {status === 'error' && <p role="alert" className="error">Could not save. Try again.</p>}
          </div>
        </form>
      )}
      <KnowledgeEditor onExpired={onLogout} />
    </div>
  )
}
