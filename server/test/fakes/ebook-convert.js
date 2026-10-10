'use strict';

// Fake Calibre `ebook-convert <in> <out>` for tests.
const fs = require('fs');
const path = require('path');
const { sample } = require('./magic');

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('ebook-convert (calibre 7.0.0 fake)');
  process.exit(0);
}

const input = args[0];
const output = args[1];
const content = fs.readFileSync(input);

if (content.includes('DRM-TEST')) {
  console.log('1% Converting input to HTML...');
  console.error('calibre.ebooks.DRMError: This file is locked with DRM.');
  process.exit(1);
}
if (content.includes('BROKEN-TEST')) {
  console.error('Traceback (most recent call last): secret/internal/path.py');
  process.exit(2);
}

function finish() {
  console.log('60% Running transforms on e-book...');
  const to = path.extname(output).slice(1).toUpperCase();
  fs.writeFileSync(output, Buffer.concat([sample(to, 'converted from ' + path.basename(input) + '\n'), content]));
  console.log('Output saved to ' + output);
}

console.log('10% Converting input to HTML...');
if (content.includes('SLOW-TEST')) setTimeout(finish, 60 * 1000);
else finish();
