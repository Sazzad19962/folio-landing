'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { plan } = require('./formats');
const { runPlan, MESSAGES } = require('./convert');

const SWEEP_MS = 60 * 1000;

// Turn the uploaded file's name into a safe download name: same stem, new extension.
function outputNameFor(originalName, to) {
  let stem = String(originalName || '');
  stem = stem.split(/[\\/]/).pop();
  const dot = stem.lastIndexOf('.');
  if (dot > 0) stem = stem.slice(0, dot);
  stem = stem
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  stem = Array.from(stem).slice(0, 120).join('').trim();
  if (!stem) stem = 'converted';
  return stem + '.' + String(to).toLowerCase();
}

function rm(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    console.error('[folio] could not delete ' + target + ': ' + err.message);
  }
}

class JobStore {
  constructor(overrides) {
    this.cfg = Object.assign({}, config, overrides || {});
    this.workDir = path.resolve(this.cfg.workDir);
    this.incomingDir = path.join(this.workDir, '_incoming');
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
    this.timer = null;
  }

  // Wipe and recreate the work directory, then start the sweeper.
  init() {
    const dir = this.workDir;
    if (dir === path.parse(dir).root || dir === path.resolve(os.homedir()) || dir === process.cwd()) {
      throw new Error('Refusing to use ' + dir + ' as WORK_DIR: it gets wiped on startup.');
    }
    rm(dir);
    fs.mkdirSync(this.incomingDir, { recursive: true });
    if (!this.timer) {
      this.timer = setInterval(this.sweep.bind(this), SWEEP_MS);
      this.timer.unref();
    }
    return this;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Converters run in their own process group, so stop them explicitly.
    this.jobs.forEach(function (job) {
      if (job.status === 'converting') job.control.cancel();
    });
  }

  isFull() {
    return this.queue.length >= this.cfg.maxQueue;
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (Date.now() >= job.expiresAt) {
      this.delete(id);
      return null;
    }
    return job;
  }

  // Number of queued jobs ahead of this one (0 = next to run, or already running).
  position(job) {
    const i = this.queue.indexOf(job.id);
    return i === -1 ? 0 : i;
  }

  // Take ownership of an uploaded file and queue it. Returns null when the
  // queue is full (the caller still owns the upload then).
  create(opts) {
    if (this.isFull()) return null;
    const id = crypto.randomUUID();
    const dir = path.join(this.workDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const inputPath = path.join(dir, 'input.' + opts.from.toLowerCase());
    try {
      fs.renameSync(opts.uploadPath, inputPath);
    } catch (err) {
      // Different filesystem: copy instead.
      fs.copyFileSync(opts.uploadPath, inputPath);
      rm(opts.uploadPath);
    }
    const now = Date.now();
    const job = {
      id: id,
      status: 'queued',
      progress: 0,
      from: opts.from,
      to: opts.to,
      originalName: String(opts.originalName || ''),
      outputName: outputNameFor(opts.originalName, opts.to),
      createdAt: now,
      expiresAt: now + this.cfg.retentionMin * 60 * 1000,
      error: null,
      dir: dir,
      inputPath: inputPath,
      outputPath: null,
      control: { cancelled: false, cancel: function () { this.cancelled = true; } },
      deleted: false
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.pump();
    return job;
  }

  pump() {
    while (this.running < this.cfg.concurrency && this.queue.length) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (job && !job.deleted) this.run(job);
    }
  }

  async run(job) {
    this.running++;
    job.status = 'converting';
    job.progress = 0;
    try {
      const out = await runPlan({
        steps: plan(job.from, job.to),
        input: job.inputPath,
        jobDir: job.dir,
        timeoutS: this.cfg.convertTimeoutS,
        calibreBin: this.cfg.calibreBin,
        sofficeBin: this.cfg.sofficeBin,
        control: job.control,
        label: job.id,
        onProgress: function (p) {
          if (p > job.progress) job.progress = p;
        }
      });
      if (job.deleted) return;
      const final = path.join(job.dir, 'result.' + job.to.toLowerCase());
      fs.renameSync(out, final);
      this.clean(job.dir, final);
      job.outputPath = final;
      job.progress = 100;
      job.status = 'done';
    } catch (err) {
      if (job.deleted) return;
      if (!err.friendly) console.error('[folio] job ' + job.id + ' crashed: ' + (err.stack || err));
      job.status = 'error';
      job.error = err.friendly || MESSAGES.failed;
      this.clean(job.dir, null);
    } finally {
      this.running--;
      if (job.deleted) rm(job.dir);
      this.pump();
    }
  }

  // Delete everything in a job directory except the kept file.
  clean(dir, keep) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      return;
    }
    entries.forEach(function (name) {
      const full = path.join(dir, name);
      if (full !== keep) rm(full);
    });
  }

  // Remove a job now: cancels it if queued, kills it if running, deletes its files.
  delete(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.deleted = true;
    this.jobs.delete(id);
    const i = this.queue.indexOf(id);
    if (i !== -1) this.queue.splice(i, 1);
    if (job.status === 'converting') job.control.cancel();
    rm(job.dir);
    return true;
  }

  sweep() {
    const now = Date.now();
    const self = this;
    Array.from(this.jobs.values()).forEach(function (job) {
      if (now >= job.expiresAt) self.delete(job.id);
    });
    // Leftover uploads (aborted requests) and orphaned job directories.
    const maxAge = this.cfg.retentionMin * 60 * 1000;
    [this.incomingDir, this.workDir].forEach(function (dir) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch (e) {
        return;
      }
      names.forEach(function (name) {
        if (dir === self.workDir && (name === '_incoming' || self.jobs.has(name))) return;
        const full = path.join(dir, name);
        try {
          if (now - fs.statSync(full).mtimeMs > maxAge) rm(full);
        } catch (e) {
          // Already gone.
        }
      });
    });
  }
}

let defaultStore = null;

// The process-wide store used by createApp(). Wipes WORK_DIR the first time.
function getStore() {
  if (!defaultStore) defaultStore = new JobStore().init();
  return defaultStore;
}

module.exports = { JobStore, getStore, outputNameFor };
