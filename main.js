// Converter: validates the chosen file, uploads it to the conversion API,
// follows the job until it is done and offers the result for download.
// The API base comes from <meta name="folio-api"> (empty = same origin).
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  const form = $('converter');
  const drop = $('dropzone');
  const input = $('file');
  const from = $('from');
  const to = $('to');
  const btn = $('convert-btn');
  const nameEl = $('file-name');
  const iconEl = $('file-icon');
  const statusEl = $('file-status');
  const bar = $('progress');

  const yearEl = $('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Without the form and the file input there is no converter to run.
  if (!form || !input) return;

  const MAX_MB = 50; // Free plan limit, matches the pricing copy.
  const MAX_BYTES = MAX_MB * 1024 * 1024;
  // Formats the converter accepts, matching the "From" list. An empty list means
  // any MIME type is fine (browsers rarely know Kindle formats).
  const ACCEPTED = {
    PDF: ['application/pdf', 'application/x-pdf', 'application/acrobat'],
    EPUB: ['application/epub+zip', 'application/epub'],
    MOBI: [],
    AZW3: [],
    DOCX: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    DOC: ['application/msword'],
    TXT: ['text/plain']
  };
  const WORD = ['DOCX', 'DOC'];
  const ACCEPT_LIST = 'PDF, EPUB, MOBI, AZW3, Word (DOCX, DOC) or TXT';
  // Browsers often report no MIME type (or a generic one) for ebooks.
  const GENERIC_MIME = ['', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed'];
  const OTHER_FORMATS = ['AZW', 'CBZ', 'RTF', 'ODT', 'PAGES'];

  let current = null; // the accepted File, or null

  // Conversion API. Strip a trailing slash so paths can be appended.
  const apiMeta = document.querySelector('meta[name="folio-api"]');
  const API_BASE = ((apiMeta && apiMeta.getAttribute('content')) || '').trim().replace(/\/+$/, '');

  // Conversion run state. `runId` invalidates callbacks from an older run.
  let busy = false;
  let runId = 0;
  let activeXhr = null;
  let pollTimer = null;
  let wakeTimer = null;

  // ---------- Helpers ----------

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toUpperCase() : '';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + (bytes === 1 ? ' byte' : ' bytes');
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let u = 0;
    while (value >= 1024 && u < units.length - 1) { value /= 1024; u++; }
    return (value < 10 ? value.toFixed(1) : Math.round(value)) + ' ' + units[u];
  }

  function hasOption(select, value) {
    if (!select) return false;
    for (let i = 0; i < select.options.length; i++) {
      if (select.options[i].value === value) return true;
    }
    return false;
  }

  // Screen-reader announcements: reuse #file-status if the markup already
  // makes it a live region, otherwise create one dedicated region so
  // updating the visible file row does not trigger duplicate readouts.
  const fileRow = nameEl && nameEl.closest ? nameEl.closest('.file-row') : null;
  const statusIsLive = !!(statusEl && (statusEl.getAttribute('aria-live') || statusEl.getAttribute('role') === 'status'));
  let live = statusIsLive ? null : $('converter-live');
  if (!statusIsLive && !live) {
    live = document.createElement('div');
    live.id = 'converter-live';
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    form.appendChild(live);
  }
  if (live && fileRow) fileRow.removeAttribute('aria-live');

  let announceTimer = null;
  function announce(message) {
    if (!live) return; // #file-status announces itself
    // Clear first so repeating the same message is still read out.
    live.textContent = '';
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () { live.textContent = message; }, 60);
  }

  function setStatus(message, tone) {
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.classList.toggle('is-error', tone === 'error');
      statusEl.classList.toggle('is-ok', tone === 'ok');
    }
    announce(message);
  }

  function setProgress(pct) {
    if (!bar) return;
    bar.style.width = pct + '%';
    const track = bar.parentNode;
    if (track && track.classList && track.classList.contains('progress')) {
      track.style.display = pct > 0 ? '' : 'none';
    }
  }

  // ---------- Drop zone setup ----------

  // Only the supported formats show up in the file picker.
  input.setAttribute('accept', Object.keys(ACCEPTED).map(function (e) { return '.' + e.toLowerCase(); }).join(','));
  input.removeAttribute('multiple');

  const dropTitle = drop ? drop.querySelector('.dropzone-title') : null;
  const dropTitleText = dropTitle ? dropTitle.textContent : '';

  if (drop) {
    // The drop zone is the single keyboard target; the hidden input is skipped.
    drop.setAttribute('tabindex', '0');
    drop.setAttribute('role', 'button');
    drop.setAttribute('aria-label', 'Choose a book or document, or drag one here');
    const hint = $('file-hint');
    if (hint) {
      // Keep the visible hint in line with what the converter accepts.
      hint.textContent = ACCEPT_LIST + '. Free plan: up to ' + MAX_MB + ' MB per file.';
      drop.setAttribute('aria-describedby', 'file-hint');
    }
    input.setAttribute('tabindex', '-1');

    drop.addEventListener('click', function (e) {
      // While converting, the drop zone (and its label) does nothing.
      if (busy) { e.preventDefault(); return; }
      // Clicks on the <label> already open the picker via the input.
      if (e.target === input || (e.target.closest && e.target.closest('label'))) return;
      input.click();
    });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (!busy) input.click();
      }
    });

    let depth = 0; // dragenter/leave fire for child elements too
    function setOver(on) {
      drop.classList.toggle('is-over', on);
      if (dropTitle) dropTitle.textContent = on ? 'Release to add your file' : dropTitleText;
    }
    drop.addEventListener('dragenter', function (e) {
      e.preventDefault();
      if (busy) return;
      depth++;
      setOver(true);
    });
    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    });
    drop.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      setOver(false);
      if (busy) return;
      handleFiles(e.dataTransfer);
    });
  }

  // A file dropped just outside the zone should not replace the page.
  ['dragover', 'drop'].forEach(function (evt) {
    window.addEventListener(evt, function (e) {
      const dt = e.dataTransfer;
      if (!dt || !dt.types || Array.prototype.indexOf.call(dt.types, 'Files') === -1) return;
      if (drop && drop.contains(e.target)) return;
      e.preventDefault();
      if (evt === 'dragover') dt.dropEffect = 'none';
    });
  });

  // ---------- File row: remove button ----------

  let removeBtn = null;
  if (fileRow) {
    removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.hidden = true;
    removeBtn.className = 'file-remove';
    removeBtn.addEventListener('click', function () {
      const name = current ? current.name : 'File';
      clearFile();
      setStatus(name + ' removed. Choose another file, up to ' + MAX_MB + ' MB.');
      if (drop) drop.focus();
    });
    fileRow.appendChild(removeBtn);
  }

  // ---------- Validation ----------

  function validate(file) {
    const ext = extOf(file.name);
    const type = (file.type || '').toLowerCase();

    if (!Object.prototype.hasOwnProperty.call(ACCEPTED, ext)) {
      if (OTHER_FORMATS.indexOf(ext) !== -1) {
        return ext + ' files aren’t supported yet. Please choose ' + ACCEPT_LIST + '.';
      }
      if (!ext) {
        return '“' + file.name + '” has no file extension, so we can’t tell what it is. Please choose ' + ACCEPT_LIST + '.';
      }
      return '.' + ext.toLowerCase() + ' files can’t be converted. Please choose ' + ACCEPT_LIST + '.';
    }

    const mimes = ACCEPTED[ext];
    const mimeOk = !mimes.length || GENERIC_MIME.indexOf(type) !== -1 || mimes.indexOf(type) !== -1;
    if (!mimeOk) {
      return '“' + file.name + '” is named like a' + (/^[AEIOU]/.test(ext) ? 'n ' : ' ') + ext +
        ' file but doesn’t look like one. Try exporting it again as a real ' + ext + '.';
    }

    if (file.size === 0) {
      return '“' + file.name + '” is empty (0 bytes). It may not have finished downloading. Try another copy.';
    }

    if (file.size > MAX_BYTES) {
      return '“' + file.name + '” is ' + formatSize(file.size) + '. The free plan converts files up to ' +
        MAX_MB + ' MB; Pro handles files up to 2 GB.';
    }

    return '';
  }

  function isFolder(dataTransfer) {
    const items = dataTransfer && dataTransfer.items;
    if (!items || !items.length || typeof items[0].webkitGetAsEntry !== 'function') return false;
    const entry = items[0].webkitGetAsEntry();
    return !!(entry && entry.isDirectory);
  }

  function handleFiles(source) {
    if (busy) return;
    const files = source && source.files;
    const keep = current ? ' ' + current.name + ' is still selected.' : '';

    if (isFolder(source)) {
      showError('That’s a folder. Please drop a single file.' + keep);
      return;
    }
    if (!files || files.length === 0) {
      if (source && source.types) showError('That doesn’t look like a file. Please drop a book or document.' + keep);
      return;
    }
    if (files.length > 1) {
      showError('You added ' + files.length + ' files. The free converter takes one file at a time; batch import is part of Pro.' + keep);
      return;
    }

    const problem = validate(files[0]);
    if (problem) {
      showError(problem + keep);
      return;
    }
    setFile(files[0]);
  }

  function showError(message) {
    input.value = ''; // allow choosing the same file again after fixing it
    if (current) input.removeAttribute('aria-invalid');
    else input.setAttribute('aria-invalid', 'true');
    setProgress(0);
    setStatus(message, 'error');
  }

  // ---------- File state ----------

  function setFile(file) {
    stopRun();
    hideResult();
    current = file;
    const ext = extOf(file.name);

    if (nameEl) {
      nameEl.textContent = file.name;
      nameEl.title = file.name;
    }
    if (iconEl) iconEl.textContent = ext;
    if (removeBtn) removeBtn.hidden = false;
    input.removeAttribute('aria-invalid');

    if (from) {
      if (hasOption(from, ext)) from.value = ext;
      from.disabled = true; // the source format comes from the file itself
      from.title = 'Set from your file. Remove the file to change it.';
    }
    syncTargets(true);
    setProgress(0);
    setStatus(formatSize(file.size) + ' · ' + ext + ' · ready. Pick a format, then convert.', 'normal');
  }

  function clearFile() {
    stopRun();
    hideResult();
    current = null;
    input.value = '';
    input.removeAttribute('aria-invalid');
    if (nameEl) {
      nameEl.textContent = 'No file chosen yet';
      nameEl.removeAttribute('title');
    }
    if (iconEl) iconEl.textContent = 'FILE';
    if (removeBtn) removeBtn.hidden = true;
    if (from) {
      from.disabled = false;
      from.removeAttribute('title');
    }
    syncTargets(false);
    setProgress(0);
  }

  // ---------- Format selection ----------

  function defaultTarget(source) {
    // Ebooks and Word files go to PDF; everything else to EPUB.
    if (source === 'EPUB' || WORD.indexOf(source) !== -1) return 'PDF';
    return hasOption(to, 'EPUB') ? 'EPUB' : (to && to.options[0] ? to.options[0].value : '');
  }

  // Disable "To" options that match the source; pick a sensible default.
  function syncTargets(useDefault) {
    if (!to) return;
    const source = from ? from.value : '';
    for (let i = 0; i < to.options.length; i++) {
      const opt = to.options[i];
      opt.disabled = opt.value === source;
    }
    if (useDefault || to.value === source || (to.selectedOptions && to.selectedOptions[0] && to.selectedOptions[0].disabled)) {
      const target = defaultTarget(source);
      if (hasOption(to, target) && target !== source) {
        to.value = target;
      } else {
        for (let j = 0; j < to.options.length; j++) {
          if (!to.options[j].disabled) { to.value = to.options[j].value; break; }
        }
      }
    }
    updateButton();
  }

  function updateButton() {
    if (btn && to && !busy) btn.textContent = 'Convert to ' + to.value;
  }

  if (from) from.addEventListener('change', function () { syncTargets(true); });
  if (to) to.addEventListener('change', function () {
    updateButton();
    if (current) setStatus('Will convert ' + current.name + ' to ' + to.value + '.');
  });

  input.addEventListener('change', function () {
    if (!input.files || input.files.length === 0) return; // picker cancelled
    handleFiles(input);
  });

  // ---------- Convert ----------

  const UPLOAD_SHARE = 30;      // upload fills 0–30% of the bar, conversion 30–100%
  const WAKE_AFTER_MS = 8000;   // free hosting sleeps; say so if nothing happens for this long
  const POLL_FAST_MS = 1000;
  const POLL_SLOW_MS = 2000;
  const SLOW_AFTER_MS = 30000;
  const MAX_POLL_FAILURES = 5;  // consecutive network failures tolerated while polling

  const MSG_UNREACHABLE = 'We couldn’t reach the converter. Check your connection and try again.';
  const MSG_GENERIC = 'Something went wrong on our side and the file wasn’t converted. Please try again in a moment.';
  const MSG_WAKING = 'Waking up the converter. The first conversion after a quiet spell can take up to a minute.';

  function apiUrl(path) { return API_BASE + path; }

  // downloadUrl is relative to the API ("/api/jobs/<id>/download").
  function absoluteDownload(url) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return API_BASE + (url.charAt(0) === '/' ? url : '/' + url);
  }

  function parseJson(text) {
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      return data && typeof data === 'object' ? data : null;
    } catch (err) {
      return null;
    }
  }

  // A friendly sentence from an API error body, or the generic message.
  function errorText(data) {
    return data && typeof data.error === 'string' && data.error.trim() ? data.error.trim() : MSG_GENERIC;
  }

  function clamp(n) { return Math.max(0, Math.min(100, Number(n) || 0)); }

  // ---- Busy state ----

  function setBusy(on) {
    busy = on;
    form.setAttribute('aria-busy', on ? 'true' : 'false');
    if (btn) {
      btn.disabled = on;
      if (on) btn.textContent = 'Converting…';
    }
    if (from) from.disabled = on || !!current; // the source format stays locked to the file
    if (to) to.disabled = on;
    if (removeBtn) removeBtn.disabled = on;
    input.disabled = on;
    if (drop) {
      if (on) drop.setAttribute('aria-disabled', 'true');
      else drop.removeAttribute('aria-disabled');
    }
    if (!on) updateButton();
  }

  // Cancels any upload, poll or timer from the current run.
  function stopRun() {
    runId++;
    if (activeXhr) {
      const xhr = activeXhr;
      activeXhr = null;
      try { xhr.abort(); } catch (err) { /* already finished */ }
    }
    clearTimeout(pollTimer);
    clearTimeout(wakeTimer);
    pollTimer = null;
    wakeTimer = null;
    if (busy) setBusy(false);
  }

  // Shows the "waking up" note if neither progress nor a response arrives in time.
  function armWakeTimer(id) {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(function () {
      if (id === runId && busy) setStatus(MSG_WAKING);
    }, WAKE_AFTER_MS);
  }

  function fail(id, message) {
    if (id !== runId) return;
    stopRun();
    setProgress(0);
    setStatus(message, 'error');
  }

  // ---- Result area: download link and "Delete now" ----

  let resultEl = null;
  let downloadLink = null;
  let deleteBtn = null;
  let resultJobId = null;

  function ensureResult() {
    if (resultEl) return resultEl;
    resultEl = document.createElement('div');
    resultEl.className = 'convert-result';
    resultEl.hidden = true;

    downloadLink = document.createElement('a');
    downloadLink.className = 'btn btn-dark';

    deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'file-remove';
    deleteBtn.textContent = 'Delete now';
    deleteBtn.addEventListener('click', deleteNow);

    resultEl.appendChild(downloadLink);
    resultEl.appendChild(deleteBtn);

    if (fileRow && fileRow.parentNode) fileRow.parentNode.insertBefore(resultEl, fileRow.nextSibling);
    else form.insertBefore(resultEl, btn || null);
    return resultEl;
  }

  function showResult(job, outputName) {
    ensureResult();
    resultJobId = job.id;
    downloadLink.href = absoluteDownload(job.downloadUrl || '/api/jobs/' + encodeURIComponent(job.id) + '/download');
    downloadLink.setAttribute('download', outputName);
    downloadLink.textContent = 'Download ' + outputName;
    deleteBtn.disabled = false;
    deleteBtn.textContent = 'Delete now';
    resultEl.hidden = false;
    downloadLink.focus();
  }

  function hideResult() {
    resultJobId = null;
    if (resultEl) resultEl.hidden = true;
  }

  function deleteNow() {
    const jobId = resultJobId;
    if (!jobId || !deleteBtn) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';

    function restore() {
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete now';
    }

    fetch(apiUrl('/api/jobs/' + encodeURIComponent(jobId)), { method: 'DELETE', cache: 'no-store' })
      .then(function (res) {
        if (resultJobId !== jobId) return; // the user moved on meanwhile
        // 404 means it is already gone, which is what the user wanted.
        if (res.ok || res.status === 404) {
          hideResult();
          setProgress(0);
          setStatus('Deleted from our servers.', 'ok');
          if (btn) btn.focus();
          return;
        }
        return res.text().then(function (text) {
          restore();
          setStatus(errorText(parseJson(text)), 'error');
        });
      })
      .catch(function () {
        if (resultJobId !== jobId) return;
        restore();
        setStatus(MSG_UNREACHABLE, 'error');
      });
  }

  // ---- Upload ----

  function convert() {
    if (busy) return;
    if (!current) {
      setStatus('Choose a file first. Drop it in the box above or press Enter on it to browse.', 'error');
      if (drop) drop.focus();
      return;
    }
    if (typeof XMLHttpRequest === 'undefined' || typeof FormData === 'undefined') {
      setStatus('This browser can’t upload files. Please try a current version of Chrome, Edge, Firefox or Safari.', 'error');
      return;
    }

    stopRun();
    hideResult();
    const id = runId;
    const target = to ? to.value : '';
    const file = current;

    setBusy(true);
    setProgress(1);
    setStatus('Uploading… 0%');
    armWakeTimer(id);

    const data = new FormData();
    data.append('to', target); // the API reads `to` before the file streams in
    data.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    activeXhr = xhr;
    xhr.open('POST', apiUrl('/api/convert'));
    xhr.setRequestHeader('Accept', 'application/json');

    if (xhr.upload) {
      xhr.upload.addEventListener('progress', function (e) {
        if (id !== runId || !e.lengthComputable || !e.total) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        setProgress(Math.max(1, (pct * UPLOAD_SHARE) / 100));
        setStatus('Uploading… ' + pct + '%');
        armWakeTimer(id);
      });
      xhr.upload.addEventListener('load', function () {
        if (id !== runId) return;
        setProgress(UPLOAD_SHARE);
        setStatus('Uploaded. Starting the conversion…');
        armWakeTimer(id);
      });
    }

    xhr.addEventListener('load', function () {
      if (id !== runId) return;
      activeXhr = null;
      const body = parseJson(xhr.responseText);
      if (xhr.status === 202 || (xhr.status >= 200 && xhr.status < 300)) {
        if (body && body.id) {
          setProgress(UPLOAD_SHARE);
          handleJob(id, body, target, file.name);
          if (id === runId && busy) startPolling(id, body.id, target, file.name);
          return;
        }
        fail(id, MSG_GENERIC);
        return;
      }
      // A plain static host (no API behind it) answers with an HTML 404/405/501.
      if (!body && (xhr.status === 0 || xhr.status === 404 || xhr.status === 405 || xhr.status === 501)) {
        fail(id, MSG_UNREACHABLE);
        return;
      }
      fail(id, errorText(body));
    });
    xhr.addEventListener('error', function () { fail(id, MSG_UNREACHABLE); });
    xhr.addEventListener('timeout', function () { fail(id, MSG_UNREACHABLE); });

    try {
      xhr.send(data);
    } catch (err) {
      fail(id, MSG_UNREACHABLE);
    }
  }

  // ---- Job status ----

  function outputNameFor(job, target, sourceName) {
    if (job.outputName) return String(job.outputName);
    const dot = sourceName.lastIndexOf('.');
    return (dot > 0 ? sourceName.slice(0, dot) : sourceName) + '.' + target.toLowerCase();
  }

  // Updates the UI from a job object; finishes the run on done or error.
  function handleJob(id, job, target, sourceName) {
    if (id !== runId) return;
    const status = job.status;

    if (status === 'queued') {
      const ahead = Number(job.position);
      setProgress(UPLOAD_SHARE);
      setStatus(ahead > 0 ? 'Waiting in line (' + ahead + ' ahead)…' : 'Waiting in line…');
    } else if (status === 'converting') {
      const pct = Math.round(clamp(job.progress));
      setProgress(UPLOAD_SHARE + (pct * (100 - UPLOAD_SHARE)) / 100);
      setStatus('Converting to ' + target + '… ' + pct + '%');
    } else if (status === 'done') {
      const name = outputNameFor(job, target, sourceName);
      stopRun();
      setProgress(100);
      setStatus('Done. ' + name + ' is ready. It’s deleted from our servers automatically after 2 hours.', 'ok');
      showResult(job, name);
    } else if (status === 'error') {
      fail(id, errorText(job));
    }
  }

  function startPolling(id, jobId, target, sourceName) {
    const startedAt = Date.now();
    let failures = 0;

    function schedule() {
      if (id !== runId) return;
      const delay = Date.now() - startedAt < SLOW_AFTER_MS ? POLL_FAST_MS : POLL_SLOW_MS;
      pollTimer = setTimeout(poll, delay);
    }

    // Network trouble (or a sleeping/restarting server) is retried a few times.
    function transient(message) {
      failures++;
      if (failures > MAX_POLL_FAILURES) fail(id, message || MSG_UNREACHABLE);
      else schedule();
    }

    function poll() {
      if (id !== runId) return;
      fetch(apiUrl('/api/jobs/' + encodeURIComponent(jobId)), {
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      })
        .then(function (res) {
          return res.text().then(function (text) { return { res: res, body: parseJson(text) }; });
        })
        .then(function (r) {
          if (id !== runId) return;
          if (r.res.ok && r.body && r.body.status) {
            failures = 0;
            armWakeTimer(id);
            handleJob(id, r.body, target, sourceName);
            if (id === runId && busy) schedule();
            return;
          }
          if (r.res.status >= 500 || (r.res.ok && !r.body)) {
            transient(r.body ? errorText(r.body) : MSG_GENERIC);
            return;
          }
          // 404 (expired or unknown job) and other client errors end the run.
          fail(id, errorText(r.body));
        })
        .catch(function () {
          if (id !== runId) return;
          transient();
        });
    }

    schedule();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    convert();
  });

  // ---------- Initial state ----------

  // Replace any sample file shown in the markup with an honest empty state.
  clearFile();
})();

// Install as an app (PWA): service worker, install button and iOS steps.
(function () {
  const section = document.getElementById('download');
  const btn = document.getElementById('install-btn');
  const label = document.getElementById('install-label');
  const hint = document.getElementById('install-hint');
  let deferredPrompt = null;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true;

  function showInstalled() {
    deferredPrompt = null;
    btn.hidden = false;
    btn.disabled = true;
    label.textContent = 'Installed';
    hint.textContent = 'Folio is installed on this device. Open it from your home screen or app list.';
  }

  if (isIOS) {
    section.classList.add('is-ios');
    hint.textContent = 'On iPhone and iPad, install Folio from Safari\u2019s Share menu. It takes three taps.';
  }
  if (isStandalone) showInstalled();

  // Chrome, Edge and Android browsers fire this when the page is installable.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    if (isStandalone) return;
    deferredPrompt = e;
    btn.hidden = false;
    btn.disabled = false;
    label.textContent = 'Install app';
    hint.textContent = '';
  });

  btn.addEventListener('click', function () {
    if (!deferredPrompt) return;
    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    promptEvent.prompt();
    promptEvent.userChoice.then(function (choice) {
      if (choice.outcome === 'accepted') {
        showInstalled();
      } else {
        // The prompt can only be shown once; the browser may offer it again later.
        btn.hidden = true;
        hint.textContent = 'No problem. You can install Folio later from your browser menu.';
      }
    });
  });

  window.addEventListener('appinstalled', showInstalled);

  // Service workers need a secure context: https, or http on localhost.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('Folio: service worker registration failed', err);
      });
    });
  }
})();
