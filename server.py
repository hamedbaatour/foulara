#!/usr/bin/env python3
"""FOULARA storefront and persistent preorder notification queue.

Run: python3 server.py
Copy .env.example to .env and configure a sending account to enable emails.
The browser never receives SMTP credentials. Only the HTML storefront is served.
"""

import argparse
import base64
import gzip
import hashlib
import html
import json
import logging
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import threading
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
for line in (ROOT / '.env').read_text().splitlines() if (ROOT / '.env').exists() else []:
    if line.strip() and not line.lstrip().startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

RECIPIENT = 'mouyahama@gmail.com'
DATA = Path(os.getenv('FOULARA_DATA_DIR', str(ROOT / '.foulara-data')))
CATALOG = {
    'the-vintage-garden-greige': {'name': 'The Vintage Garden', 'color': 'Greige', 'usd_cents': 2500, 'cad_cents': 3500},
    'the-vintage-garden-royal-blue': {'name': 'The Vintage Garden', 'color': 'Royal Blue', 'usd_cents': 2500, 'cad_cents': 3500},
    'rosette-yellow': {'name': 'Rosette +', 'color': 'Yellow', 'usd_cents': 1900, 'cad_cents': 2700},
    'shadha-beige': {'name': 'Shadha', 'color': 'Beige', 'usd_cents': 1500, 'cad_cents': 2100},
}
WAKE = threading.Event()
STOP = threading.Event()
RATE_LOCK = threading.Lock()
REQUESTS = {}
RESOURCE_LOCK = threading.Lock()
STOREFRONT = {'mtime': None, 'markup': '', 'assets': {}}


def storefront_resources():
    """Keep one portable source file; serve its embedded assets on demand."""
    source = ROOT / 'the-vintage-garden' / 'index.html'
    modified = source.stat().st_mtime_ns
    with RESOURCE_LOCK:
        if STOREFRONT['mtime'] == modified:
            return STOREFRONT
        markup = source.read_text()
        resources = {}

        def resource(name, raw, content_type):
            digest = hashlib.sha256(raw).hexdigest()[:16]
            extension = 'woff2' if content_type == 'font/woff2' else content_type.split('/')[1]
            path = f'/assets/{name}.{digest}.{extension}'
            resources[path] = (raw, content_type, digest)
            return path

        image_match = re.search(r'(<script type="application/json" id="product-assets">)(.*?)(</script>)', markup, re.S)
        images = json.loads(image_match.group(2))
        for name, value in images.items():
            if value.startswith(('data:image/webp;base64,', 'data:image/avif;base64,')):
                content_type = value.split(';', 1)[0].removeprefix('data:')
                images[name] = resource(name, base64.b64decode(value.split(',', 1)[1]), content_type)
        image_json = json.dumps(images, separators=(',', ':'))
        markup = markup[:image_match.start(2)] + image_json + markup[image_match.end(2):]
        font_index = 0

        def extract_font(match):
            nonlocal font_index
            font_index += 1
            return resource(f'font-{font_index}', base64.b64decode(match.group(1)), 'font/woff2')

        markup = re.sub(r'data:font/woff2;base64,([A-Za-z0-9+/=]+)', extract_font, markup)
        markup = markup.replace('</head>', '<script>window.__FOULARA_SERVER__=true;</script><!-- PAGE_METADATA --></head>')
        # The browser receives URL references, never the complete embedded photo library.
        preload_fonts = []
        arabic_fonts = []
        italic_fonts = []
        for face in re.findall(r'@font-face\s*\{.*?\}', markup, re.S):
            if 'Manrope' in face or 'Cormorant Garamond' in face:
                match = re.search(r'url\((/assets/[^)]+)\)', face)
                if match:
                    preload_fonts.append(match.group(1))
                    if 'Cormorant Garamond' in face and 'font-style: normal' in face:
                        arabic_fonts.append(match.group(1))
                    elif 'Cormorant Garamond' in face and 'font-style: italic' in face:
                        italic_fonts.append(match.group(1))
            elif 'Noto Sans Arabic' in face and ('U+0600-' in face or 'U+0000-00FF' in face):
                match = re.search(r'url\((/assets/[^)]+)\)', face)
                if match:
                    arabic_fonts.append(match.group(1))
        STOREFRONT.update(mtime=modified, markup=markup, assets=resources, images=images, preload_fonts=preload_fonts, arabic_fonts=arabic_fonts, italic_fonts=italic_fonts)
        return STOREFRONT


def db():
    connection = sqlite3.connect(DATA / 'preorders.sqlite3', timeout=15)
    connection.row_factory = sqlite3.Row
    return connection


def initialize():
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    with db() as connection:
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('''CREATE TABLE IF NOT EXISTS requests (
            reference TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL,
            fingerprint TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
            created_at TEXT NOT NULL, notified_at TEXT,
            attempts INTEGER NOT NULL DEFAULT 0, retry_at REAL NOT NULL DEFAULT 0,
            last_error TEXT)''')
    os.chmod(DATA / 'preorders.sqlite3', 0o600)


def email_ready():
    return bool(os.getenv('SMTP_HOST') and os.getenv('SMTP_USER') and os.getenv('SMTP_PASSWORD'))


def send_notification(record):
    payload = json.loads(record['payload'])
    message = EmailMessage()
    sender = os.getenv('SMTP_FROM') or os.environ['SMTP_USER']
    message['From'] = f'FOULARA <{sender}>'
    message['To'] = RECIPIENT
    message['Reply-To'] = payload['email']
    message['Message-ID'] = f"<{record['reference']}@foulara.preorder>"
    kind = 'New preorder' if record['kind'] == 'preorder' else 'Customer enquiry'
    message['Subject'] = f"FOULARA | {kind} | {record['reference']}"
    lines = [kind, f"Reference: {record['reference']}", f"Received (UTC): {record['created_at']}", '',
             f"Name: {payload['name']}", f"Email: {payload['email']}",
             f"Language: {payload['language']}"]
    if record['kind'] == 'preorder':
        lines += [f"Country: {payload['country']}", f"Phone: {payload.get('phone') or 'Not supplied'}", '', 'Items:']
        canadian = payload['currency'] == 'CAD'
        price_currency = 'CAD' if canadian else 'USD'
        for item in payload['items']:
            cents = item.get('cad_cents', round(item['usd_cents'] * 1.3993)) if canadian else item['usd_cents']
            lines.append(f"  {item['quantity']} × {item['name']} / {item['color']} / 180 × 70 cm / ${cents / 100:.2f} {price_currency} each")
        total = payload.get('total_cad_cents', round(payload['total_usd_cents'] * 1.3993)) if canadian else payload['total_usd_cents']
        lines += ['', f"Estimated product subtotal: ${total / 100:.2f} {price_currency}",
                  f"Customer display currency: {payload['currency']}",
                  'Status: SOLD OUT / PREORDER REQUEST',
                  'No payment collected. Availability, delivery, charges and final terms require confirmation.',
                  '', f"Notes: {payload.get('notes') or 'None'}"]
    else:
        lines += ['', f"Subject: {payload['subject']}", '', payload['message']]
    message.set_content('\n'.join(lines))
    host, port = os.environ['SMTP_HOST'], int(os.getenv('SMTP_PORT', '465'))
    context = ssl.create_default_context()
    if os.getenv('SMTP_SECURITY', 'ssl').lower() == 'starttls':
        with smtplib.SMTP(host, port, timeout=20) as smtp:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
            smtp.login(os.environ['SMTP_USER'], os.environ['SMTP_PASSWORD'])
            refused = smtp.send_message(message)
    else:
        with smtplib.SMTP_SSL(host, port, timeout=20, context=context) as smtp:
            smtp.login(os.environ['SMTP_USER'], os.environ['SMTP_PASSWORD'])
            refused = smtp.send_message(message)
    if refused:
        raise smtplib.SMTPRecipientsRefused(refused)


def notification_worker():
    while not STOP.is_set():
        if email_ready():
            with db() as connection:
                records = connection.execute('SELECT * FROM requests WHERE notified_at IS NULL AND retry_at <= ? ORDER BY created_at LIMIT 10', (time.time(),)).fetchall()
            for record in records:
                if STOP.is_set():
                    break
                try:
                    send_notification(record)
                    with db() as connection:
                        connection.execute('UPDATE requests SET notified_at=?, last_error=NULL WHERE reference=?', (datetime.now(timezone.utc).isoformat(), record['reference']))
                    logging.info('Email accepted for %s', record['reference'])
                except Exception as exc:
                    # Persist the retry without writing customer content or credentials to logs.
                    delay = min(3600, 60 * 2 ** min(record['attempts'], 6))
                    with db() as connection:
                        connection.execute('UPDATE requests SET attempts=attempts+1, retry_at=?, last_error=? WHERE reference=?', (time.time() + delay, type(exc).__name__, record['reference']))
                    logging.warning('Notification queued for retry: %s (%s)', record['reference'], type(exc).__name__)
        WAKE.wait(30)
        WAKE.clear()


def text(data, key, limit, required=True):
    value = data.get(key, '')
    if not isinstance(value, str):
        raise ValueError(key)
    value = value.strip()
    if len(value) > limit or (required and not value) or '\x00' in value:
        raise ValueError(key)
    return value


def validate(data, kind):
    if not isinstance(data, dict) or data.get('website'):
        raise ValueError('request')
    result = {'name': text(data, 'name', 120), 'email': text(data, 'email', 254),
              'language': data.get('language', 'en')}
    if not re.fullmatch(r"[^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+", result['email']):
        raise ValueError('email')
    if result['language'] not in ('en', 'fr', 'ar'):
        raise ValueError('language')
    if kind == 'message':
        result.update(subject=text(data, 'subject', 160), message=text(data, 'message', 4000))
        return result
    if data.get('consent') is not True or data.get('currency') not in ('USD', 'CAD', 'EUR', 'TND'):
        raise ValueError('consent')
    result.update(country=text(data, 'country', 100), phone=text(data, 'phone', 50, False),
                  notes=text(data, 'notes', 2000, False), currency=data['currency'])
    items = data.get('items')
    if not isinstance(items, list) or not 1 <= len(items) <= len(CATALOG):
        raise ValueError('items')
    result['items'], seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError('items')
        product_id, quantity = item.get('id'), item.get('quantity')
        if not isinstance(product_id, str) or product_id not in CATALOG or product_id in seen or type(quantity) is not int or not 1 <= quantity <= 9:
            raise ValueError('items')
        seen.add(product_id)
        result['items'].append({'id': product_id, 'quantity': quantity, **CATALOG[product_id]})
    result['total_usd_cents'] = sum(item['usd_cents'] * item['quantity'] for item in result['items'])
    result['total_cad_cents'] = sum(item['cad_cents'] * item['quantity'] for item in result['items'])
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = 'Foulara'
    protocol_version = 'HTTP/1.1'

    def log_message(self, format, *args):
        logging.info('%s %s', self.command, urlsplit(self.path).path)

    def send_headers(self, status, content_type='application/json; charset=utf-8', length=None, cache='no-store', etag=None, encoding=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        if etag:
            self.send_header('ETag', '"' + etag + '"')
        if encoding:
            self.send_header('Content-Encoding', encoding)
            self.send_header('Vary', 'Accept-Encoding')
        if length is not None:
            self.send_header('Content-Length', str(length))
        self.end_headers()

    def respond(self, status, data):
        encoded = json.dumps(data, ensure_ascii=False).encode()
        self.send_headers(status, length=len(encoded))
        if self.command != 'HEAD':
            self.wfile.write(encoded)

    def do_GET(self):
        path = urlsplit(self.path).path
        origin = os.getenv('PUBLIC_ORIGIN', 'http://' + self.headers.get('Host', 'localhost:4180')).rstrip('/')
        if path == '/api/health':
            return self.respond(200, {'ok': True})
        if path.startswith('/api/') or path.startswith('/.') or path.endswith(('.py', '.sqlite3', '.env')):
            return self.respond(404, {'error': 'not_found'})
        if path == '/robots.txt':
            return self.send_text('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /checkout\nDisallow: /confirmation\nDisallow: /saved\nSitemap: ' + origin + '/sitemap.xml\n', 'text/plain; charset=utf-8')
        public_pages = {'/': 'FOULARA | Floral Satin & Chiffon Scarves', '/shop': 'Shop Satin & Chiffon Scarves | FOULARA', '/collections': 'Scarf Collections | FOULARA', '/story': 'Our Story | FOULARA', '/contact': 'Contact FOULARA', '/help': 'Preorder Guide | FOULARA', '/privacy': 'Privacy | FOULARA'}
        if path == '/sitemap.xml':
            paths = list(public_pages) + ['/product/' + key for key in CATALOG]
            urls = [origin + page + ('?lang=' + language if language != 'en' else '') for page in paths for language in ('en', 'fr', 'ar')]
            xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + ''.join('<url><loc>' + html.escape(url) + '</loc></url>' for url in urls) + '</urlset>'
            return self.send_text(xml, 'application/xml; charset=utf-8')
        if path == '/llms.txt':
            return self.send_text('# FOULARA\n\n> Floral satin and chiffon scarves. All products are sold out and available for preorder requests only. No payment is collected.\n\n## Store\n- [Shop scarves](/shop): Browse the current catalogue.\n- [Collections](/collections): Vintage Garden, Rosette + and Shadha.\n- [Preorder guide](/help): Availability, pricing and delivery require confirmation before payment.\n- [Contact](/contact): Ask about a scarf or preorder.\n- [Privacy](/privacy): How customer request details are handled.\n', 'text/plain; charset=utf-8')
        prepared = storefront_resources()
        if path.startswith('/assets/'):
            asset = prepared['assets'].get(path)
            if not asset:
                return self.respond(404, {'error': 'not_found'})
            body, content_type, digest = asset
            cache = 'public, max-age=31536000, immutable'
            if self.headers.get('If-None-Match') == '"' + digest + '"':
                self.send_headers(304, content_type, cache=cache, etag=digest)
                return
            self.send_headers(200, content_type, len(body), cache=cache, etag=digest)
            if self.command != 'HEAD':
                self.wfile.write(body)
            return
        markup = prepared['markup']
        product_id = path.removeprefix('/product/').strip('/')
        product = CATALOG.get(product_id)
        title = f"{product['name']} · {product['color']} | FOULARA" if product else public_pages.get(path, 'FOULARA')
        description = f"{product['name']} in {product['color']}. A 180 × 70 cm FOULARA scarf. Sold out; preorder requests are open with no payment today." if product else 'Explore FOULARA floral satin and chiffon scarves. Sold-out favourites available by preorder request, with no payment today. English, French and Arabic.'
        markup = re.sub(r'<title>.*?</title>', lambda _: '<title>' + html.escape(title) + '</title>', markup, count=1)
        markup = re.sub(r'<meta name="description" content="[^"]*">', lambda _: '<meta name="description" content="' + html.escape(description, quote=True) + '">', markup, count=1)
        requested_language = parse_qs(urlsplit(self.path).query).get('lang', ['en'])[0]
        language = requested_language if requested_language in ('en', 'fr', 'ar') else 'en'
        markup = markup.replace('<html lang="en" dir="ltr">', f'<html lang="{language}" dir="{"rtl" if language == "ar" else "ltr"}">', 1)
        canonical = origin + path + ('?lang=' + language if language != 'en' else '')
        metadata = '<link rel="canonical" href="' + html.escape(canonical, quote=True) + '">'
        for alternate in ('en', 'fr', 'ar', 'x-default'):
            url = origin + path + ('?lang=' + alternate if alternate in ('fr', 'ar') else '')
            metadata += '<link rel="alternate" hreflang="' + alternate + '" href="' + html.escape(url, quote=True) + '">'
        if path in ('/checkout', '/confirmation', '/saved'):
            metadata += '<meta name="robots" content="noindex,follow">'
        metadata += '<meta property="og:title" content="' + html.escape(title, quote=True) + '"><meta property="og:description" content="' + html.escape(description, quote=True) + '"><meta property="og:url" content="' + html.escape(canonical, quote=True) + '"><meta property="og:type" content="' + ('product' if product else 'website') + '">'
        photo_files = {'the-vintage-garden-greige': 'DSC04216', 'the-vintage-garden-royal-blue': 'DSC06047', 'rosette-yellow': 'DSC05949', 'shadha-beige': 'DSC04156'}
        hero = photo_files.get(product_id) if product else 'DSC04216' if path in ('/', '/index.html') else None
        if hero:
            images = prepared['images']
            srcset = ', '.join(images[f'{hero}-{width}'] + f' {width}w' for width in (480, 768, 960, 1440) if f'{hero}-{width}' in images)
            metadata += '<link rel="preload" as="image" fetchpriority="high" href="' + images[f'{hero}-960'] + '" imagesrcset="' + srcset + '" imagesizes="(max-width: 760px) calc(100vw - 36px), (max-width: 1100px) 48vw, 55vw">'
            metadata += '<meta property="og:image" content="' + html.escape(origin + images[hero], quote=True) + '"><meta name="twitter:card" content="summary_large_image">'
        if product:
            structured = {'@context': 'https://schema.org', '@type': 'Product', 'name': product['name'] + ' · ' + product['color'], 'description': description, 'sku': product_id, 'brand': {'@type': 'Brand', 'name': 'FOULARA'}, 'material': 'Premium satin' if product_id.startswith('the-vintage') else 'Chiffon', 'size': '180 × 70 cm', 'image': origin + prepared['images'][hero], 'url': canonical}
            metadata += '<script type="application/ld+json">' + json.dumps(structured).replace('<', '\\u003c') + '</script>'
        fonts = list(prepared['arabic_fonts'] if language == 'ar' else prepared['preload_fonts'])
        if language == 'ar' and product_id.startswith('the-vintage'):
            fonts = prepared['italic_fonts'] + fonts
        for font in fonts:
            metadata += '<link rel="preload" as="font" type="font/woff2" crossorigin href="' + font + '">'
        markup = markup.replace('<!-- PAGE_METADATA -->', metadata)
        known = path in public_pages or product or path in ('/checkout', '/confirmation', '/saved', '/index.html', '/the-vintage-garden/', '/the-vintage-garden/index.html')
        return self.send_text(markup, 'text/html; charset=utf-8', status=200 if known else 404)

    def send_text(self, text, content_type, status=200):
        body = text.encode()
        encoding = None
        if len(body) > 1024 and 'gzip' in self.headers.get('Accept-Encoding', ''):
            body = gzip.compress(body, compresslevel=6)
            encoding = 'gzip'
        self.send_headers(status, content_type, len(body), cache='no-cache', encoding=encoding)
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        if path not in ('/api/preorders', '/api/messages'):
            return self.respond(404, {'error': 'not_found'})
        origin = self.headers.get('Origin')
        if not origin or urlsplit(origin).netloc != self.headers.get('Host') or urlsplit(origin).scheme not in ('http', 'https'):
            return self.respond(403, {'error': 'origin'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.respond(415, {'error': 'content_type'})
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 16384:
                return self.respond(413, {'error': 'request_size'})
            kind = 'preorder' if path == '/api/preorders' else 'message'
            payload = validate(json.loads(self.rfile.read(length)), kind)
            request_key = self.headers.get('Idempotency-Key', '')
            if not re.fullmatch(r'[A-Za-z0-9_-]{16,100}', request_key):
                return self.respond(400, {'error': 'request_key'})
            serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
            fingerprint = hashlib.sha256(serialized.encode()).hexdigest()
            with db() as connection:
                connection.execute('BEGIN IMMEDIATE')
                existing = connection.execute('SELECT reference,fingerprint FROM requests WHERE request_key=?', (request_key,)).fetchone()
                if existing:
                    if existing['fingerprint'] != fingerprint:
                        return self.respond(409, {'error': 'request_changed'})
                    return self.respond(200, {'reference': existing['reference'], 'status': 'recorded'})
                now = time.time()
                with RATE_LOCK:
                    timestamps = [t for t in REQUESTS.get(self.client_address[0], []) if t > now - 600]
                    if len(timestamps) >= 10:
                        return self.respond(429, {'error': 'rate_limit'})
                    REQUESTS[self.client_address[0]] = timestamps + [now]
                    for ip in list(REQUESTS):
                        if not REQUESTS[ip] or REQUESTS[ip][-1] < now - 600:
                            del REQUESTS[ip]
                reference = ('FL' if kind == 'preorder' else 'FM') + '-' + datetime.now(timezone.utc).strftime('%y%m%d') + '-' + secrets.token_hex(4).upper()
                connection.execute('INSERT INTO requests(reference,request_key,fingerprint,kind,payload,created_at) VALUES(?,?,?,?,?,?)', (reference, request_key, fingerprint, kind, serialized, datetime.now(timezone.utc).isoformat()))
            WAKE.set()
            return self.respond(201, {'reference': reference, 'status': 'recorded'})
        except (ValueError, TypeError, UnicodeDecodeError):
            return self.respond(400, {'error': 'invalid_request'})
        except sqlite3.Error:
            logging.exception('Could not persist a request')
            return self.respond(503, {'error': 'unavailable'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=int(os.getenv('PORT', '4180')))
    parser.add_argument('--host', default=os.getenv('HOST', '127.0.0.1'))
    parser.add_argument('--check-email', action='store_true')
    args = parser.parse_args()
    if args.check_email:
        print('Sending account configured.' if email_ready() else 'Email pending setup: configure SMTP_HOST, SMTP_USER and SMTP_PASSWORD in .env.')
        return
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    initialize()
    storefront_resources()
    worker = threading.Thread(target=notification_worker, daemon=True)
    worker.start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'FOULARA: http://localhost:{args.port}', flush=True)
    print('Order emails: configured.' if email_ready() else 'Order emails: pending sender setup; requests will be saved and queued.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        STOP.set()
        WAKE.set()
        server.server_close()


if __name__ == '__main__':
    main()
