'use strict';

const { setup, start, upload, waitFor, form } = require('./helpers');
setup();

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

function magicOf(buf, format) {
  switch (format) {
    case 'EPUB':
    case 'DOCX':
      return buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    case 'DOC':
      return buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    case 'PDF':
      return buf.subarray(0, 5).toString() === '%PDF-';
    default:
      return false;
  }
}

test('health reports both converters', async function () {
  const res = await fetch(srv.base + '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, calibre: true, soffice: true });
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('health is 503 when Calibre is missing', async function () {
  const other = await start({ calibreBin: path.join(__dirname, 'fakes', 'does-not-exist-' + Date.now()) });
  try {
    const res = await fetch(other.base + '/api/health');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.calibre, false);
  } finally {
    await other.close();
  }
});

test('formats lists sources, targets and the size limit', async function () {
  const res = await fetch(srv.base + '/api/formats');
  const body = await res.json();
  assert.deepEqual(body.from, ['PDF', 'EPUB', 'MOBI', 'AZW3', 'DOCX', 'DOC', 'TXT']);
  assert.deepEqual(body.to, ['EPUB', 'MOBI', 'AZW3', 'PDF', 'DOCX', 'DOC']);
  assert.equal(body.maxMb, 1);
});

async function convertAndDownload(name, from, to) {
  const up = await upload(srv.base, name, sample(from, 'hello'), to);
  assert.equal(up.res.status, 202, JSON.stringify(up.body));
  assert.match(up.body.id, /^[0-9a-f-]{36}$/);
  assert.ok(['queued', 'converting'].indexOf(up.body.status) !== -1);
  assert.equal(typeof up.body.position, 'number');
  assert.equal(typeof up.body.progress, 'number');

  const job = await waitFor(srv.base, up.body.id);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.progress, 100);
  assert.equal(job.downloadUrl, '/api/jobs/' + up.body.id + '/download');
  assert.ok(!isNaN(Date.parse(job.expiresAt)));
  assert.equal(job.error, undefined);
  assert.equal(job.position, undefined);

  const dl = await fetch(srv.base + job.downloadUrl);
  assert.equal(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.ok(magicOf(buf, to), 'downloaded file should be ' + to);

  // Only the final output is left in the job directory.
  const dir = path.join(config.workDir, up.body.id);
  assert.deepEqual(fs.readdirSync(dir), ['result.' + to.toLowerCase()]);
  return { job: job, dl: dl, buf: buf };
}

test('PDF to EPUB: poll until done, then download', async function () {
  const r = await convertAndDownload('My Book.pdf', 'PDF', 'EPUB');
  assert.equal(r.job.outputName, 'My Book.epub');
  assert.equal(r.dl.headers.get('content-type'), 'application/epub+zip');
  assert.match(r.dl.headers.get('content-disposition'), /^attachment; filename="My Book\.epub"/);
});

test('DOC to EPUB runs LibreOffice then Calibre', async function () {
  const r = await convertAndDownload('report.doc', 'DOC', 'EPUB');
  assert.equal(r.job.outputName, 'report.epub');
  // The fakes stack their output on top of their input: EPUB (calibre) wrapping DOCX (soffice) wrapping the DOC.
  const text = r.buf.toString('latin1');
  assert.ok(text.indexOf('soffice') !== -1, 'soffice step ran');
  assert.ok(text.indexOf('converted from input.docx') !== -1 || text.indexOf('converted from output.docx') !== -1, 'calibre read the DOCX');
});

test('EPUB to DOC runs Calibre then LibreOffice', async function () {
  const r = await convertAndDownload('novel.epub', 'EPUB', 'DOC');
  assert.equal(r.dl.headers.get('content-type'), 'application/msword');
  assert.match(r.dl.headers.get('content-disposition'), /filename="novel\.doc"/);
  assert.ok(r.buf.toString('latin1').indexOf('converted from input.epub') !== -1);
});

test('DOCX to PDF uses LibreOffice', async function () {
  const r = await convertAndDownload('cv.docx', 'DOCX', 'PDF');
  assert.equal(r.dl.headers.get('content-type'), 'application/pdf');
});

test('non-ASCII filenames survive', async function () {
  const r = await convertAndDownload('আমার বই.pdf', 'PDF', 'EPUB');
  assert.equal(r.job.outputName, 'আমার বই.epub');
  assert.match(r.dl.headers.get('content-disposition'), /filename\*=UTF-8''/);
});

test('413 when the file is over the limit', async function () {
  const big = Buffer.concat([sample('PDF'), Buffer.alloc(1.5 * 1024 * 1024, 0x41)]);
  const up = await upload(srv.base, 'big.pdf', big, 'EPUB');
  assert.equal(up.res.status, 413);
  assert.match(up.body.error, /1 MB/);
});

test('415 for a PNG renamed to .pdf', async function () {
  const up = await upload(srv.base, 'photo.pdf', sample('PNG'), 'EPUB');
  assert.equal(up.res.status, 415);
  assert.match(up.body.error, /PDF/);
});

test('415 for an unsupported extension', async function () {
  const up = await upload(srv.base, 'photo.png', sample('PNG'), 'EPUB');
  assert.equal(up.res.status, 415);
});

test('400 for converting to the same format', async function () {
  const up = await upload(srv.base, 'book.epub', sample('EPUB'), 'epub');
  assert.equal(up.res.status, 400);
  assert.match(up.body.error, /already EPUB/);
});

test('400 for missing file, missing/unknown target, empty file, two files', async function () {
  let up = await upload(srv.base, null, null, 'EPUB');
  assert.equal(up.res.status, 400);
  assert.ok(up.body.error);

  up = await upload(srv.base, 'a.pdf', sample('PDF'), undefined);
  assert.equal(up.res.status, 400);

  up = await upload(srv.base, 'a.pdf', sample('PDF'), 'EXE');
  assert.equal(up.res.status, 400);

  up = await upload(srv.base, 'a.pdf', Buffer.alloc(0), 'EPUB');
  assert.equal(up.res.status, 400);
  assert.match(up.body.error, /empty/);

  const res = await fetch(srv.base + '/api/convert', {
    method: 'POST',
    body: form({ to: 'EPUB' }, [{ name: 'a.pdf', data: sample('PDF') }, { name: 'b.pdf', data: sample('PDF') }])
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /one file/);
});

test('rejected uploads leave nothing behind', async function () {
  const incoming = srv.app.locals.store.incomingDir;
  // Give multer a moment to finish deleting.
  await new Promise(function (r) { setTimeout(r, 200); });
  assert.deepEqual(fs.readdirSync(incoming), []);
});

test('DRM-protected files get the DRM message', async function () {
  const up = await upload(srv.base, 'locked.epub', sample('EPUB', 'DRM-TEST'), 'PDF');
  assert.equal(up.res.status, 202);
  const job = await waitFor(srv.base, up.body.id);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'This file is DRM-protected. Folio only converts DRM-free files, and never removes DRM.');
  assert.equal(job.downloadUrl, undefined);
  const dl = await fetch(srv.base + '/api/jobs/' + up.body.id + '/download');
  assert.equal(dl.status, 404);
  assert.deepEqual(fs.readdirSync(path.join(config.workDir, up.body.id)), []);
});

test('other failures get a generic message without converter output', async function () {
  const up = await upload(srv.base, 'broken.pdf', sample('PDF', 'BROKEN-TEST'), 'EPUB');
  const job = await waitFor(srv.base, up.body.id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /^We couldn't convert this file/);
  assert.ok(JSON.stringify(job).indexOf('Traceback') === -1);
});

test('DELETE removes the job and its files, then 404', async function () {
  const up = await upload(srv.base, 'gone.pdf', sample('PDF'), 'EPUB');
  await waitFor(srv.base, up.body.id);
  const dir = path.join(config.workDir, up.body.id);
  assert.ok(fs.existsSync(dir));

  const del = await fetch(srv.base + '/api/jobs/' + up.body.id, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.ok(!fs.existsSync(dir));

  const res = await fetch(srv.base + '/api/jobs/' + up.body.id);
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
  assert.equal((await fetch(srv.base + '/api/jobs/' + up.body.id + '/download')).status, 404);
  assert.equal((await fetch(srv.base + '/api/jobs/' + up.body.id, { method: 'DELETE' })).status, 404);
});

test('unknown job ids and API routes are 404 JSON', async function () {
  let res = await fetch(srv.base + '/api/jobs/not-a-uuid');
  assert.equal(res.status, 404);
  res = await fetch(srv.base + '/api/jobs/00000000-0000-4000-8000-000000000000');
  assert.equal(res.status, 404);
  res = await fetch(srv.base + '/api/nope');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /json/);
});

test('expired jobs are gone', async function () {
  const up = await upload(srv.base, 'old.pdf', sample('PDF'), 'EPUB');
  await waitFor(srv.base, up.body.id);
  const store = srv.app.locals.store;
  store.jobs.get(up.body.id).expiresAt = Date.now() - 1;
  store.sweep();
  assert.ok(!fs.existsSync(path.join(config.workDir, up.body.id)));
  assert.equal((await fetch(srv.base + '/api/jobs/' + up.body.id)).status, 404);
});

test('rate limit returns 429 after the hourly allowance', async function () {
  const limited = await start({ ratePerHour: 2 });
  try {
    const a = await upload(limited.base, 'x.png', sample('PNG'), 'EPUB');
    const b = await upload(limited.base, 'x.png', sample('PNG'), 'EPUB');
    const c = await upload(limited.base, 'x.pdf', sample('PDF'), 'EPUB');
    assert.equal(a.res.status, 415);
    assert.equal(b.res.status, 415);
    assert.equal(c.res.status, 429);
    assert.ok(c.body.error);
    assert.ok(Number(c.res.headers.get('retry-after')) > 0);
  } finally {
    await limited.close();
  }
});

test('CORS reflects allowed origins and ignores others', async function () {
  let res = await fetch(srv.base + '/api/formats', { headers: { Origin: 'https://allowed.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');

  res = await fetch(srv.base + '/api/convert', {
    method: 'OPTIONS',
    headers: { Origin: 'https://allowed.example', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
  assert.match(res.headers.get('access-control-allow-methods'), /DELETE/);
  assert.match(res.headers.get('access-control-allow-headers'), /Content-Type/);

  res = await fetch(srv.base + '/api/formats', { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);

  const star = await start({ allowedOrigins: ['*'] });
  try {
    res = await fetch(star.base + '/api/formats', { headers: { Origin: 'https://any.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://any.example');
  } finally {
    await star.close();
  }
});

test('static site is served, private files are not', async function () {
  let res = await fetch(srv.base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /html/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');

  res = await fetch(srv.base + '/sw.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');

  const blocked = [
    '/server/src/app.js',
    '/Server/src/app.js',
    '/server/package.json',
    '/%73erver/src/app.js',
    '/.git/config',
    '/.git/HEAD',
    '/.github/workflows/',
    '/.dockerignore',
    '/Dockerfile',
    '/render.yaml',
    '/server/node_modules/express/package.json'
  ];
  for (const p of blocked) {
    res = await fetch(srv.base + p);
    assert.equal(res.status, 404, p);
    const text = await res.text();
    assert.ok(text.indexOf('createApp') === -1 && text.indexOf('[core]') === -1, p);
  }
});
