'use strict';

// Fake LibreOffice `soffice --headless ... --convert-to <filter> --outdir <dir> <in>` for tests.
const fs = require('fs');
const path = require('path');
const { sample } = require('./magic');

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('LibreOffice 24.2 fake');
  process.exit(0);
}

let filter = null;
let outdir = null;
let input = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--convert-to') filter = args[++i];
  else if (args[i] === '--outdir') outdir = args[++i];
  else if (!args[i].startsWith('-')) input = args[i];
}
if (!filter || !outdir || !input || !args.some(function (a) { return a.startsWith('-env:UserInstallation=file:'); })) {
  console.error('bad arguments: ' + args.join(' '));
  process.exit(1);
}

const ext = filter.split(':')[0];
const content = fs.readFileSync(input);
const out = path.join(outdir, path.basename(input, path.extname(input)) + '.' + ext);
console.log('convert ' + input + ' -> ' + out + ' using filter : ' + filter);
fs.writeFileSync(out, Buffer.concat([sample(ext.toUpperCase(), 'soffice\n'), content]));
