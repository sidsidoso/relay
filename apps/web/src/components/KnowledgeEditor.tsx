import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type KnowledgeFile } from '../api'

const NAME = /^[a-z0-9][a-z0-9-]{0,62}\.md$/
const MESSAGES: Record<string, string> = {
  invalid_name: 'Use lowercase letters, digits and dashes.',
  too_large: 'The file is too large (100 KB max).',
  too_many_files: 'Too many files (50 max).',
}

type Open = { name: string; content: string; saved: string; isNew: boolean }

export function KnowledgeEditor({ onExpired }: { onExpired: () => void }) {
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [open, setOpen] = useState<Open | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const busy = useRef(false)

  const fail = useCallback((err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 401) { onExpired(); return }
    setError(err instanceof ApiError ? MESSAGES[err.code] ?? fallback : fallback)
  }, [onExpired])

  const refresh = useCallback(async () => {
    try { setFiles((await api.knowledgeList()).files) } catch (err) { fail(err, 'Could not load the knowledge base.') }
  }, [fail])
  useEffect(() => { void refresh() }, [refresh])

  const dirty = open !== null && open.content !== open.saved
  const leave = () => !dirty || window.confirm('Discard unsaved changes?')

  // Resolves true when the file is (now) open. `known` skips the fetch when the caller already has it.
  async function select(name: string, known?: { name: string; content: string }): Promise<boolean> {
    if (open?.name === name) return true
    if (!leave()) return false
    setError(null); setStatus('idle')
    try {
      const f = known ?? await api.knowledgeFile(name)
      setOpen({ name: f.name, content: f.content, saved: f.content, isNew: false })
      return true
    } catch (err) { fail(err, 'Could not open the file.'); return false }
  }

  async function create() {
    const raw = newName.trim().toLowerCase().endsWith('.md') ? newName.trim() : `${newName.trim()}.md`
    if (!NAME.test(raw)) { setError(MESSAGES.invalid_name!); return }
    if (open?.name === raw) { setNewName(''); return }
    // The server decides: a blank editor over an existing name would overwrite it on save.
    let existing: { name: string; content: string } | null = null
    try {
      existing = await api.knowledgeFile(raw)
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) { fail(err, 'Could not check whether the file exists.'); return }
    }
    if (existing) {
      if (await select(raw, existing)) setNewName('')
      return
    }
    if (!leave()) return
    setError(null); setStatus('idle')
    setOpen({ name: raw, content: '', saved: '', isNew: true })
    setNewName('')
  }

  async function save() {
    if (!open || busy.current) return
    busy.current = true
    setStatus('saving'); setError(null)
    const { name, content } = open
    try {
      await api.saveKnowledge(name, content)
      setOpen((o) => (o && o.name === name ? { ...o, saved: content, isNew: false } : o))
      setStatus('saved')
      await refresh()
    } catch (err) {
      setStatus('idle')
      fail(err, 'Could not save. Try again.')
    } finally {
      busy.current = false
    }
  }

  async function remove() {
    if (!open || busy.current || !window.confirm(`Delete ${open.name}?`)) return
    busy.current = true
    try {
      if (!open.isNew) await api.deleteKnowledge(open.name)
      setOpen(null); setStatus('idle')
      await refresh()
    } catch (err) {
      fail(err, 'Could not delete. Try again.')
    } finally {
      busy.current = false
    }
  }

  return (
    <section className="kb" aria-label="Knowledge base">
      <h2>Knowledge base</h2>
      <p className="muted">Markdown files. Each <code>## heading</code> is one passage the agent can find.</p>
      <div className="kb-grid">
        <ul className="kb-files">
          {files.map((f) => (
            <li key={f.name}>
              <button type="button" aria-pressed={open?.name === f.name} onClick={() => void select(f.name)}>{f.name}</button>
            </li>
          ))}
          {files.length === 0 && <li className="muted">No files yet</li>}
        </ul>
        <div className="kb-editor">
          {open ? (
            <>
              <label>
                {`Content of ${open.name}`}
                <textarea rows={18} value={open.content} onChange={(e) => { const v = e.target.value; setOpen((o) => (o ? { ...o, content: v } : o)); setStatus('idle') }} />
              </label>
              <div className="settings-actions">
                <button type="button" onClick={() => void save()} disabled={status === 'saving'}>Save file</button>
                <button type="button" onClick={() => void remove()}>Delete</button>
                {status === 'saved' && <span className="muted" role="status">Saved</span>}
                {dirty && <span className="muted">Unsaved changes</span>}
              </div>
            </>
          ) : <p className="empty">Select a file or create one.</p>}
        </div>
      </div>
      <div className="settings-actions">
        <label>New file name <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="parking" /></label>
        <button type="button" onClick={() => void create()}>New file</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  )
}
