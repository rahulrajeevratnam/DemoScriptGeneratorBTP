'use strict';

const AdmZip = require('adm-zip');

/**
 * Extracts plain text from a .docx buffer by reading word/document.xml
 * from the zip container and stripping XML tags.
 */
function extractDocxText(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) return '';
    const xml = zip.readAsText(entry);

    return xml
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * Extracts readable text from a PDF buffer by scanning for text inside
 * parentheses in content streams (works for most standard PDFs).
 * Not reliable for scanned/image PDFs.
 */
function extractPdfText(buffer) {
  try {
    const raw = buffer.toString('latin1');

    // Collect all parenthesised strings from PDF content streams
    const chunks = [];
    const re = /\(([^)\\]{2,})\)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const s = m[1].replace(/\\n/g, ' ').replace(/\\r/g, ' ').trim();
      if (s.length > 2 && /[a-zA-Z]/.test(s)) chunks.push(s);
    }

    return chunks.join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Extracts up to 3000 chars of text from a .docx or .pdf template buffer.
 * Returns empty string if the buffer is missing or extraction fails.
 */
function extractTemplateText(buffer, ext) {
  if (!buffer) return '';

  let text = '';
  if (ext === '.docx') {
    text = extractDocxText(buffer);
  } else if (ext === '.pdf') {
    text = extractPdfText(buffer);
  }

  return text.slice(0, 3000);
}

module.exports = { extractTemplateText };
