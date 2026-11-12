import { Widget } from '../components/Widget'
import { DEMO_CREDENTIALS } from '../demo'

export function Demo() {
  return (
    <div className="demo-site">
      <header><h1>Acme Coworking</h1><p>Fictional company used to demo Relay.</p></header>
      <main>
        <p>Desks, meeting rooms and a virtual office address in the city center.</p>
        <p>Open the <a href="/">inbox</a> in another tab, sign in, and chat here.</p>
        <p className="demo-credentials">
          Demo sign-in: <code>{DEMO_CREDENTIALS.email}</code> / <code>{DEMO_CREDENTIALS.password}</code>
        </p>
        <p className="demo-notice">
          This is a public demo: anyone who signs in to the inbox can read the conversations started here. Do not share personal data.
        </p>
      </main>
      <Widget company="Acme Coworking" />
    </div>
  )
}
