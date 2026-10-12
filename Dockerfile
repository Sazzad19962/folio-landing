# Folio: static site + conversion API in one image.
# Build context is the repository root:  docker build -t folio .
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Calibre handles ebooks (EPUB, MOBI, AZW3, PDF, DOCX output); LibreOffice Writer
# (headless) handles Word files. poppler-utils gives Calibre its PDF input
# (pdftohtml). tini reaps the soffice/calibre child processes.
#
# libreoffice-core-nogui avoids pulling in the desktop UI stack. If apt can't
# resolve it next to libreoffice-writer, fall back to the regular core package.
RUN set -eux; \
    apt-get update; \
    common="ca-certificates tini calibre poppler-utils fontconfig fonts-dejavu-core fonts-liberation2"; \
    apt-get install -y --no-install-recommends $common libreoffice-writer libreoffice-core-nogui \
      || apt-get install -y --no-install-recommends $common libreoffice-writer; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /usr/share/doc/* /usr/share/man/*; \
    ebook-convert --version; \
    soffice --version

ENV NODE_ENV=production \
    PORT=8080 \
    PUBLIC_DIR=/app/public \
    WORK_DIR=/tmp/folio-jobs \
    HOME=/home/node \
    QT_QPA_PLATFORM=offscreen \
    QTWEBENGINE_CHROMIUM_FLAGS="--no-sandbox" \
    QTWEBENGINE_DISABLE_SANDBOX=1

WORKDIR /app

# Install production dependencies first so this layer is cached between code changes.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev && npm cache clean --force

# Server code (node_modules and tests are excluded by .dockerignore).
COPY server/ ./server/

# Static site only: never server/, .git or docs.
COPY index.html styles.css main.js sw.js manifest.webmanifest ./public/
COPY icons/ ./public/icons/
COPY converter/ ./public/converter/

RUN mkdir -p /tmp/folio-jobs \
 && chown -R node:node /tmp/folio-jobs /home/node

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/src/index.js"]
