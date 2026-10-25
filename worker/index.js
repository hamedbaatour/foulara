import site from '../generated/site-data.json';
import {CATALOG, PAGES, PRIVATE_PAGES, LANGUAGES} from './catalog.js';
import {validate} from './validation.js';
export {CustomerRequest} from './requests.js';

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const json = (value, status = 200) => Response.json(value, {status, headers: {'Cache-Control': 'no-store'}});
const text = (value, type = 'text/plain; charset=utf-8') => new Response(value, {headers: {'Content-Type': type, 'Cache-Control': 'no-cache'}});
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');

async function boundedBody(request) {
  if (Number(request.headers.get('Content-Length')) > 16_384) throw new RangeError('size');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) {await reader.cancel(); throw new RangeError('size');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

async function api(request, env, url) {
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ok: true, notificationsConfigured: !!(env.SMTP_USER && env.SMTP_PASSWORD)});
  if (!['/api/preorders', '/api/messages'].includes(url.pathname)) return json({error: 'not_found'}, 404);
  if (request.method !== 'POST') return new Response(null, {status: 405, headers: {Allow: 'POST'}});
  if (request.headers.get('Origin') !== url.origin) return json({error: 'origin'}, 403);
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return json({error: 'content_type'}, 415);
  const key = request.headers.get('Idempotency-Key') || '';
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) return json({error: 'request_key'}, 400);
  const kind = url.pathname === '/api/preorders' ? 'preorder' : 'message';
  let payload;
  try {payload = validate(await boundedBody(request), kind);}
  catch (error) {return json({error: error instanceof RangeError ? 'request_size' : 'invalid_request'}, error instanceof RangeError ? 413 : 400);}
  try {
    // Trust only Cloudflare's own client address header; never browser-supplied forwarding headers.
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const gate = env.REQUESTS.getByName('rate:' + await hash(ip));
    if (!await gate.limit()) return json({error: 'rate_limit'}, 429);
    const fingerprint = await hash(JSON.stringify(payload));
    const store = env.REQUESTS.getByName('request:' + await hash(kind + ':' + key));
    const result = await store.record(kind, payload, fingerprint);
    return json(result.error ? {error: result.error} : {reference: result.reference, status: 'recorded'}, result.status);
  } catch {
    console.error('Request storage unavailable');
    return json({error: 'unavailable'}, 503);
  }
}

function metadata(url) {
  const path = url.pathname;
  const id = path.replace(/^\/product\//, '');
  const product = Object.hasOwn(CATALOG, id) ? CATALOG[id] : null;
  const language = LANGUAGES.includes(url.searchParams.get('lang')) ? url.searchParams.get('lang') : 'en';
  const canonical = url.origin + path + (language === 'en' ? '' : '?lang=' + language);
  const title = product ? `${product.name} · ${product.color} | FOULARA` : PAGES[path] || 'FOULARA';
  const description = product ? `${product.name} in ${product.color}. A 180 × 70 cm FOULARA scarf. Sold out; preorder requests are open with no payment today.` : 'Explore FOULARA floral satin and chiffon scarves. Sold-out favourites available by preorder request, with no payment today. English, French and Arabic.';
  let tags = `<link rel="canonical" href="${escape(canonical)}">`;
  for (const lang of [...LANGUAGES, 'x-default']) tags += `<link rel="alternate" hreflang="${lang}" href="${escape(url.origin + path + (['fr', 'ar'].includes(lang) ? '?lang=' + lang : ''))}">`;
  if (PRIVATE_PAGES.includes(path)) tags += '<meta name="robots" content="noindex,follow">';
  tags += `<meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${escape(canonical)}"><meta property="og:type" content="${product ? 'product' : 'website'}">`;
  const hero = product?.photo || (path === '/' ? 'DSC04216' : null);
  if (hero) {
    const srcset = [480, 768, 960, 1440].filter(width => site.images[`${hero}-${width}`]).map(width => `${site.images[`${hero}-${width}`]} ${width}w`).join(', ');
    tags += `<link rel="preload" as="image" fetchpriority="high" href="${site.images[`${hero}-960`]}" imagesrcset="${srcset}" imagesizes="(max-width: 760px) calc(100vw - 36px), (max-width: 1100px) 48vw, 55vw"><meta property="og:image" content="${escape(url.origin + site.images[hero])}"><meta name="twitter:card" content="summary_large_image">`;
  }
  if (product) {
    const structured = {'@context': 'https://schema.org', '@type': 'Product', name: product.name + ' · ' + product.color, description, sku: id, brand: {'@type': 'Brand', name: 'FOULARA'}, material: id.startsWith('the-vintage') ? 'Premium satin' : 'Chiffon', size: '180 × 70 cm', image: url.origin + site.images[hero], url: canonical};
    tags += '<script type="application/ld+json">' + JSON.stringify(structured).replaceAll('<', '\\u003c') + '</script>';
  }
  const fonts = language === 'ar' ? [...(id.startsWith('the-vintage') ? site.fonts.italic : []), ...site.fonts.arabic] : site.fonts.normal;
  for (const font of fonts) tags += `<link rel="preload" as="font" type="font/woff2" crossorigin href="${font}">`;
  return {title, description, language, tags};
}

async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return api(request, env, url);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, {status: 405, headers: {Allow: 'GET, HEAD'}});
  if (url.pathname.startsWith('/assets/')) return env.ASSETS.fetch(request);
  if (['/index.html', '/the-vintage-garden/', '/the-vintage-garden/index.html'].includes(url.pathname)) return Response.redirect(url.origin + '/product/the-vintage-garden-greige' + url.search, 308);
  if (url.pathname !== '/' && url.pathname.endsWith('/')) return Response.redirect(url.origin + url.pathname.slice(0, -1) + url.search, 308);
  if (url.pathname === '/robots.txt') return text(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /checkout\nDisallow: /confirmation\nDisallow: /saved\nSitemap: ${url.origin}/sitemap.xml\n`);
  if (url.pathname === '/sitemap.xml') {
    const paths = [...Object.keys(PAGES), ...Object.keys(CATALOG).map(id => '/product/' + id)];
    return text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + paths.flatMap(path => LANGUAGES.map(lang => '<url><loc>' + escape(url.origin + path + (lang === 'en' ? '' : '?lang=' + lang)) + '</loc></url>')).join('') + '</urlset>', 'application/xml; charset=utf-8');
  }
  if (url.pathname === '/llms.txt') return text('# FOULARA\n\n> Floral satin and chiffon scarves. All products are sold out. Preorder requests only, with no payment collected.\n\n- [Shop](/shop)\n- [Collections](/collections)\n- [Preorder guide](/help)\n- [Contact](/contact)\n- [Privacy](/privacy)\n');
  const known = Object.hasOwn(PAGES, url.pathname) || PRIVATE_PAGES.includes(url.pathname) || Object.hasOwn(CATALOG, url.pathname.replace(/^\/product\//, '')) && url.pathname.startsWith('/product/');
  if (url.pathname.startsWith('/.') || /\.(py|env|sqlite3|jsonc|map)$/.test(url.pathname)) return new Response('Not found', {status: 404});
  const data = metadata(url);
  const asset = await env.ASSETS.fetch(new Request(new URL('/index.html', url), {method: 'GET'}));
  if (!asset.ok) return new Response('Storefront unavailable', {status: 503});
  const html = new HTMLRewriter()
    .on('html', {element(el) {el.setAttribute('lang', data.language); el.setAttribute('dir', data.language === 'ar' ? 'rtl' : 'ltr');}})
    .on('title', {element(el) {el.setInnerContent(data.title);}})
    .on('meta[name="description"]', {element(el) {el.setAttribute('content', data.description);}})
    .on('head', {element(el) {el.append(data.tags, {html: true});}})
    .transform(asset);
  const headers = new Headers(html.headers);
  headers.set('Cache-Control', 'no-cache');
  headers.delete('Content-Length');
  return new Response(request.method === 'HEAD' ? null : html.body, {status: known ? 200 : 404, headers});
}

export default {
  async fetch(request, env) {
    try {
      const response = await route(request, env);
      const secured = new Response(response.body, response);
      secured.headers.set('X-Content-Type-Options', 'nosniff');
      secured.headers.set('Referrer-Policy', 'same-origin');
      secured.headers.set('Content-Security-Policy', CSP);
      return secured;
    } catch {
      console.error('Storefront request failed');
      return json({error: 'unavailable'}, 503);
    }
  }
};
