import express from 'express';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';

const { MONGO_URI, META_VERIFY_TOKEN, META_APP_SECRET, PAGE_ACCESS_TOKEN, FORM_ID, PAGE_ID, WEBHOOK_URL, AUTH_EMAIL, AUTH_PASSWORD, PORT = 4000, DELAY_MS = 3000 } = process.env;
if (!AUTH_EMAIL || !AUTH_PASSWORD) {
  console.error('AUTH_EMAIL and AUTH_PASSWORD must be set in .env');
  process.exit(1);
}
const db = (await MongoClient.connect(MONGO_URI)).db('metatest');
const events = db.collection('events');
const leads = db.collection('leads');
await leads.createIndex({ meta_lead_id: 1 }, { unique: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (buf) => 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(buf).digest('hex');
const graph = (path, method = 'GET', body) =>
  fetch(`https://graph.facebook.com/v25.0/${path}${path.includes('?') ? '&' : '?'}access_token=${PAGE_ACCESS_TOKEN}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  }).then((r) => r.json());

// Fetch a lead from Graph and store it once (meta_lead_id is unique). Returns true if it was new.
const saveLead = async (id, source) => {
  const l = await graph(id);
  if (l.error) throw new Error(l.error.message);
  const r = await leads.updateOne(
    { meta_lead_id: l.id },
    { $setOnInsert: { meta_lead_id: l.id, source, submitted_at: l.created_time, field_data: l.field_data, raw: l, at: new Date() } },
    { upsert: true });
  return r.upsertedCount === 1;
};

const app = express();
// keep raw bytes: the HMAC must be computed over them, not over re-serialised JSON
app.use(express.json({ verify: (req, _res, buf) => (req.raw = buf) }));

// --- auth: one admin login from .env, stateless signed session cookie ---
const SESSION_MS = 12 * 60 * 60 * 1000;
// keyed on the password too, so changing it in .env logs everyone out
const mac = (s) => crypto.createHmac('sha256', `${META_APP_SECRET}:${AUTH_PASSWORD}`).update(s).digest('base64url');
const safeEq = (a, b) => {
  const h = (v) => crypto.createHash('sha256').update(String(v)).digest(); // equal length for timingSafeEqual
  return crypto.timingSafeEqual(h(a), h(b));
};
const isAuthed = (req) => {
  const token = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const [exp, sig] = token?.split('.') ?? [];
  return !!sig && +exp > Date.now() && safeEq(sig, mac(exp));
};
const cookie = (req, value, maxAge) =>
  `session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

const attempts = new Map(); // ip -> { n, reset }: 5 failed logins per minute
app.post('/api/login', (req, res) => {
  const a = attempts.get(req.ip);
  if (a && a.reset > Date.now() && a.n >= 5) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const { email = '', password = '' } = req.body ?? {};
  const ok = safeEq(email.trim().toLowerCase(), AUTH_EMAIL.trim().toLowerCase()) & safeEq(password, AUTH_PASSWORD); // & avoids short-circuit timing
  if (!ok) {
    attempts.set(req.ip, a && a.reset > Date.now() ? { ...a, n: a.n + 1 } : { n: 1, reset: Date.now() + 60_000 });
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  attempts.delete(req.ip);
  const exp = Date.now() + SESSION_MS;
  res.setHeader('Set-Cookie', cookie(req, `${exp}.${mac(String(exp))}`, SESSION_MS / 1000));
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => (res.setHeader('Set-Cookie', cookie(req, '', 0)), res.json({ ok: true })));
app.get('/api/session', (req, res) => res.sendStatus(isAuthed(req) ? 200 : 401));
app.use('/api', (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'Unauthorized' })));

app.get('/webhook', (req, res) =>
  req.query['hub.verify_token'] === META_VERIFY_TOKEN ? res.type('text').send(req.query['hub.challenge']) : res.sendStatus(403));

app.post('/webhook', async (req, res) => {
  const valid = req.get('x-hub-signature-256') === sign(req.raw);
  const { insertedId } = await events.insertOne({ at: new Date(), valid, payload: req.body }); // persist first
  res.sendStatus(200); // always 200, even on a bad signature
  if (!valid) return;
  for (const entry of req.body.entry ?? [])
    for (const c of entry.changes ?? []) {
      if (c.field !== 'leadgen') continue;
      try {
        await saveLead(c.value.leadgen_id, 'webhook');
      } catch (e) {
        await events.updateOne({ _id: insertedId }, { $push: { errors: e.message } });
      }
    }
});

// --- test drivers ---
const run = { running: false, done: 0, total: 0, created: 0, pollSaved: 0, errors: [] };

// Meta only dispatches leadgen webhooks to a published app (the dashboard's Test button aside), so for an
// unpublished app we replay Meta's delivery ourselves: a signed leadgen POST for the real lead id, sent to WEBHOOK_URL.
const forwardWebhook = async (leadgenId, formId) => {
  if (!WEBHOOK_URL) return null;
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    object: 'page',
    entry: [{ id: PAGE_ID, time: now, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: PAGE_ID, form_id: formId, created_time: now } }] }],
  });
  const r = await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) }, body });
  return r.status;
};

// Meta allows one test lead per form, so each round deletes the previous one first.
// Round: delete old -> create -> wait for the webhook -> poll it from Graph (saved only if the webhook missed it).
// Meta allows one test lead per form: delete the old one, then create. Throws on a Graph error.
const createTestLead = async (formId, fields) => {
  for (const old of (await graph(`${formId}/test_leads`)).data ?? []) await graph(old.id, 'DELETE');
  const r = await graph(`${formId}/test_leads`, 'POST', {
    field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })),
  });
  if (r.error) throw new Error(r.error.user_msg ?? r.error.error_user_msg ?? r.error.message);
  return r.id;
};

// Add a single lead from the UI form: create it in Meta, wait for the webhook, then poll as a fallback.
let adding = false;
app.post('/api/lead', async (req, res) => {
  if (adding || run.running) return res.status(409).json({ error: 'Another send is in progress' });
  const { form_id = FORM_ID, fields = {} } = req.body;
  adding = true;
  try {
    // validate against the form's own questions: Meta rejects a test lead that omits any of them
    const { questions = [], error } = await graph(`${form_id}?fields=questions`);
    if (error) throw new Error(error.message);
    const missing = questions.filter((q) => !String(fields[q.key] ?? '').trim()).map((q) => q.label || q.key);
    if (missing.length) return res.status(400).json({ error: `Required: ${missing.join(', ')}` });
    const id = await createTestLead(form_id, Object.fromEntries(questions.map((q) => [q.key, String(fields[q.key]).trim()])));
    const webhook = await forwardWebhook(id, form_id).catch((e) => `failed: ${e.message}`);
    await sleep(+DELAY_MS);
    const viaPoll = await saveLead(id, 'poll');
    res.json({ id, source: viaPoll ? 'poll' : 'webhook', webhook });
  } catch (e) {
    res.status(502).json({ error: e.message });
  } finally {
    adding = false;
  }
});

// All lead forms on the Page the token belongs to, with their questions (so the UI can render a matching form).
app.get('/api/forms', async (_req, res) => {
  try {
    const page = await graph('me?fields=id,name');
    if (page.error) throw new Error(page.error.message);
    const forms = [];
    let after = '';
    do {
      const r = await graph(`${page.id}/leadgen_forms?fields=id,name,status,leads_count,created_time,questions&limit=50${after}`);
      if (r.error) throw new Error(r.error.message);
      forms.push(...(r.data ?? []));
      after = r.paging?.next ? `&after=${r.paging.cursors.after}` : '';
    } while (after);
    res.json({ page: { id: page.id, name: page.name }, forms, defaultId: FORM_ID });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Plausible value for one form question, used by the bulk sender.
const sampleValue = (q, seed) => {
  if (q.options?.length) return q.options[seed % q.options.length].key;
  const t = `${q.type} ${q.key}`.toUpperCase();
  if (t.includes('EMAIL')) return `t${Date.now()}${seed}@example.com`;
  if (t.includes('PHONE')) return `+9198${String(Date.now() + seed).slice(-8)}`;
  if (t.includes('FIRST')) return 'Test';
  if (t.includes('LAST')) return `User${seed}`;
  if (t.includes('NAME')) return `Test ${Date.now()}-${seed}`;
  if (t.includes('CITY')) return 'Pune';
  if (t.includes('STATE')) return 'Maharashtra';
  if (t.includes('ZIP') || t.includes('POST')) return '411001';
  if (t.includes('GENDER')) return 'male';
  return 'Test';
};

app.post('/api/fire', (req, res) => {
  if (run.running) return res.status(409).json(run);
  const formId = req.body.form_id || FORM_ID;
  Object.assign(run, { running: true, done: 0, total: +req.body.n || 1, created: 0, pollSaved: 0, errors: [] });
  res.json(run);
  (async () => {
    let questions = [], error;
    try { ({ questions = [], error } = await graph(`${formId}?fields=questions`)); } catch (e) { error = e; }
    if (error) run.errors.push(error.message);
    for (let i = 0; !error && i < run.total; i++) {
      try {
        // Meta rejects a test lead that omits any form field, so fill every question
        const id = await createTestLead(formId, Object.fromEntries(questions.map((q) => [q.key, sampleValue(q, i)])));
        run.created++;
        await forwardWebhook(id, formId).catch((e) => run.errors.push(`webhook forward: ${e.message}`));
        await sleep(+DELAY_MS);
        if (await saveLead(id, 'poll')) run.pollSaved++;
      } catch (e) { run.errors.push(e.message); }
      run.done++;
    }
    run.running = false;
  })();
});

// Front-door path: signed fake payloads straight at our own webhook (fake leadgen ids fail the Graph fetch).
app.post('/api/replay', async (req, res) => {
  const n = +req.body.n || 1;
  for (let i = 0; i < n; i++) {
    const body = JSON.stringify({ object: 'page', entry: [{ id: '0', time: Date.now(), changes: [{ field: 'leadgen', value: { leadgen_id: `fake-${Date.now()}-${i}`, form_id: FORM_ID } }] }] });
    await fetch(`http://localhost:${PORT}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) }, body });
  }
  res.json({ sent: n });
});

app.get('/api/stats', async (_req, res) =>
  res.json({
    run,
    events: await events.countDocuments(),
    badSignature: await events.countDocuments({ valid: false }),
    failedFetch: await events.countDocuments({ errors: { $exists: true } }),
    leads: await leads.countDocuments(),
    viaWebhook: await leads.countDocuments({ source: 'webhook' }),
    latest: await leads.find().sort({ at: -1 }).limit(10).project({ raw: 0 }).toArray(),
  }));

app.post('/api/reset', async (_req, res) => (await events.deleteMany({}), await leads.deleteMany({}), res.json({ ok: true })));

app.listen(PORT, () => console.log(`server on :${PORT}`));
