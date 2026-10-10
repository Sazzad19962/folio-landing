'use strict';

// Shared setup for the API tests. Call setup() before requiring anything from src/,
// because src/config.js reads the environment once when it loads.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKES = path.join(__dirname, 'fakes');

function setup(env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-test-'));
  Object.assign(process.env, {
    WORK_DIR: path.join(root, 'work'),
    CALIBRE_BIN: path.join(FAKES, 'ebook-convert.js'),
    SOFFICE_BIN: path.join(FAKES, 'soffice.js'),
    MAX_FILE_MB: '1',
    RATE_LIMIT_PER_HOUR: '1000',
    RETENTION_MIN: '120',
    ALLOWED_ORIGINS: 'https://allowed.example',
    TRUST_PROXY: '0'
  }, env || {});
  return root;
}

async function start(overrides) {
  const { createApp } = require('../src/app');
  const app = createApp(overrides);
  await app.locals.toolsReady;
  const server = await new Promise(function (resolve) {
    const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    app: app,
    base: base,
    close: function () {
      return new Promise(function (resolve) {
        server.closeAllConnections();
        server.close(function () { resolve(); });
      });
    }
  };
}

function form(fields, files) {
  const fd = new FormData();
  Object.keys(fields || {}).forEach(function (k) { fd.append(k, fields[k]); });
  (files || []).forEach(function (f) {
    fd.append(f.field || 'file', new Blob([f.data]), f.name);
  });
  return fd;
}

async function upload(base, name, data, to, extra) {
  const res = await fetch(base + '/api/convert', {
    method: 'POST',
    body: form(to === undefined ? {} : { to: to }, name === null ? [] : [{ name: name, data: data }]),
    headers: (extra && extra.headers) || {}
  });
  const body = await res.json();
  return { res: res, body: body };
}

async function waitFor(base, id, statuses, timeoutMs) {
  const until = Date.now() + (timeoutMs || 15000);
  const want = statuses || ['done', 'error'];
  for (;;) {
    const res = await fetch(base + '/api/jobs/' + id);
    const body = await res.json();
    if (res.status !== 200) throw new Error('poll returned ' + res.status + ': ' + JSON.stringify(body));
    if (want.indexOf(body.status) !== -1) return body;
    if (Date.now() > until) throw new Error('timed out waiting for job, last: ' + JSON.stringify(body));
    await new Promise(function (r) { setTimeout(r, 50); });
  }
}

module.exports = { setup, start, upload, waitFor, form };
