import {readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// The editable storefront remains a single file. Deployment extracts cacheable media.
let markup = await readFile(new URL('../the-vintage-garden/index.html', import.meta.url), 'utf8');
const root = new URL('../dist/', import.meta.url);
await rm(root, {recursive: true, force: true});
await mkdir(new URL('assets/', root), {recursive: true});
await mkdir(new URL('../generated/', import.meta.url), {recursive: true});
const pending = [];
function asset(name, encoded, extension) {
  const bytes = Buffer.from(encoded, 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const file = `${name}.${digest}.${extension}`;
  pending.push(writeFile(new URL(`assets/${file}`, root), bytes));
  return `/assets/${file}`;
}
const pattern = /(<script type="application\/json" id="product-assets">)([\s\S]*?)(<\/script>)/;
const match = markup.match(pattern);
if (!match) throw new Error('Missing product assets');
const images = JSON.parse(match[2]);
for (const [name, data] of Object.entries(images)) {
  const image = data.match(/^data:image\/(webp|avif);base64,(.+)$/);
  if (image) images[name] = asset(name, image[2], image[1]);
}
markup = markup.replace(pattern, () => match[1] + JSON.stringify(images) + match[3]);
let fontIndex = 0;
markup = markup.replace(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g, (_, data) => asset(`font-${++fontIndex}`, data, 'woff2'));
const fonts = {normal: [], arabic: [], italic: []};
for (const face of markup.matchAll(/@font-face\s*\{[^}]*\}/g)) {
  const url = face[0].match(/url\((\/assets\/[^)]+)\)/)?.[1];
  if (!url) continue;
  if (/Manrope|Cormorant Garamond/.test(face[0])) {
    fonts.normal.push(url);
    if (face[0].includes('Cormorant Garamond')) {
      if (face[0].includes('font-style: normal')) fonts.arabic.push(url);
      if (face[0].includes('font-style: italic')) fonts.italic.push(url);
    }
  } else if (/Noto Sans Arabic/.test(face[0]) && /U\+0600-|U\+0000-00FF/.test(face[0])) fonts.arabic.push(url);
}
markup = markup.replace('</head>', '<script>window.__FOULARA_SERVER__=true;</script></head>');
if (/data:(image\/(webp|avif)|font\/woff2);base64,/.test(markup)) throw new Error('Unextracted asset');
await Promise.all(pending);
await writeFile(new URL('index.html', root), markup);
await writeFile(new URL('_headers', root), `/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n`);
await writeFile(new URL('../generated/site-data.json', import.meta.url), JSON.stringify({images, fonts}));
console.log(`Built ${pending.length} cacheable assets and ${(Buffer.byteLength(markup) / 1024).toFixed(1)} KB storefront HTML.`);
