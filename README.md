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

## Placeholders to fill in

Search for `[` in `index.html`: `[YOUR PRICE]`, `[N]`, `[RETENTION PERIOD]`, `[YOUR DRM POLICY]`, `[YOUR STORAGE AND PRIVACY DETAILS]`, `[COMPANY NAME]`.

## Deploy

Works as-is on GitHub Pages (Settings → Pages → deploy from `main`, root folder), Netlify or Vercel.
