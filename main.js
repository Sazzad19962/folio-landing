// Front-end demo only: the converter UI reacts to file choice and format
// selection, but no file leaves the browser. Wire `convert()` to your backend.
(function () {
  const form = document.getElementById('converter');
  const drop = document.getElementById('dropzone');
  const input = document.getElementById('file');
  const from = document.getElementById('from');
  const to = document.getElementById('to');
  const btn = document.getElementById('convert-btn');
  const nameEl = document.getElementById('file-name');
  const iconEl = document.getElementById('file-icon');
  const statusEl = document.getElementById('file-status');
  const bar = document.getElementById('progress');

  const known = ['PDF', 'EPUB', 'MOBI', 'AZW3', 'DOCX', 'DOC', 'TXT'];
  const word = ['DOCX', 'DOC'];

  function updateButton() {
    btn.textContent = 'Convert to ' + to.value;
  }

  function setFile(file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toUpperCase();
    nameEl.textContent = file.name;
    iconEl.textContent = ext.slice(0, 4) || 'FILE';
    if (known.includes(ext)) from.value = ext;
    if (from.value === to.value) {
      to.value = (from.value === 'EPUB' || word.includes(from.value)) ? 'PDF' : 'EPUB';
    }
    bar.style.width = '0%';
    statusEl.textContent = 'Ready to convert';
    updateButton();
  }

  function convert() {
    statusEl.textContent = 'Converting to ' + to.value + '…';
    let pct = 0;
    const timer = setInterval(function () {
      pct = Math.min(100, pct + 12);
      bar.style.width = pct + '%';
      if (pct === 100) {
        clearInterval(timer);
        statusEl.textContent = 'Done — demo only, connect a backend to download';
      }
    }, 120);
  }

  input.addEventListener('change', function () { setFile(input.files[0]); });
  to.addEventListener('change', updateButton);

  ['dragenter', 'dragover'].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  form.addEventListener('submit', function (e) { e.preventDefault(); convert(); });

  document.getElementById('year').textContent = new Date().getFullYear();
  updateButton();
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
