import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const find = (l, re) => l.field_data?.find((f) => re.test(f.name))?.values?.[0] ?? '—';
const others = (l) =>
  l.field_data?.filter((f) => !/name|email|phone/i.test(f.name)).map((f) => f.values?.[0]).filter(Boolean).join(', ') || '—';
const inputType = (q) => (/EMAIL/.test(q.type) ? 'email' : /PHONE/.test(q.type) ? 'tel' : 'text');
const label = (q) => q.label || q.key.replace(/_/g, ' ');

function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function AddLeadForm({ form, busy }) {
  const questions = form?.questions ?? [];
  const [f, setF] = useState({});
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => { setF({}); setMsg(null); }, [form?.id]);

  const submit = async (e) => {
    e.preventDefault();
    setSending(true);
    setMsg(null);
    try {
      const r = await post('/api/lead', { form_id: form.id, fields: f });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Server error (${r.status}). Check the server is running and try again.`);
      setMsg({ ok: true, text: `Lead created (${d.source === 'webhook' ? 'received via webhook' : 'saved by polling'}).${d.webhook ? ` Webhook POST returned ${d.webhook}.` : ''}` });
      setF({});
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
    setSending(false);
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Add a lead</h2>
      {questions.length === 0 && <p className="sub">This form has no questions to fill in.</p>}
      {questions.map((q) => (
        <div className="field" key={q.key}>
          <label htmlFor={q.key}>{label(q)} *</label>
          {q.options?.length ? (
            <select id={q.key} value={f[q.key] ?? ''} onChange={set(q.key)} required>
              <option value="" disabled>Select…</option>
              {q.options.map((o) => <option key={o.key} value={o.key}>{o.value}</option>)}
            </select>
          ) : /GENDER/.test(q.type) ? (
            <select id={q.key} value={f[q.key] ?? ''} onChange={set(q.key)} required>
              <option value="" disabled>Select…</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </select>
          ) : (
            <input id={q.key} type={inputType(q)} value={f[q.key] ?? ''} onChange={set(q.key)} required />
          )}
        </div>
      ))}
      <button className="primary block" disabled={sending || busy || !questions.length}>
        {sending ? 'Submitting…' : busy ? 'Bulk send running…' : 'Submit lead'}
      </button>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
    </form>
  );
}

function FormPicker({ data, formId, onChange }) {
  if (!data) return <div className="card"><h2>Lead form</h2><p className="sub">Loading forms…</p></div>;
  if (data.error) return <div className="card"><h2>Lead form</h2><div className="notice err">{data.error}</div></div>;
  const form = data.forms.find((x) => x.id === formId);
  return (
    <div className="card">
      <h2>Lead form</h2>
      <div className="field" style={{ marginBottom: 6 }}>
        <label htmlFor="form">{data.page.name} · {data.forms.length} form{data.forms.length === 1 ? '' : 's'}</label>
        <select id="form" value={formId} onChange={(e) => onChange(e.target.value)}>
          {data.forms.map((x) => (
            <option key={x.id} value={x.id} disabled={x.status === 'ARCHIVED'}>
              {x.name}{x.status === 'ARCHIVED' ? ' (archived)' : ''}
            </option>
          ))}
        </select>
      </div>
      {form && <p className="sub">{form.status} · {form.leads_count ?? 0} leads in Meta · {form.questions?.length ?? 0} questions</p>}
    </div>
  );
}

function BulkSend({ run, formId }) {
  const [n, setN] = useState(10);
  const pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
  const errors = [...new Set(run.errors)];
  return (
    <div className="card">
      <h2>Bulk test send</h2>
      <div className="bulk">
        <div className="field">
          <label htmlFor="n">Count</label>
          <input id="n" type="number" min="1" value={n} onChange={(e) => setN(e.target.value)} disabled={run.running} />
        </div>
        <button className="primary" onClick={() => post('/api/fire', { n, form_id: formId })} disabled={run.running}>
          {run.running ? 'Sending…' : 'Send leads'}
        </button>
        <button
          onClick={() => window.confirm('Delete all stored events and leads?') && post('/api/reset')}
          disabled={run.running}
        >
          Reset data
        </button>
      </div>
      {run.total > 0 && (
        <>
          <div className="progress"><div style={{ width: `${pct}%` }} /></div>
          <p className="sub">{run.done} of {run.total} sent · {run.created} created in Meta · {run.pollSaved} recovered by polling</p>
        </>
      )}
      {errors.length > 0 && <div className="notice err">{errors.join('\n')}</div>}
    </div>
  );
}

function Login({ onSuccess }) {
  const [f, setF] = useState({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await post('/api/login', f);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `Server error (${r.status}). Is the API server running?`);
      }
      onSuccess();
    } catch (x) {
      setErr(x.message);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Lead Webhook Console</h1>
        <p className="sub" style={{ marginBottom: 18 }}>Sign in to continue</p>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" autoFocus required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </div>
        <button className="primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {err && <div className="notice err">{err}</div>}
      </form>
    </div>
  );
}

function Dashboard({ onLogout }) {
  const [s, setS] = useState(null);
  const [online, setOnline] = useState(true);
  const [forms, setForms] = useState(null);
  const [formId, setFormId] = useState('');

  useEffect(() => {
    fetch('/api/forms')
      .then((r) => r.json())
      .then((d) => {
        setForms(d);
        if (d.error) return;
        const active = d.forms.filter((x) => x.status !== 'ARCHIVED');
        setFormId((active.find((x) => x.id === d.defaultId) ?? active[0])?.id ?? '');
      })
      .catch(() => setForms({ error: 'Could not load forms. Is the API server running?' }));
  }, []);

  useEffect(() => {
    const load = () =>
      fetch('/api/stats').then((r) => (r.status === 401 ? (onLogout(), Promise.reject()) : r.json())).then((d) => { setS(d); setOnline(true); }).catch(() => setOnline(false));
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="app">
      <header>
        <div>
          <h1>Lead Webhook Console</h1>
          <p className="sub">Meta Lead Ads → webhook → MongoDB</p>
        </div>
        <div className="status">
          <span className={`dot ${online ? '' : 'off'}`} />{online ? 'Server connected' : 'Server unreachable'}
          <button onClick={() => post('/api/logout').then(onLogout)}>Sign out</button>
        </div>
      </header>

      {!s ? (
        <div className="empty">{online ? 'Loading…' : 'Cannot reach the API server. Is it running on port 4000?'}</div>
      ) : (
        <>
          <section className="stats">
            <Stat label="Leads stored" value={s.leads} />
            <Stat label="Via webhook" value={s.viaWebhook} hint="delivered in real time" />
            <Stat label="Via polling" value={s.leads - s.viaWebhook} hint="webhook missed" />
            <Stat label="Webhook events" value={s.events} />
            <Stat label="Bad signature" value={s.badSignature} />
            <Stat label="Failed fetch" value={s.failedFetch} />
          </section>

          <div className="grid">
            <div>
              <FormPicker data={forms} formId={formId} onChange={setFormId} />
              <AddLeadForm form={forms?.forms?.find((x) => x.id === formId)} busy={s.run.running} />
              <BulkSend run={s.run} formId={formId} />
            </div>
            <div className="card">
              <div className="card-head"><h2>Latest leads</h2><span className="sub">last 10</span></div>
              {s.latest.length === 0 ? (
                <div className="empty">No leads yet. Add one with the form.</div>
              ) : (
                <div className="scroll">
                  <table>
                    <thead>
                      <tr><th>Name</th><th>Email</th><th>Phone</th><th>Other</th><th>Source</th><th>Received</th></tr>
                    </thead>
                    <tbody>
                      {s.latest.map((l) => (
                        <tr key={l._id}>
                          <td>{find(l, /name/i)}</td>
                          <td>{find(l, /email/i)}</td>
                          <td>{find(l, /phone/i)}</td>
                          <td>{others(l)}</td>
                          <td><span className={`badge ${l.source}`}>{l.source}</span></td>
                          <td>{new Date(l.at).toLocaleTimeString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function App() {
  const [authed, setAuthed] = useState(null); // null = checking
  useEffect(() => {
    fetch('/api/session').then((r) => setAuthed(r.ok)).catch(() => setAuthed(false));
  }, []);
  if (authed === null) return null;
  return authed ? <Dashboard onLogout={() => setAuthed(false)} /> : <Login onSuccess={() => setAuthed(true)} />;
}

createRoot(document.getElementById('root')).render(<App />);
