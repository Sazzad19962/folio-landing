'use strict';

const path = require('path');
const os = require('os');

// Express "trust proxy": a hop count (0 disables), true/false, or a list such as "loopback".
function trustProxy(raw) {
  if (raw === undefined || raw === '') return 1;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const config = {
  port: num('PORT', 8080),
  // Free plan limit; matches the 50 MB figure in the page copy.
  maxFileMb: num('MAX_FILE_MB', 50),
  // Uploaded and converted files are deleted after this many minutes (FAQ promise: 2 hours).
  retentionMin: num('RETENTION_MIN', 120),
  // A single conversion is killed after this many seconds.
  convertTimeoutS: num('CONVERT_TIMEOUT_S', 300),
  // Conversions run one at a time by default so a small instance doesn't run out of memory.
  concurrency: num('CONCURRENCY', 1),
  maxQueue: num('MAX_QUEUE', 20),
  ratePerHour: num('RATE_LIMIT_PER_HOUR', 30),
  // Comma-separated origins allowed to call the API from another site, or "*".
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
  trustProxy: trustProxy(process.env.TRUST_PROXY),
  workDir: process.env.WORK_DIR || path.join(os.tmpdir(), 'folio-jobs'),
  // The static site is served from here when it exists (the Docker image copies it in).
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, '..', '..'),
  calibreBin: process.env.CALIBRE_BIN || 'ebook-convert',
  sofficeBin: process.env.SOFFICE_BIN || 'soffice'
};

config.maxBytes = config.maxFileMb * 1024 * 1024;

module.exports = config;
