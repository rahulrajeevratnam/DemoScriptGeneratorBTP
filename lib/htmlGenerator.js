'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function imageToBase64(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  try {
    const buf = await sharp(imagePath)
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch { return null; }
}

async function generateHtml({ scriptData, annotatedMap, description, outputPath, log }) {
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

  let processHierarchy = '';
  for (const sec of scriptData) {
    if (sec.processHierarchy) { processHierarchy = sec.processHierarchy; break; }
  }

  // Pre-load all images as base64
  log('   Embedding screenshots into HTML...');
  const imageMap = {};
  for (const [key, imgPath] of Object.entries(annotatedMap)) {
    imageMap[key] = await imageToBase64(imgPath);
  }

  // Build navigation items
  const navItems = scriptData.map(sec => `
    <li>
      <a href="#sec-${sec.sectionNumber.replace(/\./g, '-')}" class="nav-section">${sec.sectionNumber}. ${escHtml(sec.sectionTitle)}</a>
      <ul>
        ${(sec.subSections || []).map(sub => `
          <li><a href="#sub-${sub.subSectionNumber.replace(/\./g, '-')}">${sub.subSectionNumber} ${escHtml(sub.subSectionTitle)}</a></li>
        `).join('')}
      </ul>
    </li>
  `).join('');

  // Build content
  let stepGlobal = 0;
  let contentHtml = '';

  for (const section of scriptData) {
    const secId = 'sec-' + section.sectionNumber.replace(/\./g, '-');
    contentHtml += `
      <section id="${secId}" class="section-block">
        <h2 class="section-heading">${escHtml(section.sectionNumber + '. ' + section.sectionTitle)}</h2>
        ${section.sectionDescription ? `<p class="section-desc">${escHtml(section.sectionDescription)}</p>` : ''}
        ${section.processHierarchy ? `<div class="process-path">&#8250; ${escHtml(section.processHierarchy)}</div>` : ''}
    `;

    let sectionActionCounter = 0;

    for (const subSection of section.subSections) {
      const subId = 'sub-' + subSection.subSectionNumber.replace(/\./g, '-');
      const subSubLabel = [subSection.subSectionNumber, subSection.activityTitle].filter(Boolean).join('. ');

      contentHtml += `<div id="${subId}" class="subsection-block">`;
      contentHtml += `<h3 class="subsection-heading">${escHtml(subSection.subSectionNumber + '. ' + subSection.subSectionTitle)}</h3>`;

      if (subSubLabel) {
        contentHtml += `<h4 class="activity-heading">${escHtml(subSubLabel)}</h4>`;
      }

      // Benefits
      if (subSection.benefits && subSection.benefits.length > 0) {
        contentHtml += `<div class="benefits-block"><div class="benefits-label">Benefits</div><ul class="benefits-list">`;
        for (const b of subSection.benefits) {
          contentHtml += `<li>${escHtml(b)}</li>`;
        }
        contentHtml += `</ul></div>`;
      }

      // Persona
      if (subSection.persona) {
        contentHtml += `
          <div class="persona-block">
            <div class="persona-avatar">👤</div>
            <div class="persona-info">
              <div class="persona-name">${escHtml(subSection.persona.name || '')}</div>
              <div class="persona-role">${escHtml(subSection.persona.role || '')}</div>
            </div>
          </div>`;
      }

      // Activity description
      if (subSection.activityDescription) {
        contentHtml += `<p class="activity-desc">${escHtml(subSection.activityDescription)}</p>`;
      }

      // Actions
      for (const action of subSection.actions) {
        stepGlobal++;
        sectionActionCounter++;
        const stepKey = `step_${stepGlobal}`;
        const actionSubtitle = subSection.activityTitle || subSection.subSectionTitle;
        const imgData = imageMap[stepKey];

        contentHtml += `<div class="action-block">`;
        contentHtml += `<div class="action-heading">Action ${sectionActionCounter} &mdash; ${escHtml(actionSubtitle)}</div>`;

        if (action.talkTrack) {
          contentHtml += `<div class="talk-track">${escHtml(action.talkTrack)}</div>`;
        }

        if (action.subActions && action.subActions.length > 0) {
          contentHtml += `<ol class="sub-actions">`;
          for (const sa of action.subActions) {
            contentHtml += `<li>${escHtml(sa)}</li>`;
          }
          contentHtml += `</ol>`;
        }

        if (imgData) {
          contentHtml += `<div class="screenshot-wrap"><img src="${imgData}" alt="Step ${sectionActionCounter} screenshot" class="screenshot" /></div>`;
        } else {
          contentHtml += `<div class="screenshot-missing">Screenshot not available</div>`;
        }

        contentHtml += `</div>`;
      }

      contentHtml += `</div>`; // subsection-block
    }

    contentHtml += `</section>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(description)} — Demo Script</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --navy: #003366;
    --navy-light: #e8eef5;
    --accent: #0070F2;
    --text: #1a1a1a;
    --muted: #555;
    --border: #dde3ea;
    --bg: #f5f7fa;
    --card: #ffffff;
    --benefit-bg: #f0f7ff;
    --action-border: #003366;
  }

  body { font-family: Calibri, 'Segoe UI', Arial, sans-serif; background: var(--bg); color: var(--text); display: flex; min-height: 100vh; }

  /* Sidebar */
  .sidebar {
    width: 280px; min-width: 280px; background: var(--navy); color: #fff;
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
    display: flex; flex-direction: column;
  }
  .sidebar-header { padding: 1.5rem 1.25rem 1rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
  .sidebar-header .logo { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.12em; color: rgba(255,255,255,0.5); text-transform: uppercase; margin-bottom: 4px; }
  .sidebar-header .title { font-size: 0.88rem; font-weight: 600; line-height: 1.4; }
  .sidebar nav { padding: 1rem 0; flex: 1; }
  .sidebar nav ul { list-style: none; }
  .sidebar nav > ul > li { margin-bottom: 2px; }
  .sidebar nav a { display: block; padding: 6px 1.25rem; font-size: 0.8rem; color: rgba(255,255,255,0.75); text-decoration: none; transition: all 0.15s; border-left: 3px solid transparent; }
  .sidebar nav a:hover { color: #fff; background: rgba(255,255,255,0.08); border-left-color: rgba(255,255,255,0.4); }
  .sidebar nav a.nav-section { font-weight: 700; font-size: 0.82rem; color: rgba(255,255,255,0.9); }
  .sidebar nav ul ul { margin-left: 0; }
  .sidebar nav ul ul a { padding-left: 2rem; font-size: 0.77rem; color: rgba(255,255,255,0.55); }
  .sidebar nav ul ul a:hover { color: rgba(255,255,255,0.9); }
  .sidebar-footer { padding: 1rem 1.25rem; border-top: 1px solid rgba(255,255,255,0.1); font-size: 0.72rem; color: rgba(255,255,255,0.4); }

  /* Content */
  .content { flex: 1; max-width: 960px; padding: 2.5rem 3rem; overflow-x: hidden; }

  /* Cover */
  .cover { margin-bottom: 3rem; padding-bottom: 2rem; border-bottom: 3px solid var(--navy); }
  .cover .label { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); margin-bottom: 0.5rem; }
  .cover h1 { font-size: 2rem; font-weight: 700; color: var(--navy); line-height: 1.25; margin-bottom: 0.75rem; }
  .cover .meta { display: flex; gap: 2rem; flex-wrap: wrap; margin-top: 1rem; }
  .cover .meta-item { font-size: 0.85rem; color: var(--muted); }
  .cover .meta-item strong { color: var(--text); display: block; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }

  /* Sections */
  .section-block { margin-bottom: 3rem; }
  .section-heading { font-size: 1.45rem; font-weight: 700; color: var(--navy); padding-bottom: 0.5rem; border-bottom: 2px solid var(--navy); margin-bottom: 0.75rem; }
  .section-desc { font-size: 0.92rem; color: var(--muted); margin-bottom: 0.5rem; line-height: 1.6; }
  .process-path { font-size: 0.8rem; color: var(--accent); margin-bottom: 1.5rem; font-style: italic; }

  /* Sub-sections */
  .subsection-block { margin-bottom: 2.5rem; padding-left: 0; }
  .subsection-heading { font-size: 1.15rem; font-weight: 700; color: var(--text); margin-bottom: 0.4rem; margin-top: 1.5rem; }
  .activity-heading { font-size: 1rem; font-weight: 600; color: var(--navy); margin-bottom: 1rem; }
  .activity-desc { font-size: 0.9rem; color: var(--muted); margin-bottom: 1rem; line-height: 1.6; }

  /* Benefits */
  .benefits-block { background: var(--benefit-bg); border-left: 3px solid var(--accent); border-radius: 6px; padding: 0.9rem 1.1rem; margin-bottom: 1rem; }
  .benefits-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent); margin-bottom: 0.4rem; }
  .benefits-list { list-style: none; }
  .benefits-list li { font-size: 0.88rem; color: var(--text); padding: 2px 0; padding-left: 1rem; position: relative; }
  .benefits-list li::before { content: '✓'; position: absolute; left: 0; color: var(--accent); font-weight: 700; }

  /* Persona */
  .persona-block { display: flex; align-items: center; gap: 0.9rem; background: #f8f9fa; border: 1px solid var(--border); border-radius: 8px; padding: 0.7rem 1rem; margin-bottom: 1rem; width: fit-content; }
  .persona-avatar { width: 38px; height: 38px; background: var(--navy); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; flex-shrink: 0; }
  .persona-name { font-weight: 700; font-size: 0.9rem; }
  .persona-role { font-size: 0.8rem; color: var(--muted); }

  /* Actions */
  .action-block { background: var(--card); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 1.5rem; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
  .action-heading { background: var(--navy); color: #fff; padding: 0.65rem 1.1rem; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.02em; }
  .talk-track { padding: 0.75rem 1.1rem 0; font-size: 0.88rem; color: var(--muted); font-style: italic; line-height: 1.6; }
  .sub-actions { padding: 0.75rem 1.1rem; list-style: decimal; padding-left: 2.5rem; }
  .sub-actions li { font-size: 0.88rem; padding: 3px 0; line-height: 1.5; }
  .screenshot-wrap { padding: 0.75rem 1.1rem 1rem; }
  .screenshot { width: 100%; border-radius: 6px; border: 1px solid var(--border); display: block; }
  .screenshot-missing { padding: 1.5rem; text-align: center; font-size: 0.82rem; color: #aaa; font-style: italic; background: #fafafa; }

  @media (max-width: 900px) {
    body { flex-direction: column; }
    .sidebar { width: 100%; height: auto; position: static; }
    .content { padding: 1.5rem; }
  }
  @media print {
    .sidebar { display: none; }
    .action-block { break-inside: avoid; }
  }
</style>
</head>
<body>

<nav class="sidebar">
  <div class="sidebar-header">
    <div class="logo">SAP Demo Script</div>
    <div class="title">${escHtml(description)}</div>
  </div>
  <nav>
    <ul>
      <li><a href="#cover" class="nav-section">Overview</a></li>
      ${navItems}
    </ul>
  </nav>
  <div class="sidebar-footer">Generated ${today}</div>
</nav>

<div class="content">
  <div class="cover" id="cover">
    <div class="label">SAP Interactive Demo Script</div>
    <h1>${escHtml(description)}</h1>
    <div class="meta">
      ${processHierarchy ? `<div class="meta-item"><strong>Process</strong>${escHtml(processHierarchy)}</div>` : ''}
      <div class="meta-item"><strong>Generated</strong>${today}</div>
      <div class="meta-item"><strong>Sections</strong>${scriptData.length}</div>
    </div>
  </div>

  ${contentHtml}
</div>

</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
  log(`   HTML document saved to ${path.basename(outputPath)}`);
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = generateHtml;
