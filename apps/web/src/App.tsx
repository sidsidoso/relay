import { useEffect, useState } from 'react'
import { api, type User } from './api'
import { Login } from './pages/Login'
import { Inbox } from './pages/Inbox'

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  useEffect(() => { api.me().then((r) => setUser(r.user), () => setUser(null)) }, [])

  if (user === undefined) return null
  if (user === null) return <Login onLoggedIn={setUser} />
  return <Inbox user={user} onLogout={() => setUser(null)} />
}
