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

  const known = ['PDF', 'EPUB', 'MOBI', 'AZW3', 'DOCX', 'TXT'];

  function updateButton() {
    btn.textContent = 'Convert to ' + to.value;
  }

  function setFile(file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toUpperCase();
    nameEl.textContent = file.name;
    iconEl.textContent = ext.slice(0, 4) || 'FILE';
    if (known.includes(ext)) from.value = ext;
    if (from.value === to.value) to.value = from.value === 'EPUB' ? 'PDF' : 'EPUB';
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
