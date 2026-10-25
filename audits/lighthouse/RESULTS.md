# Lighthouse results

**Latest verification after purchase-layout refinements: the product page scored 100/100 in every category on mobile, desktop, French mobile and Arabic mobile.**

The other 12 saved reports are from the preceding full-site audit, where all 16 checks scored 100/100. Per-report source checksums and timestamps are in `summary.json`.

Lighthouse 13.5.0, standard mobile and desktop profiles, local origin `http://localhost:4180`. Audits ran sequentially with normal Lighthouse storage resets. No scoring categories or audits were disabled. The saved check script completed successfully.

| Page / profile | Performance | Accessibility | Best practices | SEO | Agentic browsing |
|---|---:|---:|---:|---:|---:|
| [home-mobile](home-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [home-desktop](home-desktop.html) | 100 | 100 | 100 | 100 | 100 |
| [product-mobile](product-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [product-desktop](product-desktop.html) | 100 | 100 | 100 | 100 | 100 |
| [shop-mobile](shop-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [shop-desktop](shop-desktop.html) | 100 | 100 | 100 | 100 | 100 |
| [collections-mobile](collections-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [story-mobile](story-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [contact-mobile](contact-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [help-mobile](help-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [privacy-mobile](privacy-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [royal-blue-mobile](royal-blue-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [rosette-mobile](rosette-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [shadha-mobile](shadha-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [french-product-mobile](french-product-mobile.html) | 100 | 100 | 100 | 100 | 100 |
| [arabic-product-mobile](arabic-product-mobile.html) | 100 | 100 | 100 | 100 | 100 |

Zero total blocking time across all checks: True. Zero layout shift across all checks: True.

Mobile largest-contentful paint: 1.4 to 1.8 seconds.

Individual HTML and JSON reports are beside this file. `summary.json` contains URLs, timestamps, metrics, tool version and source checksums.

The initial product mobile baseline scored 55 for performance and 92 for SEO, with approximately 33.6-second first and largest contentful paints.

Changes: responsive AVIF images, original-resolution zoom on demand, subset variable WOFF2 fonts, critical image/font preloads, deferred offscreen images, gzip compression, persistent HTTP connections, immutable asset caching, crawlable routes, valid crawler files, corrected heading order and locale-aware metadata. Gallery transitions keep the previous photograph visible until its replacement is decoded.

These are local lab results. Audit the deployed HTTPS origin again; hardware, network and hosting conditions can change results. Saved items, checkout and order confirmation intentionally remain excluded from indexing and SEO score claims.

Repeat all checks: `sh scripts/check-lighthouse.sh`.
