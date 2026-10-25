import assert from 'node:assert/strict';

// Local integration test only. Never submit fixture orders to production.
const origin = 'http://127.0.0.1:8787';
const health = await (await fetch(origin + '/api/health')).json();
assert.equal(health.ok, true);
assert.equal(health.notificationsConfigured, false, 'Run fixture tests without SMTP secrets so no emails can be sent');
const payload = {name: 'Local integration fixture', email: 'fixture@example.com', language: 'en', consent: true, currency: 'USD', country: 'Tunisia', items: [{id: 'shadha-beige', quantity: 2}]};
const key = crypto.randomUUID();
const headers = {'Content-Type': 'application/json', Origin: origin, 'Idempotency-Key': key, 'CF-Connecting-IP': '192.0.2.' + (Math.floor(Math.random() * 200) + 1)};
const post = (data = payload, changes = {}) => fetch(origin + '/api/preorders', {method: 'POST', headers: {...headers, ...changes}, body: JSON.stringify(data)});
const responses = await Promise.all([post(), post(), post()]);
assert.ok(responses.every(response => [200, 201].includes(response.status)));
const records = await Promise.all(responses.map(response => response.json()));
assert.ok(records[0].reference.startsWith('FL-'));
assert.equal(new Set(records.map(record => record.reference)).size, 1);
assert.equal((await post({...payload, country: 'France'})).status, 409);
assert.equal((await post(payload, {Origin: 'https://other.example'})).status, 403);
assert.equal((await post({...payload, consent: false})).status, 400);
assert.equal((await post({...payload, notes: 'x'.repeat(17000)})).status, 413);
const contact = await fetch(origin + '/api/messages', {method: 'POST', headers: {...headers, 'Idempotency-Key': crypto.randomUUID()}, body: JSON.stringify({name: 'Fixture', email: 'fixture@example.com', language: 'fr', subject: 'Runtime check', message: 'Local test only'})});
assert.equal(contact.status, 201);
assert.ok((await contact.json()).reference.startsWith('FM-'));
for (const route of ['/', '/shop', '/collections', '/product/the-vintage-garden-greige', '/product/the-vintage-garden-royal-blue', '/product/rosette-yellow', '/product/shadha-beige', '/help', '/contact', '/privacy', '/checkout']) {
  const response = await fetch(origin + route);
  assert.equal(response.status, 200, route);
  const html = await response.text();
  assert.match(html, /window\.__FOULARA_SERVER__=true/);
  assert.ok(html.includes(`rel="canonical" href="${origin + route}"`), route);
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  if (route === '/checkout') assert.match(html, /name="robots" content="noindex,follow"/);
}
const arabic = await (await fetch(origin + '/product/the-vintage-garden-greige?lang=ar')).text();
assert.match(arabic, /<html lang="ar" dir="rtl">/);
assert.match(arabic, /hreflang="fr"/);
const asset = arabic.match(/\/assets\/[^"'\s,)]+\.avif/)[0];
const image = await fetch(origin + asset);
assert.equal(image.status, 200);
assert.match(image.headers.get('Cache-Control'), /immutable/);
for (const route of ['/server.py', '/.env', '/wrangler.jsonc', '/api/unknown', '/does-not-exist']) assert.equal((await fetch(origin + route)).status, 404, route);
assert.equal((await fetch(origin + '/api/preorders')).status, 405);
assert.equal((await fetch(origin + '/robots.txt')).status, 200);
assert.match(await (await fetch(origin + '/sitemap.xml')).text(), /<urlset/);
// Exceed the client limit with unique valid submissions after earlier fixture calls.
const limited = [];
for (let i = 0; i < 12; i++) limited.push((await post(payload, {'Idempotency-Key': crypto.randomUUID()})).status);
assert.ok(limited.includes(429));
console.log('Workers runtime checks passed: persistence, concurrent deduplication, validation, rate limiting, contact, routes, locale metadata, private-file isolation and media caching.');
