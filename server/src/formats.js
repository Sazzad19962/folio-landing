'use strict';

const fs = require('fs');

// Formats the converter accepts and produces. Keep in sync with the
// "From" and "To" lists in index.html.
const SOURCES = ['PDF', 'EPUB', 'MOBI', 'AZW3', 'DOCX', 'DOC', 'TXT'];
const TARGETS = ['EPUB', 'MOBI', 'AZW3', 'PDF', 'DOCX', 'DOC'];
const WORD = ['DOCX', 'DOC'];

const MIME = {
  PDF: 'application/pdf',
  EPUB: 'application/epub+zip',
  MOBI: 'application/x-mobipocket-ebook',
  AZW3: 'application/vnd.amazon.ebook',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  DOC: 'application/msword',
  TXT: 'text/plain'
};

// LibreOffice export filters for --convert-to.
const SOFFICE_FILTER = {
  PDF: 'pdf:writer_pdf_Export',
  DOCX: 'docx:MS Word 2007 XML',
  DOC: 'doc:MS Word 97'
};

function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i + 1).toUpperCase() : '';
}

function readHead(file, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// Check the file's first bytes, so a renamed image or program is rejected
// before it reaches the converters.
function looksLike(ext, file) {
  const head = readHead(file, 1024);
  const zip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  switch (ext) {
    case 'PDF':
      return head.indexOf('%PDF-') !== -1;
    case 'EPUB':
    case 'DOCX':
      return zip;
    case 'DOC':
      return head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    case 'MOBI':
    case 'AZW3': {
      const tag = head.subarray(60, 68).toString('latin1');
      return tag === 'BOOKMOBI' || tag === 'TEXtREAd';
    }
    case 'TXT':
      return head.indexOf(0) === -1;
    default:
      return false;
  }
}

// The steps needed to get from one format to another. Calibre handles ebooks;
// LibreOffice handles Word files, and gives much better PDFs from Word.
function plan(from, to) {
  if (from === to) return [];
  const steps = [];
  let current = from;

  if (WORD.indexOf(from) !== -1 && (to === 'PDF' || WORD.indexOf(to) !== -1)) {
    return [{ tool: 'soffice', from: from, to: to }];
  }
  if (current === 'DOC') {
    // Calibre can't read .doc, so turn it into .docx first.
    steps.push({ tool: 'soffice', from: 'DOC', to: 'DOCX' });
    current = 'DOCX';
  }
  if (to === 'DOC') {
    // Calibre can't write .doc, so write .docx and let LibreOffice finish.
    if (current !== 'DOCX') steps.push({ tool: 'calibre', from: current, to: 'DOCX' });
    steps.push({ tool: 'soffice', from: 'DOCX', to: 'DOC' });
    return steps;
  }
  if (current !== to) steps.push({ tool: 'calibre', from: current, to: to });
  return steps;
}

module.exports = { SOURCES, TARGETS, WORD, MIME, SOFFICE_FILTER, extOf, looksLike, plan };
