import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {validate, notification} from '../worker/validation.js';

const request = () => ({name: 'Test customer', email: 'customer@example.com', language: 'en', consent: true, currency: 'USD', country: 'Tunisia', items: [{id: 'the-vintage-garden-greige', quantity: 2, usd_cents: 1}]});
test('the server enforces catalogue prices and strips client-controlled prices', () => {
  const result = validate(request(), 'preorder');
  assert.equal(result.total_usd_cents, 3464);
  assert.equal(result.items[0].usd_cents, 1732);
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
  assert.match(mail.text, /\$34\.64 USD/);
  assert.match(mail.text, /No payment collected/);
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
