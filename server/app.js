// The Express app, with no listen(): server/index.js listens locally, api/index.js serves it on Vercel.
import express from 'express';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';

const E = process.env;
const { MONGO_URI, AUTH_EMAIL, AUTH_PASSWORD, VERCEL, DELAY_MS = 3000 } = E;
if (!AUTH_EMAIL || !AUTH_PASSWORD) throw new Error('AUTH_EMAIL and AUTH_PASSWORD must be set in the environment');

// Two Meta apps, picked per request from the UI toggle. Each reads its own PRODUCTION_* / STAGING_* variables.
const REQUIRED = ['META_APP_ID', 'META_APP_SECRET', 'PAGE_ID', 'PAGE_ACCESS_TOKEN'];
const makeEnv = (name) => {
  const p = name.toUpperCase();
  return {
    name, appSecret: E[`${p}_META_APP_SECRET`], token: E[`${p}_PAGE_ACCESS_TOKEN`], pageId: E[`${p}_PAGE_ID`],
    verifyToken: E[`${p}_META_VERIFY_TOKEN`], webhookUrl: E[`${p}_WEBHOOK_URL`], // both optional, see /webhook and forwardWebhook
  };
};
const ENVS = { production: makeEnv('production'), staging: makeEnv('staging') };
const missingVars = Object.keys(ENVS).flatMap((n) => REQUIRED.map((k) => `${n.toUpperCase()}_${k}`)).filter((k) => !E[k]);
if (missingVars.length) throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
const ENV_LIST = Object.values(ENVS);
const envFilter = (env) => ({ env: env.name });

// Serverless: no top-level connect. The client is created on first use and reused while the instance is warm.
let dbPromise;
const getDb = () =>
  (dbPromise ??= MongoClient.connect(MONGO_URI, { maxPoolSize: 5 })
    .then(async (c) => {
      const db = c.db('metatest');
      await db.collection('leads').createIndex({ meta_lead_id: 1 }, { unique: true });
      return db;
    })
    .catch((e) => { dbPromise = undefined; throw e; })); // don't cache a failed connect
const col = async (name) => (await getDb()).collection(name);

// Work that must finish after the response is sent. Vercel freezes the function once it responds, so it has to be
// handed to waitUntil there; locally the process just keeps running.
const defer = async (promise) => {
  if (VERCEL) (await import('@vercel/functions')).waitUntil(promise);
  else promise.catch((e) => console.error(e));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (env, buf) => 'sha256=' + crypto.createHmac('sha256', env.appSecret).update(buf).digest('hex');
const graph = (env, path, method = 'GET', body) =>
  fetch(`https://graph.facebook.com/v25.0/${path}${path.includes('?') ? '&' : '?'}access_token=${env.token}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  }).then((r) => r.json());

// Fetch a lead from Graph and store it once (meta_lead_id is unique). Returns true if it was new.
const saveLead = async (env, id, source) => {
  const l = await graph(env, id);
  if (l.error) throw new Error(l.error.message);
  const leads = await col('leads');
  const r = await leads.updateOne(
    { meta_lead_id: l.id },
    { $setOnInsert: { meta_lead_id: l.id, env: env.name, source, submitted_at: l.created_time, field_data: l.field_data, raw: l, at: new Date() } },
    { upsert: true });
  return r.upsertedCount === 1;
};

const app = express();
app.set('trust proxy', 1); // behind Vercel's proxy: correct req.ip and req.secure (for the Secure cookie flag)
// Express 4 ignores a rejected async handler, which would hang the request (or crash locally). Forward it to the error handler below.
for (const method of ['get', 'post']) {
  const register = app[method].bind(app);
  app[method] = (path, ...handlers) =>
    handlers.length
      ? register(path, ...handlers.map((h) => (h.constructor.name === 'AsyncFunction' ? (req, res, next) => h(req, res, next).catch(next) : h)))
      : register(path); // app.get(name) is also Express's settings getter
}
// keep raw bytes: the HMAC must be computed over them, not over re-serialised JSON
app.use(express.json({ verify: (req, _res, buf) => (req.raw = buf) }));

// --- auth: one admin login from the environment, stateless signed session cookie ---
const SESSION_MS = 12 * 60 * 60 * 1000;
// keyed on the password too, so changing it logs everyone out
const mac = (s) => crypto.createHmac('sha256', `${ENVS.production.appSecret}:${AUTH_PASSWORD}`).update(s).digest('base64url');
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

const attempts = new Map(); // ip -> { n, reset }: 5 failed logins per minute (per instance when serverless)
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
// The UI's environment toggle: every /api call below runs against req.env (default production).
app.use('/api', (req, res, next) => {
  const name = req.get('x-env') ?? 'production';
  if (!ENVS[name]) return res.status(400).json({ error: 'Unknown environment' });
  req.env = ENVS[name];
  next();
});

// One webhook URL serves both apps: verification accepts either verify token (if set), and the signature says which app sent it.
app.get('/webhook', (req, res) =>
  ENV_LIST.some((e) => e.verifyToken && e.verifyToken === req.query['hub.verify_token']) ? res.type('text').send(req.query['hub.challenge']) : res.sendStatus(403));

app.post('/webhook', async (req, res) => {
  const env = ENV_LIST.find((e) => req.get('x-hub-signature-256') === sign(e, req.raw ?? ''));
  const valid = !!env;
  const events = await col('events');
  const { insertedId } = await events.insertOne({ at: new Date(), valid, ...(env && { env: env.name }), payload: req.body }); // persist first
  res.sendStatus(200); // always 200, even on a bad signature
  if (!valid) return;
  await defer((async () => {
    for (const entry of req.body.entry ?? [])
      for (const c of entry.changes ?? []) {
        if (c.field !== 'leadgen') continue;
        try {
          await saveLead(env, c.value.leadgen_id, 'webhook');
        } catch (e) {
          await events.updateOne({ _id: insertedId }, { $push: { errors: e.message } });
        }
      }
  })());
});

// --- test drivers ---
// Bulk-send progress lives in Mongo, not memory: on Vercel every request may hit a different instance.
const RUN_IDLE = { running: false, done: 0, total: 0, created: 0, pollSaved: 0, errors: [] };
const STALE_MS = 2 * 60 * 1000; // a run that stopped updating (function killed mid-way) is not "running" any more
const getRun = async () => {
  const doc = await (await col('runs')).findOne({ _id: 'run' });
  if (!doc) return RUN_IDLE;
  const { _id, updatedAt, ...run } = doc;
  return run.running && Date.now() - updatedAt > STALE_MS ? { ...run, running: false } : run;
};
const patchRun = async (update) =>
  (await col('runs')).updateOne({ _id: 'run' }, { ...update, $set: { ...update.$set, updatedAt: Date.now() } }, { upsert: true });

// Meta only dispatches leadgen webhooks to a published app (the dashboard's Test button aside), so for an
// unpublished app we replay Meta's delivery ourselves: a signed leadgen POST for the real lead id, sent to WEBHOOK_URL.
const forwardWebhook = async (env, leadgenId, formId) => {
  if (!env.webhookUrl) return null;
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    object: 'page',
    entry: [{ id: env.pageId, time: now, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: env.pageId, form_id: formId, created_time: now } }] }],
  });
  const r = await fetch(env.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(env, body) }, body });
  return r.status;
};

// Meta allows one test lead per form: delete the old one, then create. Throws on a Graph error.
const createTestLead = async (env, formId, fields) => {
  for (const old of (await graph(env, `${formId}/test_leads`)).data ?? []) await graph(env, old.id, 'DELETE');
  const r = await graph(env, `${formId}/test_leads`, 'POST', {
    field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })),
  });
  if (r.error) throw new Error(r.error.user_msg ?? r.error.error_user_msg ?? r.error.message);
  return r.id;
};

// Add a single lead from the UI form: create it in Meta, wait for the webhook, then poll as a fallback.
let adding = false;
app.post('/api/lead', async (req, res) => {
  if (adding || (await getRun()).running) return res.status(409).json({ error: 'Another send is in progress' });
  const { env } = req;
  const { form_id, fields = {} } = req.body;
  adding = true;
  try {
    // validate against the form's own questions: Meta rejects a test lead that omits any of them
    const { questions = [], error } = await graph(env, `${form_id}?fields=questions`);
    if (error) throw new Error(error.message);
    const missing = questions.filter((q) => !String(fields[q.key] ?? '').trim()).map((q) => q.label || q.key);
    if (missing.length) return res.status(400).json({ error: `Required: ${missing.join(', ')}` });
    const id = await createTestLead(env, form_id, Object.fromEntries(questions.map((q) => [q.key, String(fields[q.key]).trim()])));
    const webhook = await forwardWebhook(env, id, form_id).catch((e) => `failed: ${e.message}`);
    await sleep(+DELAY_MS);
    const viaPoll = await saveLead(env, id, 'poll');
    res.json({ id, source: viaPoll ? 'poll' : 'webhook', webhook });
  } catch (e) {
    res.status(502).json({ error: e.message });
  } finally {
    adding = false;
  }
});

// All lead forms on the Page the token belongs to, with their questions (so the UI can render a matching form).
app.get('/api/forms', async (req, res) => {
  const { env } = req;
  try {
    const page = await graph(env, 'me?fields=id,name');
    if (page.error) throw new Error(page.error.message);
    const forms = [];
    let after = '';
    do {
      const r = await graph(env, `${page.id}/leadgen_forms?fields=id,name,status,leads_count,created_time,questions&limit=50${after}`);
      if (r.error) throw new Error(r.error.message);
      forms.push(...(r.data ?? []));
      after = r.paging?.next ? `&after=${r.paging.cursors.after}` : '';
    } while (after);
    res.json({ page: { id: page.id, name: page.name }, forms, defaultId: null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Plausible value for one form question, used by the bulk sender. Email and phone are random (not time-derived)
// so repeated runs never collide on a downstream duplicate check.
const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Ananya', 'Diya', 'Isha', 'Kabir', 'Meera', 'Rohan', 'Saanvi', 'Tanvi', 'Yash'];
const LAST = ['Sharma', 'Patel', 'Mehta', 'Iyer', 'Nair', 'Reddy', 'Joshi', 'Kulkarni', 'Singh', 'Gupta', 'Desai', 'Rao'];
const pick = (list) => list[crypto.randomInt(list.length)];
const randomPhone = () => `+91${crypto.randomInt(6, 10)}${String(crypto.randomInt(1e9)).padStart(9, '0')}`; // 10 digits, starts 6-9
const randomEmail = () => `lead.${crypto.randomBytes(5).toString('hex')}@example.com`;
const sampleValue = (q, seed) => {
  if (q.options?.length) return q.options[seed % q.options.length].key;
  const t = `${q.type} ${q.key}`.toUpperCase();
  if (t.includes('EMAIL')) return randomEmail();
  if (t.includes('PHONE')) return randomPhone();
  if (t.includes('FIRST')) return pick(FIRST);
  if (t.includes('LAST')) return pick(LAST);
  if (t.includes('NAME')) return `${pick(FIRST)} ${pick(LAST)}`;
  if (t.includes('CITY')) return 'Pune';
  if (t.includes('STATE')) return 'Maharashtra';
  if (t.includes('ZIP') || t.includes('POST')) return '411001';
  if (t.includes('GENDER')) return 'male';
  return 'Test';
};

// A Vercel function is killed at maxDuration (see vercel.json), so a bulk run stops cleanly a little before that.
const BUDGET_MS = VERCEL ? 50_000 : Infinity;

app.post('/api/fire', async (req, res) => {
  const current = await getRun();
  if (current.running) return res.status(409).json(current);
  const { env } = req;
  const formId = req.body.form_id;
  const total = +req.body.n || 1;
  await patchRun({ $set: { ...RUN_IDLE, running: true, total } });
  res.json({ ...RUN_IDLE, running: true, total });
  await defer((async () => {
    const started = Date.now();
    const fail = (message) => patchRun({ $push: { errors: message } });
    let questions = [], error;
    try { ({ questions = [], error } = await graph(env, `${formId}?fields=questions`)); } catch (e) { error = e; }
    if (error) await fail(error.message);
    for (let i = 0; !error && i < total; i++) {
      if (Date.now() - started > BUDGET_MS) {
        await fail(`Stopped after ${i} of ${total}: hit the serverless time limit. Send fewer leads per run.`);
        break;
      }
      try {
        // Meta rejects a test lead that omits any form field, so fill every question
        const id = await createTestLead(env, formId, Object.fromEntries(questions.map((q) => [q.key, sampleValue(q, i)])));
        await patchRun({ $inc: { created: 1 } });
        await forwardWebhook(env, id, formId).catch((e) => fail(`webhook forward: ${e.message}`));
        await sleep(+DELAY_MS);
        if (await saveLead(env, id, 'poll')) await patchRun({ $inc: { pollSaved: 1 } });
      } catch (e) { await fail(e.message); }
      await patchRun({ $inc: { done: 1 } });
    }
    await patchRun({ $set: { running: false } });
  })());
});

// Front-door path: signed fake payloads straight at our own webhook (fake leadgen ids fail the Graph fetch).
app.post('/api/replay', async (req, res) => {
  const { env } = req;
  const n = +req.body.n || 1;
  const self = `${req.protocol}://${req.get('host')}/webhook`;
  for (let i = 0; i < n; i++) {
    const body = JSON.stringify({ object: 'page', entry: [{ id: '0', time: Date.now(), changes: [{ field: 'leadgen', value: { leadgen_id: `fake-${Date.now()}-${i}`, form_id: 'fake' } }] }] });
    await fetch(self, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(env, body) }, body });
  }
  res.json({ sent: n });
});

app.get('/api/stats', async (req, res) => {
  const [events, leads] = [await col('events'), await col('leads')];
  const f = envFilter(req.env);
  res.json({
    run: await getRun(),
    events: await events.countDocuments(f),
    // a bad signature can't be attributed to an app, so these show under production only
    badSignature: req.env.name === 'production' ? await events.countDocuments({ valid: false }) : 0,
    failedFetch: await events.countDocuments({ ...f, errors: { $exists: true } }),
    leads: await leads.countDocuments(f),
    viaWebhook: await leads.countDocuments({ ...f, source: 'webhook' }),
    latest: await leads.find(f).sort({ at: -1 }).limit(10).project({ raw: 0 }).toArray(),
  });
});

app.post('/api/reset', async (req, res) => {
  const f = envFilter(req.env);
  await (await col('events')).deleteMany(f);
  await (await col('leads')).deleteMany(f);
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) res.status(err.status ?? 500).json({ error: err.status ? 'Bad request' : 'Server error' });
});

export default app;
