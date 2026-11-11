import { useState, type FormEvent } from 'react'
import { api, ApiError, type User } from '../api'

export function Login({ onLoggedIn }: { onLoggedIn: (u: User) => void }) {
  const [email, setEmail] = useState('demo@relay.dev')
  const [password, setPassword] = useState('relay-demo')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      onLoggedIn((await api.login(email, password)).user)
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? 'Invalid email or password' : 'Could not sign in')
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>Relay</h1>
      <label>Email <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required /></label>
      <label>Password <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit">Sign in</button>
      <p className="hint">Demo credentials are pre-filled.</p>
    </form>
  )
}
