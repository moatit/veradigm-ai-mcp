# Deploying drawbridge.moatit.com

**Status: not deployed.** Nothing goes public without Ali's approval. No DNS change has been made: the `moatit.com` DNS change is Ali's / Martyn's to make.

The site is fully static (`dist/`, about 1.5 MB including images and fonts). It needs only static hosting with TLS. No server code, no database, no cookies.

## 1. Build

```
npm run build            # → dist/  (Node 20+; no npm dependencies needed to build)
DRAWBRIDGE_PREVIEW=1 npm run build   # staging build: robots.txt disallows everything
```

`dist/_headers` carries the security headers (CSP with the inline stylesheet's SHA-256 hash, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy) and long-lived caching for `/assets/*`. The hash changes whenever `src/assets/css/site.css` changes, so always deploy `dist/` as a whole.

## 2. Hosting options (pick one)

| Option | Fit | Notes |
|---|---|---|
| **Cloudflare Pages** (recommended) | MOATiT already uses Cloudflare (tunnels for moatit.dev) | Reads `_headers` natively; free TLS; HTTP/3; Brotli. Upload `dist/` or connect the repo once it is pushed (with approval). |
| AWS S3 + CloudFront | MOATiT's AWS account | Private S3 bucket + CloudFront OAC; ACM certificate in us-east-1; translate `_headers` into a CloudFront response-headers policy; a CloudFront Function to map `/path/` → `/path/index.html`. |
| Netlify | Simple | Reads `_headers` natively. |
| MOATiT's own nginx | Data center | Serve `dist/`; copy the headers from `_headers` into the server block; `try_files $uri $uri/index.html =404; error_page 404 /404.html;` |

**Do not** host it on the Drawbridge application servers or anything under `veradigmai.com`, and never use ports 8095/8096 (the Drawbridge stack).

## 3. TLS and DNS (Ali / Martyn)

1. Create the hosting project and add the custom domain `drawbridge.moatit.com`.
2. In moatit.com DNS add the record the host asks for, typically `CNAME drawbridge → <project>.pages.dev` (Cloudflare Pages) or the CloudFront distribution name. If moatit.com's DNS is on Cloudflare, proxy it (orange cloud).
3. Wait for the certificate; enforce HTTPS; set minimum TLS 1.2.
4. Verify: `https://drawbridge.moatit.com/` loads; `http://` redirects; `curl -I` shows the headers from `_headers`; `/robots.txt` and `/sitemap.xml` are reachable; `/.well-known/security.txt` loads.
5. Submit the sitemap in Google Search Console and Bing Webmaster Tools (verify via DNS TXT record).

## 4. The demo form

The form posts JSON to `SITE.demoEndpoint` in `src/content/site.mjs` (placeholder: `/api/demo-request`, which only the local preview server answers). Before launch choose one:

- **Calendar link** (fastest): change `CTA.primary.href` to the scheduling page and keep the form as a fallback; or
- **Form → CRM / email**: a small serverless function (Cloudflare Worker / Pages Function or AWS Lambda) that validates the fields, drops the honeypot, rate-limits, and forwards to the CRM or to questions@moatit.com over authenticated SMTP. Store no more than the fields; no PHI. Update `connect-src` in the CSP if the endpoint is on another origin.

If the request fails, the page already tells visitors to email questions@moatit.com or call (208) 900-6628 / (855) 550-6628.

## 5. Pre-launch checklist

- [ ] Ali approves the site and copy.
- [ ] CONFIRM / GATE items in `docs/CLAIMS_REGISTER.md` resolved.
- [ ] Counsel approves `/legal/*` and the "Draft for legal review" banners are removed (`src/content/pages/legal.mjs`).
- [ ] Musab confirms all Veradigm® wording.
- [ ] Real form endpoint or calendar link.
- [ ] Production build (not preview) deployed; headers verified; Lighthouse ≥ 95 in all four categories on the live URL.
- [ ] Monitoring: an uptime check on `/` and the form endpoint.
