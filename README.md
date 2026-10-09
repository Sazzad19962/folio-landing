# Folio — landing page

A static landing page for **Folio**, a PDF and EPUB reader and converter.
Plain HTML, CSS and a little JavaScript, with no build step.

## Run locally

Open `index.html` in a browser, or serve the folder:

```bash
python -m http.server 8000
```

Then visit http://localhost:8000.

## Files

- `index.html`: page markup
- `styles.css`: styles; colours and fonts are CSS variables at the top (`--accent` changes the brand colour)
- `main.js`: converter demo (file picking, drag and drop, format selection). It does **not** upload or convert anything yet.

## Pricing and policy copy

These figures were picked from competitor research (October 2026), not from a real business plan. Confirm each one before launch.

| Item on the page | Value | Market reference |
|---|---|---|
| Pro price | $7.99/month or $59.99/year | iLovePDF Premium about $5–9/mo, Readwise Reader $9.99–12.99/mo, Smallpdf Pro about $15/mo |
| Free plan | 20 conversions/month, 50 MB per file | Smallpdf about 2 tasks/day; Zamzar free limit 50 MB |
| Pro trial | 14 days | Readwise Reader offers 30 days; 7–14 days is common |
| File deletion | 2 hours | Smallpdf 1 hour, iLovePDF 2 hours, FreeConvert 8 hours |
| DRM | DRM-free files only, DRM is never removed | Standard for legitimate converters |
| Company name | Folio Labs | Placeholder; replace with the legal entity |

The deletion window, encryption and "never shared or sold" statements in the FAQ are promises to users. Make sure the product and the privacy policy actually do these things.

## Deploy

Works as-is on GitHub Pages (Settings → Pages → deploy from `main`, root folder), Netlify or Vercel.
