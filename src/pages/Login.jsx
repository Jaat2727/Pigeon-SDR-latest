import { useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { Banner } from '../components/ui.jsx';

const POINTS = [
  {
    title: 'Research, then decide',
    body: 'Every prospect is enriched, then scored against a written ICP. Exclusions are checked before scoring, so a match is a reject whatever the score would have been.',
  },
  {
    title: 'Not sure is an answer',
    body: 'A prospect the system cannot place comes back as needs review rather than a low score. Not knowing and not fitting are different, and collapsing them loses real prospects.',
  },
  {
    title: 'Nothing unsourced goes out',
    body: 'Every claim in a message traces back to a field in the research or a document in the knowledge base. With nothing specific to say, the agent hands the message to a person instead of writing filler.',
  },
  {
    title: 'Four ways to stop it',
    body: 'One switch for everything, one per channel, one per agent, one per campaign. All four are read through the same gate the pipeline uses, so what the screen says is stopping work is what is stopping work.',
  },
];

export default function Login() {
  const { signIn, isAuthConfigured } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-left">
        <div className="login-card">
          <div className="row" style={{ gap: 9, marginBottom: 22 }}>
            <div className="brand-mark" style={{ width: 32, height: 32 }}>
              <img src="/logo-icon.png" alt="Pigeon" />
            </div>
            <div>
              <div className="brand-name" style={{ fontSize: 16 }}>Pigeon</div>
              <div className="brand-sub">Autonomous SDR</div>
            </div>
          </div>

          {!isAuthConfigured ? (
            <>
              <h1 style={{ fontSize: 19, marginBottom: 7 }}>Open access</h1>
              <p className="small dim" style={{ marginTop: 0 }}>
                No sign-in is configured on this deployment, so the app opens directly. Actions are
                recorded against a generic operator. To turn on sign-in, set{' '}
                <code className="mono">VITE_SUPABASE_URL</code> and{' '}
                <code className="mono">VITE_SUPABASE_ANON_KEY</code> in Vercel and redeploy.
              </p>
              <button className="btn primary block" style={{ marginTop: 16 }} onClick={() => signIn()}>
                Open the app
              </button>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 19, marginBottom: 7 }}>Sign in</h1>
              <p className="small muted" style={{ marginTop: 0, marginBottom: 18 }}>
                Approvals and stop actions are recorded against whoever is signed in.
              </p>

              {error && <Banner tone="stop">{error}</Banner>}

              <form onSubmit={submit} className="stack-sm">
                <div className="field">
                  <label className="label" htmlFor="email">Email</label>
                  <input
                    id="email"
                    className="input"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="password">Password</label>
                  <input
                    id="password"
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <button className="btn primary block" type="submit" disabled={busy} style={{ marginTop: 6 }}>
                  {busy ? <span className="spin" /> : 'Sign in'}
                </button>
              </form>

              <p className="tiny muted" style={{ marginTop: 16 }}>
                Accounts are created in the Supabase dashboard under Authentication, Users. The
                browser only ever holds the anon key, and it is used for sign-in alone. Every row on
                every screen comes from the API.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="login-right">
        <h2>Outbound that stops when it should</h2>
        <p className="small" style={{ color: 'rgba(255,255,255,0.62)', marginTop: 0, maxWidth: 400 }}>
          Five agents research, score, plan, write and read replies. A person approves what goes
          out, and the system is built to refuse rather than guess.
        </p>
        <div className="login-points">
          {POINTS.map((p, i) => (
            <div className="login-point" key={p.title}>
              <div className="login-num">{i + 1}</div>
              <div>
                <b>{p.title}</b>
                <span>{p.body}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
