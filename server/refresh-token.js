// node refresh-token.js: turns a fresh short-lived USER_TOKEN into a non-expiring PAGE_ACCESS_TOKEN in ../.env. Prints no token.
import fs from 'node:fs';

const { APP_ID, META_APP_SECRET, USER_TOKEN, PAGE_ID } = process.env;
const get = async (path) => (await fetch(`https://graph.facebook.com/v25.0/${path}`)).json();
const ok = (label, r) => {
  if (r.error) throw new Error(`${label} failed: ${r.error.message}`);
  return r;
};

try {
  const long = ok('Exchange', await get(`oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${USER_TOKEN}`));
  const page = ok('Page token', await get(`${PAGE_ID}?fields=name,access_token&access_token=${long.access_token}`));
  if (!page.access_token) throw new Error('No Page token returned: the user has no access to this Page for this app');
  fs.writeFileSync('../.env', fs.readFileSync('../.env', 'utf8').replace(/^PAGE_ACCESS_TOKEN=.*$/m, `PAGE_ACCESS_TOKEN=${page.access_token}`).replace(/^USER_TOKEN=.*$/m, 'USER_TOKEN='));
  console.log(`PAGE_ACCESS_TOKEN updated for ${page.name}. USER_TOKEN cleared.`);
} catch (e) {
  console.log(e.message);
  process.exitCode = 1;
}
