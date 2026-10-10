'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { SOURCES, TARGETS, MIME, extOf, looksLike } = require('./formats');
const { getStore } = require('./jobs');
const { checkTool } = require('./convert');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Never served from the static site, whatever publicDir contains.
const BLOCKED_SEGMENTS = ['server', 'node_modules'];
const BLOCKED_FILES = ['dockerfile', 'render.yaml'];
const NO_CACHE_FILES = ['sw.js', 'index.html'];

function rmQuiet(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    // The sweeper removes anything left behind.
  }
}

// Browsers send UTF-8 filenames, but the multipart parser may decode them as latin1.
function fixName(name) {
  const s = String(name || '');
  if (!/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const decoded = Buffer.from(s, 'latin1').toString('utf8');
  return decoded.indexOf('�') === -1 ? decoded : s;
}

// In-memory sliding-window limiter: at most `limit` hits per IP per hour.
function rateLimiter(limit) {
  const WINDOW = 60 * 60 * 1000;
  const hits = new Map();
  const timer = setInterval(function () {
    const cutoff = Date.now() - WINDOW;
    hits.forEach(function (list, ip) {
      const kept = list.filter(function (t) { return t > cutoff; });
      if (kept.length) hits.set(ip, kept);
      else hits.delete(ip);
    });
  }, 5 * 60 * 1000);
  timer.unref();

  return function (req, res, next) {
    const now = Date.now();
    const ip = req.ip || 'unknown';
    const list = (hits.get(ip) || []).filter(function (t) { return t > now - WINDOW; });
    if (list.length >= limit) {
      hits.set(ip, list);
      const retry = Math.max(1, Math.ceil((list[0] + WINDOW - now) / 1000));
      res.set('Retry-After', String(retry));
      return res.status(429).json({
        error: "You've reached the limit of " + limit + ' conversions per hour. Please try again later.'
      });
    }
    list.push(now);
    hits.set(ip, list);
    next();
  };
}

function createApp(overrides) {
  const cfg = Object.assign({}, config, overrides || {});
  const store = cfg.store || getStore();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  const tools = { calibre: false, soffice: false };
  const toolsReady = Promise.all([checkTool(cfg.calibreBin), checkTool(cfg.sofficeBin)]).then(function (r) {
    tools.calibre = r[0];
    tools.soffice = r[1];
    if (!r[0]) console.error('[folio] Calibre (' + cfg.calibreBin + ') is not available; conversions will fail.');
    if (!r[1]) console.error('[folio] LibreOffice (' + cfg.sofficeBin + ') is not available; Word conversions will fail.');
  });

  app.use(function (req, res, next) {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY'
    });
    next();
  });

  // CORS for other sites listed in ALLOWED_ORIGINS. Same-origin needs nothing.
  app.use('/api', function (req, res, next) {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    if (origin) {
      res.vary('Origin');
      const allowed = cfg.allowedOrigins.indexOf('*') !== -1 || cfg.allowedOrigins.indexOf(origin) !== -1;
      if (allowed) {
        res.set({
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Expose-Headers': 'Content-Disposition',
          'Access-Control-Max-Age': '600'
        });
      }
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/api/health', function (req, res) {
    toolsReady.then(function () {
      res.status(tools.calibre ? 200 : 503).json({ ok: tools.calibre, calibre: tools.calibre, soffice: tools.soffice });
    });
  });

  app.get('/api/formats', function (req, res) {
    res.json({ from: SOURCES, to: TARGETS, maxMb: cfg.maxFileMb });
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: store.incomingDir,
      filename: function (req, file, cb) {
        cb(null, require('crypto').randomUUID() + '.upload');
      }
    }),
    limits: { fileSize: cfg.maxBytes, files: 1, fields: 10, fieldSize: 1024, parts: 12 }
  }).single('file');

  function uploadMiddleware(req, res, next) {
    upload(req, res, function (err) {
      if (!err) return next();
      if (req.file) rmQuiet(req.file.path);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'This file is larger than the ' + cfg.maxFileMb + ' MB limit.' });
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: 'Please upload one file at a time.' });
        }
        return res.status(400).json({ error: "We couldn't read that upload. Please try again." });
      }
      if (/multipart|boundary|Unexpected end/i.test(String(err.message))) {
        return res.status(400).json({ error: "We couldn't read that upload. Please try again." });
      }
      next(err);
    });
  }

  app.post('/api/convert', rateLimiter(cfg.ratePerHour), uploadMiddleware, function (req, res) {
    const file = req.file;
    function reject(status, message) {
      if (file) rmQuiet(file.path);
      res.status(status).json({ error: message });
    }

    if (!file) return reject(400, 'Please choose a file to convert.');
    const to = String((req.body && req.body.to) || '').trim().replace(/^\./, '').toUpperCase();
    if (!to) return reject(400, 'Please choose a format to convert to.');
    if (TARGETS.indexOf(to) === -1) return reject(400, "Folio can't convert to " + to.slice(0, 10) + ' files. Choose one of: ' + TARGETS.join(', ') + '.');

    const originalName = fixName(file.originalname);
    const from = extOf(originalName);
    if (SOURCES.indexOf(from) === -1) {
      return reject(415, "Folio can't open this kind of file. Supported formats: " + SOURCES.join(', ') + '.');
    }
    if (from === to) return reject(400, 'This file is already ' + to + '. Choose a different format.');
    if (!file.size) return reject(400, 'This file is empty.');

    let ok = false;
    try {
      ok = looksLike(from, file.path);
    } catch (e) {
      ok = false;
    }
    if (!ok) return reject(415, "This file doesn't look like a real " + from + " file. Check that it isn't renamed or damaged.");

    if (store.isFull()) return reject(503, 'The converter is busy. Please try again in a minute.');

    let job;
    try {
      job = store.create({ uploadPath: file.path, from: from, to: to, originalName: originalName });
    } catch (err) {
      console.error('[folio] could not create job: ' + err.message);
      return reject(500, 'Something went wrong on our side. Please try again.');
    }
    if (!job) return reject(503, 'The converter is busy. Please try again in a minute.');

    res.status(202).json({ id: job.id, status: job.status, position: store.position(job), progress: job.progress });
  });

  function findJob(req, res) {
    const job = UUID.test(req.params.id) ? store.get(req.params.id) : null;
    if (!job) res.status(404).json({ error: 'This conversion was not found. It may have expired and been deleted.' });
    return job;
  }

  app.get('/api/jobs/:id', function (req, res) {
    const job = findJob(req, res);
    if (!job) return;
    const body = { id: job.id, status: job.status, progress: job.progress };
    if (job.status === 'queued') body.position = store.position(job);
    if (job.status === 'error') body.error = job.error;
    body.outputName = job.outputName;
    if (job.status === 'done') body.downloadUrl = '/api/jobs/' + job.id + '/download';
    body.expiresAt = new Date(job.expiresAt).toISOString();
    res.json(body);
  });

  app.get('/api/jobs/:id/download', function (req, res, next) {
    const job = findJob(req, res);
    if (!job) return;
    if (job.status !== 'done' || !job.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).json({ error: 'This file is not ready to download.' });
    }
    res.download(job.outputPath, job.outputName, {
      headers: { 'Content-Type': MIME[job.to] || 'application/octet-stream', 'Cache-Control': 'no-store' },
      dotfiles: 'allow'
    }, function (err) {
      if (err && !res.headersSent) next(err);
    });
  });

  app.delete('/api/jobs/:id', function (req, res) {
    const job = findJob(req, res);
    if (!job) return;
    store.delete(job.id);
    res.status(204).end();
  });

  app.use('/api', function (req, res) {
    res.status(404).json({ error: 'Not found.' });
  });

  // The landing page, when it ships alongside the server.
  const publicDir = path.resolve(cfg.publicDir);
  if (fs.existsSync(path.join(publicDir, 'index.html'))) {
    app.use(function (req, res, next) {
      let p;
      try {
        p = decodeURIComponent(req.path);
      } catch (e) {
        return res.status(400).end();
      }
      const parts = p.toLowerCase().split(/[\\/]+/).filter(Boolean);
      const blocked = parts.some(function (part) {
        return part.charAt(0) === '.' || BLOCKED_SEGMENTS.indexOf(part) !== -1 || BLOCKED_FILES.indexOf(part) !== -1;
      });
      if (blocked) return res.status(404).type('text/plain').send('Not found');
      next();
    });
    app.use(express.static(publicDir, {
      dotfiles: 'deny',
      index: 'index.html',
      redirect: false,
      setHeaders: function (res, file) {
        if (NO_CACHE_FILES.indexOf(path.basename(file).toLowerCase()) !== -1) res.set('Cache-Control', 'no-cache');
      }
    }));
  }

  // eslint-disable-next-line no-unused-vars
  app.use(function (err, req, res, next) {
    console.error('[folio] ' + req.method + ' ' + req.path + ': ' + (err && err.stack ? err.stack : err));
    if (res.headersSent) return res.end();
    const status = err && (err.status === 400 || err.statusCode === 400) ? 400 : 500;
    res.status(status).json({
      error: status === 400 ? "We couldn't read that request." : 'Something went wrong on our side. Please try again.'
    });
  });

  app.locals.store = store;
  app.locals.toolsReady = toolsReady;
  return app;
}

module.exports = { createApp };
