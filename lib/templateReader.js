'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Extracts plain text from a .docx file by unzipping word/document.xml
 * and stripping XML tags.
 */
function extractDocxText(filePath) {
  try {
    const xml = execSync(`unzip -p "${filePath}" word/document.xml`, {
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024
    }).toString('utf8');

    return xml
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * Extracts readable text from a PDF by scanning for text inside
 * parentheses in content streams (works for most standard PDFs).
 * Not reliable for scanned/image PDFs.
 */
function extractPdfText(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'latin1');

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
 * Extracts up to 3000 chars of text from a .docx or .pdf template.
 * Returns empty string if path is invalid or extraction fails.
 */
function extractTemplateText(templatePath) {
  if (!templatePath || !fs.existsSync(templatePath)) return '';

  const ext = path.extname(templatePath).toLowerCase();
  let text = '';

  if (ext === '.docx') {
    text = extractDocxText(templatePath);
  } else if (ext === '.pdf') {
    text = extractPdfText(templatePath);
  }

  return text.slice(0, 3000);
}

module.exports = { extractTemplateText };
