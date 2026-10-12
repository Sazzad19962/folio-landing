'use strict';

// Minimal file contents that pass formats.looksLike() for each format.
function sample(format, text) {
  const body = Buffer.from(text || 'Folio test file');
  switch (format) {
    case 'PDF':
      return Buffer.concat([Buffer.from('%PDF-1.4\n'), body, Buffer.from('\n%%EOF\n')]);
    case 'EPUB':
    case 'DOCX':
      return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('mimetype'), body]);
    case 'DOC':
      return Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), body]);
    case 'MOBI':
    case 'AZW3': {
      const head = Buffer.alloc(78, 0x20);
      head.write('BOOKMOBI', 60, 'latin1');
      return Buffer.concat([head, body]);
    }
    case 'TXT':
      return body;
    case 'PNG':
      // Signature plus the start of an IHDR chunk, as in a real PNG.
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.from('IHDR'), body]);
    default:
      throw new Error('no sample for ' + format);
  }
}

module.exports = { sample };
