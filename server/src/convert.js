'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const config = require('./config');
const { SOFFICE_FILTER } = require('./formats');

// Friendly messages shown to visitors. Real converter output is only logged.
const MESSAGES = {
  drm: 'This file is DRM-protected. Folio only converts DRM-free files, and never removes DRM.',
  timeout: 'This file took too long to convert. Try a smaller file, or split it into parts.',
  missing: "The converter isn't available right now. Please try again in a few minutes.",
  failed: "We couldn't convert this file. It may be damaged or use features the converter doesn't support.",
  cancelled: 'This conversion was cancelled.'
};

class ConvertError extends Error {
  constructor(kind, detail) {
    super(MESSAGES[kind] || MESSAGES.failed);
    this.kind = kind;
    this.friendly = MESSAGES[kind] || MESSAGES.failed;
    this.detail = detail || '';
  }
}

const OUTPUT_KEEP = 64 * 1024;
const LOG_KEEP = 2000;

// Converter binaries ending in .js (the test fakes) run under this Node binary.
function command(bin, args) {
  if (/\.js$/i.test(bin)) return { cmd: process.execPath, args: [bin].concat(args) };
  return { cmd: bin, args: args };
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') {
    // soffice forks soffice.bin, so kill the whole process group.
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (e) {
      // Fall through to killing the direct child.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch (e) {
    // Already gone.
  }
}

function trimForLog(text) {
  const t = String(text || '').trim();
  return t.length > LOG_KEEP ? '…' + t.slice(-LOG_KEEP) : t;
}

// Run one converter process. Resolves with { code, output }; rejects with a
// ConvertError for timeouts, cancellation and a missing binary.
function runTool(bin, args, opts) {
  const control = opts.control || {};
  const remaining = opts.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new ConvertError('timeout', 'deadline passed before step'));
  if (control.cancelled) return Promise.reject(new ConvertError('cancelled'));

  return new Promise(function (resolve, reject) {
    const c = command(bin, args);
    let child;
    try {
      child = spawn(c.cmd, c.args, {
        cwd: opts.cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: opts.env || process.env
      });
    } catch (err) {
      reject(new ConvertError(err.code === 'ENOENT' ? 'missing' : 'failed', String(err.message)));
      return;
    }

    let output = '';
    let partial = '';
    let reason = null;
    let settled = false;

    function append(chunk) {
      const text = chunk.toString('utf8');
      output += text;
      if (output.length > OUTPUT_KEEP) output = output.slice(-OUTPUT_KEEP);
      return text;
    }

    child.stdout.on('data', function (chunk) {
      const text = append(chunk);
      if (!opts.onLine) return;
      const lines = (partial + text).split(/\r\n|\r|\n/);
      partial = lines.pop();
      if (partial.length > 4096) partial = '';
      lines.forEach(function (line) { opts.onLine(line); });
    });
    child.stderr.on('data', append);

    const timer = setTimeout(function () {
      reason = 'timeout';
      killTree(child);
    }, remaining);

    control.cancel = function () {
      control.cancelled = true;
      reason = reason || 'cancelled';
      killTree(child);
    };

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      control.cancel = function () { control.cancelled = true; };
      fn(value);
    }

    child.on('error', function (err) {
      killTree(child);
      if (err.code === 'ENOENT') finish(reject, new ConvertError('missing', bin + ': ' + err.message));
      else finish(reject, new ConvertError(reason || 'failed', err.message));
    });

    child.on('close', function (code, signal) {
      if (partial && opts.onLine) opts.onLine(partial);
      if (reason) finish(reject, new ConvertError(reason, output));
      else finish(resolve, { code: code === null ? -1 : code, signal: signal, output: output });
    });
  });
}

function nonEmptyFile(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch (e) {
    return false;
  }
}

function classify(output) {
  return /DRM/.test(output) ? 'drm' : 'failed';
}

// Run every step of a plan inside jobDir. Each step writes to its own
// subdirectory. Returns the path of the final output file.
async function runPlan(opts) {
  const steps = opts.steps;
  const jobDir = opts.jobDir;
  const control = opts.control || {};
  const onProgress = opts.onProgress || function () {};
  const label = opts.label || path.basename(jobDir);
  const timeoutS = opts.timeoutS || config.convertTimeoutS;
  const calibreBin = opts.calibreBin || config.calibreBin;
  const sofficeBin = opts.sofficeBin || config.sofficeBin;
  const deadline = Date.now() + timeoutS * 1000;
  const share = 100 / Math.max(steps.length, 1);
  let current = opts.input;

  if (!steps.length) throw new ConvertError('failed', 'empty plan');

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const base = i * share;
    const ext = step.to.toLowerCase();
    const stepDir = path.join(jobDir, 'step' + (i + 1));
    fs.mkdirSync(stepDir, { recursive: true });

    let bin, args, out, onLine;
    if (step.tool === 'calibre') {
      bin = calibreBin;
      out = path.join(stepDir, 'output.' + ext);
      args = [current, out];
      onLine = function (line) {
        const m = /^\s*(\d{1,3}(?:\.\d+)?)%/.exec(line);
        if (!m) return;
        const pct = Math.min(Number(m[1]), 100);
        onProgress(Math.min(99, Math.round(base + (share * pct) / 100)));
      };
    } else if (step.tool === 'soffice') {
      const filter = SOFFICE_FILTER[step.to];
      if (!filter) throw new ConvertError('failed', 'no LibreOffice filter for ' + step.to);
      bin = sofficeBin;
      out = path.join(stepDir, path.basename(current, path.extname(current)) + '.' + ext);
      args = [
        '--headless',
        '--norestore',
        '-env:UserInstallation=' + pathToFileURL(path.join(jobDir, 'lo-profile')).href,
        '--convert-to', filter,
        '--outdir', stepDir,
        current
      ];
    } else {
      throw new ConvertError('failed', 'unknown tool ' + step.tool);
    }

    let result;
    try {
      result = await runTool(bin, args, { deadline: deadline, control: control, onLine: onLine, cwd: stepDir });
    } catch (err) {
      if (err instanceof ConvertError && err.kind !== 'cancelled') {
        console.error('[folio] job ' + label + ' step ' + (i + 1) + ' (' + step.tool + ' ' + step.from + '→' + step.to + ') ' +
          err.kind + ': ' + trimForLog(err.detail));
      }
      throw err;
    }

    if (result.code !== 0 || !nonEmptyFile(out)) {
      const kind = classify(result.output);
      console.error('[folio] job ' + label + ' step ' + (i + 1) + ' (' + step.tool + ' ' + step.from + '→' + step.to + ') failed, exit ' +
        result.code + (nonEmptyFile(out) ? '' : ', no output') + ': ' + trimForLog(result.output));
      throw new ConvertError(kind, result.output);
    }

    onProgress(Math.min(99, Math.round(base + share)));
    current = out;
  }
  return current;
}

// Check a converter is installed by running `<bin> --version`.
function checkTool(bin, timeoutMs) {
  return runTool(bin, ['--version'], { deadline: Date.now() + (timeoutMs || 30000) })
    .then(function (r) { return r.code === 0; })
    .catch(function () { return false; });
}

module.exports = { runPlan, runTool, checkTool, killTree, ConvertError, MESSAGES };
