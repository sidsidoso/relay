import { useEffect, useState } from 'react'
import { api, type User } from './api'
import { Login } from './pages/Login'
import { Inbox } from './pages/Inbox'
import { Demo } from './pages/Demo'

export function App() {
  const isDemo = location.pathname.startsWith('/demo')
  const [user, setUser] = useState<User | null | undefined>(undefined)
  useEffect(() => { if (!isDemo) api.me().then((r) => setUser(r.user), () => setUser(null)) }, [isDemo])

  if (isDemo) return <Demo />
  if (user === undefined) return null
  if (user === null) return <Login onLoggedIn={setUser} />
  return <Inbox user={user} onLogout={() => setUser(null)} />
}
