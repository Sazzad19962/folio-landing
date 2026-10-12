# Folio

A landing page and working converter for **Folio**, a PDF and EPUB reader and converter.
The site is plain HTML, CSS and a little JavaScript with no build step. Conversions are done by a small Node API (`server/`) that runs Calibre and LibreOffice. The site and the API ship together as one Docker image.

## Files

- `index.html`: page markup
- `styles.css`: styles; colours and fonts are CSS variables at the top (`--accent` changes the brand colour)
- `main.js`: the converter (file picking, drag and drop, format selection). It uploads the file to the conversion API, shows the queue position and progress, and offers the download when the job is done.
- `sw.js`, `manifest.webmanifest`, `icons/`: installable app (see below)
- `server/`: the conversion API (Node 20, Express)
- `Dockerfile`: one image with the API, Calibre, LibreOffice and the static site
- `render.yaml`: Render Blueprint for one-click deployment
- `.github/workflows/conversion.yml`: CI (unit tests, Docker build and a real conversion smoke test)
- `converter/index.html`: a second, **browser-only** converter page (served at `/converter/`). It converts PDF, EPUB, DOCX, Markdown, HTML and TXT on the visitor's device without the API; nothing is uploaded. PDF → Word keeps bold, italic, underline, colours, fonts, alignment, indents, lists, images, simple tables and page breaks. Libraries load from cdnjs/jsDelivr (pdf.js, JSZip, jsPDF, and pdf-lib + fontkit for Bangla PDFs).
- `converter/fonts/`: Noto Serif Bengali and Noto Sans Bengali (SIL Open Font License, see `OFL.txt`), loaded only when saving a Bangla PDF.
- `android/`: native Android app (Kotlin, Jetpack Compose) that converts PDF, EPUB, DOCX and TXT on the device. See "Android app" below.

Formats in the converter: from PDF, EPUB, MOBI, AZW3, DOCX, DOC or TXT; to EPUB, MOBI, AZW3, PDF, DOCX or DOC.

## How conversion works

1. The browser uploads the file with the target format to `POST /api/convert`.
2. The server checks the size and the file's first bytes (a renamed image or program is rejected), then puts the job in a queue. Conversions run one at a time by default.
3. **Calibre** (`ebook-convert`) converts ebooks: PDF, EPUB, MOBI, AZW3 and TXT, and writes DOCX. **LibreOffice** (`soffice`, headless) handles Word files: DOCX ↔ DOC, Word → PDF, and reading DOC before Calibre takes over.
4. The browser polls `GET /api/jobs/:id` and downloads the result.

Privacy and limits:

- Uploaded and converted files are deleted **2 hours** after upload (`RETENTION_MIN`), or straight away when the user deletes the job (`DELETE /api/jobs/:id`). Nothing is kept: there is no database, and files live only in a temporary folder.
- **DRM-free files only.** Folio never removes DRM; protected books fail to convert.
- Each conversion is stopped after 5 minutes (`CONVERT_TIMEOUT_S`), uploads are limited to 50 MB (`MAX_FILE_MB`), and each IP address can start 30 conversions per hour (`RATE_LIMIT_PER_HOUR`).

## Run locally

### With Docker (recommended)

```bash
docker build -t folio .
docker run --rm -p 8080:8080 folio
```

Then visit http://localhost:8080. The image includes Calibre and LibreOffice, so everything works.

Run the end-to-end smoke test against it (needs `curl` and `jq`):

```bash
bash server/test/smoke.sh http://localhost:8080
```

### With Node

Install Node 20+, [Calibre](https://calibre-ebook.com/download) and [LibreOffice](https://www.libreoffice.org/download/). Make sure `ebook-convert` and `soffice` are on your `PATH`, or point `CALIBRE_BIN` and `SOFFICE_BIN` at them.

```bash
cd server
npm install
npm start        # or: npm run dev (restarts on changes)
npm test         # unit tests
```

The server serves the static site from the repository root, so http://localhost:8080 shows the page with a working converter.

### Page only

To work on the page without converting, serve the folder:

```bash
python -m http.server 8000
```

Then visit http://localhost:8000. The page loads, but conversions fail because there's no API.

## Install as a mobile app

The site is a Progressive Web App, so visitors can install it from the browser. The "Folio on your phone" section (`#download`) shows an **Install app** button in Chrome, Edge and Android browsers, and Share → Add to Home Screen steps on iPhone and iPad. Native App Store and Google Play apps are listed as coming soon.

- `manifest.webmanifest`: app name, colours and icons
- `sw.js`: service worker. App shell files are cache-first, page loads are network-first with the cached page as the offline fallback, and Google Fonts are cached when available.
- `icons/`: app icons (192 and 512 PNG, a maskable 512 PNG, an SVG and a 180 px `apple-touch-icon.png`)

The service worker only registers over **https** or on **localhost**. Opening `index.html` directly from disk works, but nothing is cached and the page can't be installed.

**After changing any app shell file**, bump `VERSION` at the top of `sw.js` (for example `'v1'` → `'v2'`). Returning visitors then download the new files, and the old cache is deleted. If you add a new file the page needs offline, also add it to the `SHELL` list, and add it to the `COPY` line in the `Dockerfile` so the image serves it.

## Deploy

The converter needs a server that can run Calibre and LibreOffice, so a static host on its own (GitHub Pages, Netlify, Vercel) can show the page but **can't convert anything**.

### Render (site and API together)

`render.yaml` is a Render Blueprint that deploys the Docker image as one web service called `folio`.

1. Push this repository to GitHub (the Blueprint deploys the `main` branch).
2. In the [Render dashboard](https://dashboard.render.com), choose **New → Blueprint**.
3. Connect your GitHub account if asked, and pick this repository.
4. Render reads `render.yaml` and shows the `folio` service. Leave `ALLOWED_ORIGINS` empty (the site and the API share one origin) and click **Apply**.
5. The first build takes several minutes (Calibre and LibreOffice are large). When it finishes, the site is live at `https://folio-xxxx.onrender.com`. Render checks `/api/health` before sending traffic to a new version.

Every push to `main` redeploys automatically.

Free plan caveats:

- 512 MB of memory and a shared CPU. Conversions run one at a time (`CONCURRENCY=1`) to stay within that.
- The service **sleeps after about 15 minutes without traffic**. The next visit wakes it, and that first request can take about a minute.
- Large or image-heavy PDFs can run out of memory or hit the 5-minute timeout. Move to a paid plan (Starter or above) if that happens, and raise `CONCURRENCY` only with more memory.

**Custom domain:** in the service's **Settings → Custom Domains**, add your domain (for example `folio.example.com`), then create the DNS record Render shows you (a `CNAME` to `folio-xxxx.onrender.com`, or the `A` record for an apex domain). Render issues the HTTPS certificate automatically.

### Alternative: static site elsewhere, API on Render

You can keep the page on GitHub Pages, Netlify or Vercel and run only the API on Render:

1. Deploy the Blueprint on Render as above.
2. In `index.html`, add this tag in `<head>`, with your Render URL:

   ```html
   <meta name="folio-api" content="https://your-api.onrender.com">
   ```

   Without the tag (or with it empty), the page calls the API on its own origin.
3. In Render, set `ALLOWED_ORIGINS` on the `folio` service to the page's origin, for example `https://yourname.github.io` (comma-separated for several; no trailing slash or path).
4. Deploy the static files as usual (GitHub Pages: Settings → Pages → deploy from `main`, root folder).

## API

All responses are JSON unless noted. Errors look like `{"error": "message"}`.

| Method and path | Result |
|---|---|
| `GET /api/health` | `200 {"ok": true, "calibre": "…", "soffice": "…"}`; `503` if Calibre is missing |
| `POST /api/convert` | Multipart form with the field `to` (target format, e.g. `EPUB`) **first**, then `file`. Returns `202 {"id", "status", "position", "progress"}`. Errors: `400` bad request or same format, `413` file too large, `415` unsupported or mismatched file type, `429` rate limit or queue full, `503` converter unavailable |
| `GET /api/jobs/:id` | `{"id", "status", "progress", "error"?, "outputName", "downloadUrl"?, "expiresAt"}`; `status` is `queued`, `converting`, `done` or `error`; `404` once deleted or expired |
| `GET /api/jobs/:id/download` | The converted file (when `status` is `done`) |
| `DELETE /api/jobs/:id` | `204`; deletes the upload and the result immediately |

Example:

```bash
curl -F to=EPUB -F file=@book.pdf http://localhost:8080/api/convert
curl http://localhost:8080/api/jobs/<id>
curl -o book.epub http://localhost:8080/api/jobs/<id>/download
```

## Configuration

Environment variables for the server (defaults in brackets):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `MAX_FILE_MB` | `50` | Largest upload, in MB |
| `RETENTION_MIN` | `120` | Minutes before uploads and results are deleted |
| `CONVERT_TIMEOUT_S` | `300` | A single conversion is stopped after this many seconds |
| `CONCURRENCY` | `1` | Conversions that run at the same time |
| `MAX_QUEUE` | `20` | Jobs that can wait in the queue; more get `429` |
| `RATE_LIMIT_PER_HOUR` | `30` | Conversions each IP address can start per hour |
| `ALLOWED_ORIGINS` | empty | Comma-separated origins allowed to call the API from another site (CORS), or `*` |
| `TRUST_PROXY` | `1` | Proxy hops to trust for the client IP (Render puts one proxy in front) |
| `WORK_DIR` | OS temp dir + `/folio-jobs` | Where uploads and results are stored while they exist (`/tmp/folio-jobs` in Docker) |
| `PUBLIC_DIR` | repository root | Static site folder (`/app/public` in Docker) |
| `CALIBRE_BIN` | `ebook-convert` | Calibre's converter command |
| `SOFFICE_BIN` | `soffice` | LibreOffice command |

## CI

`.github/workflows/conversion.yml` runs on every push and pull request:

- **unit**: `npm ci` and `npm test` in `server/` on Node 20.
- **docker-smoke**: builds the image, starts it, waits for `/api/health`, then runs `server/test/smoke.sh`, which converts a sample book through TXT → EPUB → PDF → EPUB → MOBI → AZW3 → DOCX → PDF/DOC → EPUB (plus EPUB → DOC and TXT → DOCX), checks each file's magic bytes, and checks the 415, 400 and 413 errors and job deletion. Container logs are printed at the end.

## Android app

Open `android/` in Android Studio, or build from the command line (JDK 17 and the Android SDK, API 36):

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

The debug APK lands in `android/app/build/outputs/apk/debug/`. For Google Play, build the bundle with `./gradlew bundleRelease`. Release signing reads `android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`), which is git-ignored along with `*.jks` keystores; never commit them. The app ID `com.foliolabs.folio` can't be changed after the first Play upload.

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

**What the server enforces today:** the 50 MB limit and the 2-hour deletion are enforced. The "20 conversions/month" free-plan limit needs user accounts, which don't exist yet, so it **isn't enforced**; the server applies a per-IP limit of 30 conversions per hour (`RATE_LIMIT_PER_HOUR`) instead. There are no Pro accounts or payments yet either.
