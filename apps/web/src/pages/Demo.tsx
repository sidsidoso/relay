import { Widget } from '../components/Widget'

export function Demo() {
  return (
    <div className="demo-site">
      <header><h1>Acme Coworking</h1><p>Fictional company used to demo Relay.</p></header>
      <main>
        <p>Desks, meeting rooms and a virtual office address in the city center.</p>
        <p>Open the <a href="/">inbox</a> in another tab, sign in with the demo user, and chat here.</p>
      </main>
      <Widget company="Acme Coworking" />
    </div>
  )
}
