import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {validate, notification} from '../worker/validation.js';

const request = () => ({name: 'Test customer', email: 'customer@example.com', language: 'en', consent: true, currency: 'USD', country: 'Tunisia', items: [{id: 'the-vintage-garden-greige', quantity: 2, usd_cents: 1}]});
test('the server enforces catalogue prices and strips client-controlled prices', () => {
  const result = validate(request(), 'preorder');
  assert.equal(result.total_usd_cents, 5000);
  assert.equal(result.items[0].usd_cents, 2500);
});
test('Canadian preorder requests use the approved CAD price list', () => {
  const result = validate({...request(), currency: 'CAD'}, 'preorder');
  assert.equal(result.currency, 'CAD');
  assert.equal(result.total_usd_cents, 5000);
  assert.equal(result.total_cad_cents, 7000);
  const mail = notification({kind: 'preorder', reference: 'FL-CAD-TEST', payload: result}, 'sender@example.com');
  assert.match(mail.text, /Display currency: CAD/);
  assert.match(mail.text, /\$70\.00 CAD/);
  assert.throws(() => validate({...request(), currency: 'BTC'}, 'preorder'));
});
test('reject unknown products, duplicate variants, excess quantities and absent consent', () => {
  for (const update of [{consent: false}, {items: [{id: 'unknown', quantity: 1}]}, {items: [{id: '__proto__', quantity: 1}]}, {items: [{id: 'shadha-beige', quantity: 10}]}, {items: [{id: 'shadha-beige', quantity: 1}, {id: 'shadha-beige', quantity: 2}]}]) {
    assert.throws(() => validate({...request(), ...update}, 'preorder'));
  }
});
test('reject invalid emails, header injection and honeypot requests', () => {
  for (const update of [{email: 'invalid'}, {email: 'a@example.com\r\nBcc: b@example.com'}, {website: 'spam'}, {language: 'unknown'}]) assert.throws(() => validate({...request(), ...update}, 'preorder'));
});
test('notifications always go to the specified owner and contain verified order totals', () => {
  const mail = notification({kind: 'preorder', reference: 'FL-TEST', payload: validate(request(), 'preorder'), created_at: '2026-10-25T00:00:00Z'}, 'sender@example.com');
  assert.equal(mail.to, 'mouyahama@gmail.com');
  assert.equal(mail.replyTo, 'customer@example.com');
  assert.match(mail.text, /\$50\.00 USD/);
  assert.match(mail.text, /No payment collected/);
});
test('mixed quantities use exact regional prices and ignore submitted price overrides', () => {
  const result = validate({...request(), currency: 'CAD', items: [
    {id: 'the-vintage-garden-royal-blue', quantity: 2, cad_cents: 1},
    {id: 'rosette-yellow', quantity: 1, cad_cents: 1},
    {id: 'shadha-beige', quantity: 3, cad_cents: 1}
  ]}, 'preorder');
  assert.equal(result.total_usd_cents, 11400);
  assert.equal(result.total_cad_cents, 16000);
  assert.deepEqual(result.items.map(item => item.cad_cents), [3500, 2700, 2100]);
});
test('notifications for older queued requests retain their recorded pricing', () => {
  const payload = {...request(), total_usd_cents: 3464, items: [{name: 'The Vintage Garden', color: 'Greige', quantity: 2, usd_cents: 1732}]};
  const mail = notification({kind: 'preorder', reference: 'FL-OLD', payload}, 'sender@example.com');
  assert.match(mail.text, /\$34\.64 USD/);
  const canadian = notification({kind: 'preorder', reference: 'FL-OLD-CAD', payload: {...payload, currency: 'CAD'}}, 'sender@example.com');
  assert.match(canadian.text, /\$48\.47 CAD/);
});
test('contact enquiries are validated and addressed to the same inbox', () => {
  const payload = validate({name: 'Customer', email: 'customer@example.com', language: 'fr', subject: 'Question', message: 'A question about dimensions'}, 'message');
  assert.equal(notification({kind: 'message', reference: 'FM-TEST', payload}, 'sender@example.com').to, 'mouyahama@gmail.com');
});
test('build emits small HTML and actual cacheable media, without credentials', async () => {
  const html = await readFile('dist/index.html', 'utf8');
  assert.ok(Buffer.byteLength(html) < 200_000);
  assert.doesNotMatch(html, /data:(?:image\/(?:avif|webp)|font\/woff2);base64,/);
  assert.match(html, /window\.__FOULARA_SERVER__=true/);
  assert.doesNotMatch(html, /SMTP_PASSWORD|SMTP_USER/);
  const site = JSON.parse(await readFile('generated/site-data.json', 'utf8'));
  for (const url of [...Object.values(site.images), ...site.fonts.normal]) {
    assert.match(url, /^\/assets\/[\w.-]+$/);
    assert.ok((await stat('dist' + url)).size > 0);
  }
});
test('the repository-root Pages entry opens the storefront directly with deployed media', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.doesNotMatch(html, /http-equiv="refresh"|Open FOULARA/);
  assert.match(html, /home-title/);
  assert.ok(Buffer.byteLength(html) < 200_000);
  const site = JSON.parse(await readFile('generated/site-data.json', 'utf8'));
  assert.ok((await stat('.' + site.images['DSC04216-960'])).size > 0);
  const redirects = await readFile('_redirects', 'utf8');
  assert.match(redirects, /\/product\/\* \/ 200/);
  assert.doesNotMatch(redirects, / 404/);
});
