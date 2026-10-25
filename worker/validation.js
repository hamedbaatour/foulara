import {CATALOG, LANGUAGES} from './catalog.js';

function text(data, key, limit, required = true) {
  if (data[key] !== undefined && typeof data[key] !== 'string') throw new Error(key);
  const value = (data[key] || '').trim();
  if ((required && !value) || value.length > limit || value.includes('\0') || key === 'email' && /[\r\n]/.test(value)) throw new Error(key);
  return value;
}
export function validate(data, kind) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.website) throw new Error('request');
  const result = {name: text(data, 'name', 120), email: text(data, 'email', 254), language: data.language || 'en'};
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(result.email) || !LANGUAGES.includes(result.language)) throw new Error('email_or_language');
  if (kind === 'message') return {...result, subject: text(data, 'subject', 160), message: text(data, 'message', 4000)};
  if (data.consent !== true || !['USD', 'EUR', 'TND'].includes(data.currency)) throw new Error('consent_or_currency');
  Object.assign(result, {country: text(data, 'country', 100), phone: text(data, 'phone', 50, false), notes: text(data, 'notes', 2000, false), currency: data.currency});
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 4) throw new Error('items');
  const seen = new Set();
  result.items = data.items.map(item => {
    if (!item || !Object.hasOwn(CATALOG, item.id) || seen.has(item.id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 9) throw new Error('items');
    seen.add(item.id);
    const {photo, ...product} = CATALOG[item.id];
    return {id: item.id, quantity: item.quantity, ...product};
  });
  result.total_usd_cents = result.items.reduce((sum, item) => sum + item.usd_cents * item.quantity, 0);
  return result;
}

export function notification(record, sender) {
  const p = record.payload;
  const kind = record.kind === 'preorder' ? 'New preorder' : 'Customer enquiry';
  const lines = [kind, `Reference: ${record.reference}`, `Received (UTC): ${record.created_at}`, '', `Name: ${p.name}`, `Email: ${p.email}`, `Language: ${p.language}`];
  if (record.kind === 'preorder') {
    lines.push(`Country: ${p.country}`, `Phone: ${p.phone || 'Not supplied'}`, '', 'Items:');
    for (const item of p.items) lines.push(`${item.quantity} × ${item.name} / ${item.color} / 180 × 70 cm / $${(item.usd_cents / 100).toFixed(2)} USD each`);
    lines.push('', `Estimated subtotal: $${(p.total_usd_cents / 100).toFixed(2)} USD`, `Display currency: ${p.currency}`, 'SOLD OUT / PREORDER REQUEST. No payment collected.', 'Availability, delivery charges and final terms require confirmation before payment.', '', `Notes: ${p.notes || 'None'}`);
  } else lines.push('', `Subject: ${p.subject}`, '', p.message);
  return {from: {name: 'FOULARA', address: sender}, to: 'mouyahama@gmail.com', replyTo: p.email, subject: `FOULARA | ${kind} | ${record.reference}`, messageId: `<${record.reference}@foulara.preorder>`, text: lines.join('\n')};
}
