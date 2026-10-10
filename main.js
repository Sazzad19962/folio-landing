// Front-end demo only: the converter UI reacts to file choice and format
// selection, but no file leaves the browser and nothing is converted.
// Wire `convert()` to your backend when the service is live.
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

  // Without the form and the file input there is no demo to run.
  if (!form || !input) return;

  const MAX_MB = 50; // Free plan limit, matches the pricing copy.
  const MAX_BYTES = MAX_MB * 1024 * 1024;
  const ACCEPTED = {
    PDF: ['application/pdf', 'application/x-pdf', 'application/acrobat'],
    EPUB: ['application/epub+zip', 'application/epub']
  };
  // Browsers often report no MIME type (or a generic one) for ebooks.
  const GENERIC_MIME = ['', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed'];
  const OTHER_FORMATS = ['MOBI', 'AZW', 'AZW3', 'DOCX', 'DOC', 'TXT', 'CBZ', 'RTF', 'ODT'];

  let current = null; // the accepted File, or null

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

  // Only PDF and EPUB are accepted in this preview.
  input.setAttribute('accept', '.pdf,.epub,application/pdf,application/epub+zip');
  input.removeAttribute('multiple');

  const dropTitle = drop ? drop.querySelector('.dropzone-title') : null;
  const dropTitleText = dropTitle ? dropTitle.textContent : '';

  if (drop) {
    // The drop zone is the single keyboard target; the hidden input is skipped.
    drop.setAttribute('tabindex', '0');
    drop.setAttribute('role', 'button');
    drop.setAttribute('aria-label', 'Choose a PDF or EPUB file, or drag one here');
    const hint = $('file-hint');
    if (hint) {
      // Keep the visible hint in line with what this preview accepts.
      hint.textContent = 'PDF or EPUB. Free plan: up to ' + MAX_MB + ' MB per file.';
      drop.setAttribute('aria-describedby', 'file-hint');
    }
    input.setAttribute('tabindex', '-1');

    drop.addEventListener('click', function (e) {
      // Clicks on the <label> already open the picker via the input.
      if (e.target === input || (e.target.closest && e.target.closest('label'))) return;
      input.click();
    });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        input.click();
      }
    });

    let depth = 0; // dragenter/leave fire for child elements too
    function setOver(on) {
      drop.classList.toggle('is-over', on);
      if (dropTitle) dropTitle.textContent = on ? 'Release to add your file' : dropTitleText;
    }
    drop.addEventListener('dragenter', function (e) {
      e.preventDefault();
      depth++;
      setOver(true);
    });
    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    drop.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      setOver(false);
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
      setStatus(name + ' removed. Choose a PDF or EPUB, up to ' + MAX_MB + ' MB.');
      if (drop) drop.focus();
    });
    fileRow.appendChild(removeBtn);
  }

  // ---------- Validation ----------

  function validate(file) {
    const ext = extOf(file.name);
    const type = (file.type || '').toLowerCase();

    if (ext !== 'PDF' && ext !== 'EPUB') {
      if (OTHER_FORMATS.indexOf(ext) !== -1) {
        return ext + ' files aren’t supported in this preview yet. Please choose a PDF or EPUB.';
      }
      if (!ext) {
        return '“' + file.name + '” has no file extension, so we can’t tell what it is. Please choose a file ending in .pdf or .epub.';
      }
      return '.' + ext.toLowerCase() + ' files can’t be converted. Please choose a PDF or EPUB.';
    }

    const mimeOk = GENERIC_MIME.indexOf(type) !== -1 || ACCEPTED[ext].indexOf(type) !== -1;
    if (!mimeOk) {
      return '“' + file.name + '” is named like a' + (ext === 'EPUB' ? 'n EPUB' : ' PDF') +
        ' but doesn’t look like one. Try exporting it again as a real ' + ext + '.';
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
    const files = source && source.files;
    const keep = current ? ' ' + current.name + ' is still selected.' : '';

    if (isFolder(source)) {
      showError('That’s a folder. Please drop a single PDF or EPUB file.' + keep);
      return;
    }
    if (!files || files.length === 0) {
      if (source && source.types) showError('That doesn’t look like a file. Please drop a PDF or EPUB.' + keep);
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
    if (source === 'PDF') return 'EPUB';
    if (source === 'EPUB') return 'PDF';
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
    if (btn && to) btn.textContent = 'Convert to ' + to.value;
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

  // ---------- Convert (preview) ----------

  function convert() {
    if (!current) {
      setStatus('Choose a PDF or EPUB first. Drop it in the box above or press Enter on it to browse.', 'error');
      if (drop) drop.focus();
      return;
    }
    // Honest preview: nothing is uploaded and no output file is created.
    setProgress(0);
    setStatus('Online conversion is coming soon. This page is a preview, so ' + current.name +
      ' wasn’t uploaded or converted, and it never left your device.', 'normal');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    convert();
  });

  // ---------- Initial state ----------

  // Replace any sample file shown in the markup with an honest empty state.
  clearFile();
})();
