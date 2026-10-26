# FOULARA storefront

## Cloudflare Workers deployment

The existing `foulara.pages.dev` Pages deployment publishes the repository root. To support it, `npm run build` also generates a root `index.html`, `assets/`, routing rules and crawler files. This static mirror is checked in so the homepage works even when the Pages project has no build command. Edit `the-vintage-garden/index.html` and rebuild instead of editing the generated root file. The root entry renders the storefront directly, without a meta-refresh redirect or an intermediate “Open FOULARA” link.

Pages serves the visual storefront and internal routes. Preorder/contact persistence and Gmail notifications require the Workers deployment described below; static hosting alone cannot execute that backend. Unknown `/api/*` requests on the static Pages mirror fail instead of showing a false order confirmation. The existing Pages project is in a different Cloudflare account from the locally connected account, so its dashboard settings have not been changed.

This repository is ready for **Cloudflare Workers with Static Assets**, including the preorder/contact API. It does not require a Python server in production. The editable frontend remains `the-vintage-garden/index.html`; the Node build extracts embedded images and fonts into `dist/assets` and creates the deployable HTML. Only `dist/` becomes public static hosting. Source files, credentials, customer storage, tests and audit reports are not public assets.

Connect `hamedbaatour/foulara` in **Workers & Pages → Create → Import a repository** and use:

| Setting | Value |
| --- | --- |
| Worker/project name | `foulara` |
| Production branch | `main` |
| Root directory | `/` (repository root) |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Node version | `22` or newer |

Cloudflare installs dependencies from `package-lock.json`. `wrangler.jsonc` declares the asset directory, Worker entry, compatibility date and SQLite-backed Durable Object binding. Wrangler also runs the build automatically before local development and deployment. Once Git integration is connected, pushes to `main` trigger deployment. This repository does not create a second deployment pipeline; GitHub Actions only validates the build.

The static media is served directly by Cloudflare. A small Worker handles page metadata, language links, crawler files, real 404s, and `/api/*`. Canonical URLs and the sitemap use the actual request origin, so preview and custom-domain URLs do not point back to localhost.

### Enable Gmail notifications

In the Worker's **Settings → Variables and Secrets**, add encrypted secrets:

- `SMTP_USER`: the Gmail sending address.
- `SMTP_PASSWORD`: that account's Gmail app password, with 2-Step Verification enabled.
- `SMTP_FROM`: optional; defaults to `SMTP_USER` and must be authorized by that account.

Notifications are fixed to **mouyahama@gmail.com**. Gmail SMTP uses TLS on port 465. No credentials belong in Git, frontend HTML, build variables, or the asset directory. For local Workers development, copy `.dev.vars.example` to `.dev.vars` instead.

Preorder/contact submissions are stored durably before a reference is returned. There is one SQLite-backed Durable Object per idempotency key, plus per-client rate-limit objects. Prices are validated against the server catalogue. Reusing a key with changed contents is rejected. Alarms retry failed email notifications with increasing delays, up to hourly. **Without Gmail secrets, requests are saved but notification emails are not sent**; queued requests are checked hourly and resume after valid secrets are deployed. SMTP acceptance is not an inbox-delivery guarantee. If a Worker is interrupted after SMTP acceptance but before recording success, a retry can produce a duplicate notification with the same message ID and reference.

The Cloudflare request store is private; no public request-list endpoint is provided. Customer data remains in Durable Object storage until the owner removes it using Cloudflare's authenticated administration tools. Local Python/SQLite requests are separate and are not migrated or uploaded by deployment.

### Develop and validate the Worker

```sh
npm ci
npm run dev
# Open http://localhost:8787
npm run check
npm run types
# With the local Worker running and without SMTP secrets:
npm run test:runtime
```

`npm run check` builds the assets, checks order validation and notifications using fixtures without sending mail, and runs Wrangler's deployment dry run. `npm run test:runtime` checks the running local Worker, including durable request storage, concurrent duplicate protection, validation, rate limits, private-file isolation, metadata and caching. It refuses to run if SMTP is configured. `npm run deploy` deploys when used with a Cloudflare-authenticated account. The checked-in lockfile pins deployment dependencies. `generated/`, `dist/` and `.wrangler/` are reproducible local outputs and are ignored by Git.

## Single-file source and optional Python server

The complete storefront lives in `the-vintage-garden/index.html`. Its photographs and fonts are embedded. All navigation stays inside the storefront. There are no external browser requests.

When served, the server extracts the embedded images and fonts into same-origin asset responses. Visitors download only the assets needed for the current view. Responsive AVIF images, smaller variable WOFF2 fonts, image preloads, deferred lower-page photos, gzip compression, persistent connections and immutable asset caching keep the initial load small. Full-resolution original photographs are loaded when the zoom viewer opens.

Public pages have crawlable URLs, page metadata, canonical and language-alternate links. The server provides valid `robots.txt`, `sitemap.xml` and `llms.txt` responses. Checkout, saved items and confirmation pages are intentionally excluded from indexing.

## Run

```sh
python3 server.py
```

Open `http://localhost:4180`. Python 3.9 or newer is sufficient; no packages need installing.

The Python server is an alternative for local development or conventional server hosting. Opening the HTML on its own supports browsing but cannot record requests or send emails. On Cloudflare, the Worker and Durable Objects replace this server and its local SQLite queue.

## Order notifications

Notifications go to **mouyahama@gmail.com**, fixed on the server. Sending credentials stay on the server and are never included in the HTML.

1. Copy `.env.example` to `.env`.
2. Enter the sending account in `SMTP_USER` and its SMTP password in `SMTP_PASSWORD`.
3. For Gmail, use an app password for a sending account with 2-Step Verification enabled. Use `smtp.gmail.com`, port `465`, and `SMTP_SECURITY=ssl`.
4. For another provider, use its SMTP host and credentials. Port `587` typically uses `SMTP_SECURITY=starttls`.
5. Restart the server and run `python3 server.py --check-email` to check that the required settings are present. This checks configuration presence, not delivery.

Without a configured sender, submissions are saved and queued, but **no notification email is sent**. Pending notifications are attempted after the server starts with valid sending settings. Failed notifications are retried with a delay. A successful SMTP response means the sending service accepted the email; it does not guarantee inbox delivery.

Each notification includes the reference, customer details, language, product variants, quantities, estimated USD subtotal, and notes. Replying addresses the customer's email. No payment or card details are collected.

## Store behavior

- Home, collection listing, four product variants, search, material filters, price sorting, saved items, preorder bag, checkout, confirmation, story, contact, preorder guide, and privacy information.
- English, French, and Arabic, with right-to-left Arabic layouts. Language and currency choices persist on the device.
- `ca.foulara.com` defaults to CAD and `us.foulara.com` defaults to USD. Explicit currency choices are remembered separately for each market domain, so an older generic USD preference cannot override Canada's default. Other domains default to USD and retain the existing currency preference behavior. CAD, EUR and TND estimates are available in the selector.
- USD and CAD use fixed regional prices, not a currency conversion. Vintage Garden is $25 USD / $35 CAD, Rosette + is $19 USD / $27 CAD, and Shadha is $15 USD / $21 CAD. Product cards, product pages, the bag and checkout all use the same regional unit prices. The server enforces both price lists, records their subtotals and includes the selected market's prices in notification emails. Existing queued requests keep the pricing recorded when they were submitted.
- All products are sold out. A preorder is a request for review, not a guaranteed stock reservation or a paid order.
- These regional prices were approved on 26 October 2026. EUR and TND remain converted estimates from the USD prices. Availability, delivery and final terms require confirmation before payment.
- Product prices are enforced by the server; amounts supplied by a browser are ignored.
- Requests are stored in `.foulara-data/preorders.sqlite3`. Keep this private directory backed up and persistent when hosting. It is not served to visitors and is ignored by Git.
- Duplicate submissions with the same request key return the existing reference. Invalid quantities, unknown variants, missing consent, and invalid emails are rejected.
- Contact enquiries are also recorded and queued to the same inbox.

Before accepting public traffic, configure the sender, confirm the commercial prices and delivery terms, and run the server behind HTTPS using persistent storage. The SQLite database contains customer contact information; do not publish or commit it.

## Validation

The storefront was checked in English, French, and Arabic at phone and desktop widths. Gallery selection, zoom, dimensions, search, filters, sorting, saved items, quantity limits, checkout, form errors, request confirmation, and internal navigation were exercised.

Server checks covered request persistence, duplicate protection, server-side pricing, input validation, notification destination, SMTP failure retries, and marking accepted notifications as sent. Notification tests used a mocked sender; no test emails were sent to the owner.

### Lighthouse

The local Python-hosted audit results are recorded in `audits/lighthouse/RESULTS.md`, including the date and scope of the latest product-page checks. These reports predate the Cloudflare hosting adaptation; they are not production Cloudflare scores. Recheck the deployed HTTPS origin after connecting hosting.

To repeat the checks while the server is running:

```sh
sh scripts/check-lighthouse.sh
```

The audit runner requires Node.js/npm and Chrome. It uses Lighthouse's standard mobile and desktop profiles, clears browser storage as Lighthouse normally does, runs checks sequentially, and fails if any category scores below 100. It does not submit preorder or contact forms.

These are local lab measurements. Audit the deployed HTTPS origin again because hosting, network and browser conditions can change results. Private checkout/account-state pages are not SEO targets.
