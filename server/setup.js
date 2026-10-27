// Checks with PAGE_ACCESS_TOKEN: node setup.js [--subscribe]. Prints ids only, never a token.
const { PAGE_ID, PAGE_ACCESS_TOKEN: pt } = process.env;
const g = async (path, method = 'GET', body) =>
  (await fetch(`https://graph.facebook.com/v25.0/${path}${path.includes('?') ? '&' : '?'}access_token=${pt}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  })).json();
const ok = (label, r) => {
  if (r.error) throw new Error(`${label} failed: ${r.error.message}`);
  return r;
};

try {
  const me = ok('Token check', await g('me?fields=id,name'));
  console.log(`Token is for: ${me.name} (${me.id})${me.id === PAGE_ID ? '' : '  <- not the Page id, this is not a Page token'}`);

  const s = await g(`${PAGE_ID}/subscribed_apps`);
  console.log('Apps subscribed to this Page:', s.error ? `UNKNOWN (${s.error.message})` : s.data.map((a) => `${a.name} (${a.id})`).join(', ') || 'none');

  const forms = ok('leadgen_forms', await g(`${PAGE_ID}/leadgen_forms?fields=id,name,status`)).data;
  console.log('Forms:', forms.map((f) => `${f.id} "${f.name}" ${f.status}`).join(' | ') || 'none');

  if (process.argv.includes('--subscribe'))
    console.log('Subscribe:', JSON.stringify(ok('subscribe', await g(`${PAGE_ID}/subscribed_apps`, 'POST', { subscribed_fields: ['leadgen'] }))));
} catch (e) {
  console.log(e.message);
  process.exitCode = 1;
}
