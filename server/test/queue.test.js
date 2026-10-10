'use strict';

const { setup, start, upload, waitFor } = require('./helpers');
setup({ CONVERT_TIMEOUT_S: '2', CONCURRENCY: '1', MAX_QUEUE: '2' });

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sample } = require('./fakes/magic');
const config = require('../src/config');

let srv;

test.before(async function () {
  srv = await start();
});

test.after(async function () {
  await srv.close();
  srv.app.locals.store.close();
});

async function waitUntil(fn, ms) {
  const until = Date.now() + (ms || 5000);
  while (!(await fn())) {
    if (Date.now() > until) throw new Error('condition not met');
    await new Promise(function (r) { setTimeout(r, 25); });
  }
}

test('queue positions count jobs ahead; full queue is 503; DELETE cancels', async function () {
  const slow = await upload(srv.base, 'slow.pdf', sample('PDF', 'SLOW-TEST'), 'EPUB');
  assert.equal(slow.res.status, 202);
  assert.equal(slow.body.status, 'converting');
  assert.equal(slow.body.position, 0);

  const a = await upload(srv.base, 'a.pdf', sample('PDF'), 'EPUB');
  const b = await upload(srv.base, 'b.pdf', sample('PDF'), 'EPUB');
  assert.equal(a.body.status, 'queued');
  assert.equal(a.body.position, 0);
  assert.equal(b.body.position, 1);

  const full = await upload(srv.base, 'c.pdf', sample('PDF'), 'EPUB');
  assert.equal(full.res.status, 503);
  assert.equal(full.body.error, 'The converter is busy. Please try again in a minute.');
  assert.deepEqual(fs.readdirSync(srv.app.locals.store.incomingDir), []);

  // Cancel a queued job: the one behind it moves up.
  assert.equal((await fetch(srv.base + '/api/jobs/' + a.body.id, { method: 'DELETE' })).status, 204);
  const bj = await (await fetch(srv.base + '/api/jobs/' + b.body.id)).json();
  assert.equal(bj.status, 'queued');
  assert.equal(bj.position, 0);

  // Cancel the running job: its converter is killed and the next job starts.
  assert.equal((await fetch(srv.base + '/api/jobs/' + slow.body.id, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(srv.base + '/api/jobs/' + slow.body.id)).status, 404);
  const done = await waitFor(srv.base, b.body.id);
  assert.equal(done.status, 'done');
  // On Windows the killed process may hold its directory briefly; it goes once the process exits.
  await waitUntil(function () { return !fs.existsSync(path.join(config.workDir, slow.body.id)); });
});

test('a conversion that runs too long is killed with a friendly message', async function () {
  const started = Date.now();
  const up = await upload(srv.base, 'slow.pdf', sample('PDF', 'SLOW-TEST'), 'EPUB');
  const job = await waitFor(srv.base, up.body.id, null, 10000);
  assert.equal(job.status, 'error');
  assert.match(job.error, /^This file took too long to convert/);
  assert.ok(Date.now() - started < 8000);
  assert.deepEqual(fs.readdirSync(path.join(config.workDir, up.body.id)), []);
});

test('a missing converter gives the unavailable message', async function () {
  const store = srv.app.locals.store;
  const saved = store.cfg.calibreBin;
  store.cfg.calibreBin = path.join(__dirname, 'fakes', 'missing-binary-' + Date.now());
  try {
    const up = await upload(srv.base, 'x.pdf', sample('PDF'), 'EPUB');
    const job = await waitFor(srv.base, up.body.id);
    assert.equal(job.status, 'error');
    assert.match(job.error, /^The converter isn't available right now/);
  } finally {
    store.cfg.calibreBin = saved;
  }
});
