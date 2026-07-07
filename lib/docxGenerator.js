'use strict';

const {
  Document, Packer, Paragraph, TextRun, ImageRun,
  AlignmentType, BorderStyle, TableRow, TableCell, Table,
  WidthType, ShadingType, convertMillimetersToTwip,
  HeadingLevel
} = require('docx');

const fs = require('fs');
const sharp = require('sharp');

// ─── Layout constants ──────────────────────────────────────────────────────
function pt(n) { return n * 2; }
function mm(n) { return convertMillimetersToTwip(n); }

const FONT = 'Calibri';
const BLACK = '000000';
const WHITE = 'FFFFFF';
const GREY_BG = 'F2F2F2';
const ACCENT = '003366'; // deep navy used for section headings, matching template tone

// ─── Paragraph helpers ─────────────────────────────────────────────────────
function para(text, opts = {}) {
  return new Paragraph({
    heading: opts.heading || undefined,
    children: [new TextRun({
      text,
      font: FONT,
      size: pt(opts.size || 10),
      bold: opts.bold || false,
      color: opts.color || BLACK,
      italics: opts.italic || false,
      underline: opts.underline ? {} : undefined
    })],
    spacing: { before: mm(opts.before || 0), after: mm(opts.after !== undefined ? opts.after : 2) },
    alignment: opts.align || AlignmentType.LEFT,
    indent: opts.indent ? { left: mm(opts.indent) } : undefined
  });
}

function spacer(mmVal = 3) {
  return new Paragraph({ spacing: { after: mm(mmVal) } });
}

function hRule() {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT } },
    spacing: { after: mm(3) }
  });
}

// ─── Section heading (Heading1 style) ─────────────────────────────────────
function sectionHeading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, font: FONT, size: pt(16), bold: true, color: ACCENT })],
    spacing: { before: mm(8), after: mm(2) }
  });
}

// ─── Sub-section heading (Heading2 style) ─────────────────────────────────
function subSectionHeading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, font: FONT, size: pt(13), bold: true, color: BLACK })],
    spacing: { before: mm(6), after: mm(2) }
  });
}

// ─── Sub-sub-section title ─────────────────────────────────────────────────
function subSubHeading(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: FONT, size: pt(11), bold: true, color: BLACK })],
    spacing: { before: mm(4), after: mm(1) }
  });
}

// ─── Action heading: "Action N - SubTitle" ────────────────────────────────
function actionHeading(actionNum, subSectionTitle, stepNum) {
  return new Paragraph({
    children: [new TextRun({
      text: `Action ${actionNum} - ${subSectionTitle}`,
      font: FONT, size: pt(10), bold: true, color: BLACK
    })],
    spacing: { before: mm(4), after: mm(1) },
    border: {
      left: { style: BorderStyle.SINGLE, size: 12, color: ACCENT }
    },
    indent: { left: mm(4) }
  });
}

// ─── Benefits block ────────────────────────────────────────────────────────
function benefitsBlock(benefits) {
  const items = [];
  items.push(para('Benefits', { bold: true, size: 10, after: 1 }));
  for (const b of benefits) {
    items.push(new Paragraph({
      children: [
        new TextRun({ text: '• ', font: FONT, size: pt(10), bold: true, color: ACCENT }),
        new TextRun({ text: b, font: FONT, size: pt(10), color: BLACK })
      ],
      spacing: { after: mm(1) },
      indent: { left: mm(4) }
    }));
  }
  return items;
}

// ─── Persona block ─────────────────────────────────────────────────────────
function personaBlock(persona) {
  const nameCell = new TableCell({
    shading: { fill: GREY_BG, type: ShadingType.CLEAR },
    children: [
      new Paragraph({
        children: [new TextRun({ text: persona.name || 'User', font: FONT, size: pt(10), bold: true, color: BLACK })],
        spacing: { before: mm(2), after: mm(0.5) }
      }),
      new Paragraph({
        children: [new TextRun({ text: persona.role || 'Process Manager', font: FONT, size: pt(9), color: '555555' })],
        spacing: { after: mm(2) }
      })
    ],
    margins: { left: mm(3), right: mm(3) }
  });

  const iconCell = new TableCell({
    width: { size: mm(16), type: WidthType.DXA },
    shading: { fill: ACCENT, type: ShadingType.CLEAR },
    children: [new Paragraph({
      children: [new TextRun({ text: '👤', size: pt(16) })],
      alignment: AlignmentType.CENTER,
      spacing: { before: mm(2), after: mm(2) }
    })]
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: [iconCell, nameCell] })],
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideH: { style: BorderStyle.NONE }, insideV: { style: BorderStyle.NONE }
    }
  });
}

// ─── Numbered sub-action ───────────────────────────────────────────────────
function numberedAction(num, text) {
  return new Paragraph({
    children: [
      new TextRun({ text: `${num}. `, font: FONT, size: pt(10), bold: true, color: BLACK }),
      new TextRun({ text, font: FONT, size: pt(10), color: BLACK })
    ],
    spacing: { after: mm(1) },
    indent: { left: mm(5) }
  });
}

// ─── Talk track ────────────────────────────────────────────────────────────
function talkTrack(text) {
  if (!text) return null;
  return new Paragraph({
    children: [new TextRun({ text, font: FONT, size: pt(10), italics: true, color: '555555' })],
    spacing: { after: mm(2) }
  });
}

// ─── Screenshot ────────────────────────────────────────────────────────────
async function screenshotPara(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return new Paragraph({
      children: [new TextRun({ text: '[Screenshot not available]', font: FONT, size: pt(9), color: '999999', italics: true })],
      spacing: { after: mm(4) }
    });
  }

  let imageBuffer;
  try { imageBuffer = fs.readFileSync(imagePath); } catch {
    return new Paragraph({
      children: [new TextRun({ text: '[Screenshot could not be read]', font: FONT, size: pt(9), color: '999999', italics: true })],
      spacing: { after: mm(4) }
    });
  }

  let srcWidth = 1440, srcHeight = 900;
  try {
    const meta = await sharp(imageBuffer).metadata();
    srcWidth = meta.width || 1440;
    srcHeight = meta.height || 900;
  } catch {}

  // A4 with 20mm margins: 170mm content width ≈ 643px at 96dpi. This is only
  // the DISPLAY box — imageBuffer below is embedded at its full native
  // resolution, so a higher-res source (see frameExtractor's
  // screenshotFrames) renders crisper on zoom/print without any change here.
  const TARGET_W = 643;
  const TARGET_H = Math.round(TARGET_W * (srcHeight / srcWidth));

  return new Paragraph({
    children: [new ImageRun({ data: imageBuffer, transformation: { width: TARGET_W, height: TARGET_H } })],
    spacing: { after: mm(5) },
    alignment: AlignmentType.CENTER
  });
}

// ─── Cover page ────────────────────────────────────────────────────────────
function buildCoverPage(description, processHierarchy) {
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  return [
    spacer(25),
    new Paragraph({
      children: [new TextRun({ text: 'SAP Interactive Demo Script', font: FONT, size: pt(30), bold: true, color: ACCENT })],
      alignment: AlignmentType.CENTER,
      spacing: { after: mm(6) }
    }),
    new Paragraph({
      children: [new TextRun({ text: description, font: FONT, size: pt(20), bold: true, color: BLACK })],
      alignment: AlignmentType.CENTER,
      spacing: { after: mm(10) }
    }),
    hRule(),
    spacer(4),
    para('Process', { bold: true, size: 10 }),
    para(processHierarchy || description, { size: 10, color: '333333', after: 4 }),
    spacer(16),
    para(`Generated: ${today}`, { size: 9, color: '888888', align: AlignmentType.RIGHT }),
    new Paragraph({ children: [], pageBreakBefore: true })
  ];
}

// ─── Overview section ──────────────────────────────────────────────────────
function buildOverview(description, scriptData) {
  const items = [];
  items.push(sectionHeading('Overview'));
  items.push(hRule());
  items.push(para(
    `This demo script documents the ${description} process. ` +
    `The following sections walk through each step with annotated screenshots and presenter guidance.`,
    { size: 10, after: 4 }
  ));

  // Table of contents — list sections
  items.push(para('Contents', { bold: true, size: 10, after: 2 }));
  for (const section of scriptData) {
    const subCount = (section.subSections || []).length;
    items.push(new Paragraph({
      children: [
        new TextRun({ text: `${section.sectionNumber}  `, font: FONT, size: pt(10), bold: true }),
        new TextRun({ text: section.sectionTitle, font: FONT, size: pt(10) }),
        new TextRun({ text: ` (${subCount} sub-section${subCount !== 1 ? 's' : ''})`, font: FONT, size: pt(9), color: '666666' })
      ],
      spacing: { after: mm(1) },
      indent: { left: mm(4) }
    }));
  }
  items.push(spacer(6));
  items.push(new Paragraph({ children: [], pageBreakBefore: true }));
  return items;
}

// ─── Main generator ────────────────────────────────────────────────────────
async function generateDocx({ scriptData, annotatedMap, description, log }) {
  let processHierarchy = '';
  for (const sec of scriptData) {
    if (sec.processHierarchy) { processHierarchy = sec.processHierarchy; break; }
  }

  log('   Building document structure...');
  const children = [];

  children.push(...buildCoverPage(description, processHierarchy));
  children.push(...buildOverview(description, scriptData));

  let stepGlobal = 0;

  for (const section of scriptData) {
    // ── Section heading ──────────────────────────────────────────────────
    children.push(sectionHeading(`${section.sectionNumber}. ${section.sectionTitle}`));
    children.push(hRule());
    if (section.sectionDescription) {
      children.push(para(section.sectionDescription, { size: 10, after: 4 }));
    }
    if (section.processHierarchy) {
      children.push(para(`Process: ${section.processHierarchy}`, { size: 9, italic: true, color: '555555', after: 4 }));
    }

    let sectionActionCounter = 0;

    for (const subSection of section.subSections) {
      // ── Sub-section heading ────────────────────────────────────────────
      children.push(subSectionHeading(`${subSection.subSectionNumber}. ${subSection.subSectionTitle}`));

      // ── Sub-sub-section number + title ────────────────────────────────
      // Format matches template: "3.1.1. Activity Title"
      const subSubLabel = [subSection.subSectionNumber, subSection.activityTitle]
        .filter(Boolean).join('. ');
      if (subSubLabel) children.push(subSubHeading(subSubLabel));

      // ── Benefits (before persona and activity description) ────────────
      if (subSection.benefits && subSection.benefits.length > 0) {
        children.push(...benefitsBlock(subSection.benefits));
        children.push(spacer(3));
      }

      // ── Persona ───────────────────────────────────────────────────────
      if (subSection.persona) {
        children.push(para('Persona', { bold: true, size: 10, after: 1 }));
        children.push(personaBlock(subSection.persona));
        children.push(spacer(3));
      }

      // ── Activity description (after benefits + persona) ───────────────
      if (subSection.activityDescription) {
        children.push(para(subSection.activityDescription, { size: 10, after: 3 }));
      }

      // ── Action steps ──────────────────────────────────────────────────
      for (const action of subSection.actions) {
        stepGlobal++;
        sectionActionCounter++;
        const stepKey = `step_${stepGlobal}`;

        // Use activityTitle for action heading (matches template), fall back to subSectionTitle
        const actionSubtitle = subSection.activityTitle || subSection.subSectionTitle;
        children.push(actionHeading(sectionActionCounter, actionSubtitle, action.stepNumber || sectionActionCounter));

        const tt = talkTrack(action.talkTrack);
        if (tt) children.push(tt);

        for (let i = 0; i < (action.subActions || []).length; i++) {
          children.push(numberedAction(i + 1, action.subActions[i]));
        }

        children.push(await screenshotPara(annotatedMap[stepKey]));
        action._screenshotKey = stepKey;
      }

      children.push(spacer(6));
    }

    // Page break between sections
    children.push(new Paragraph({ children: [], pageBreakBefore: true }));
  }

  const doc = new Document({
    styles: {
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'heading 1',
          basedOn: 'Normal',
          run: { font: FONT, size: pt(16), bold: true, color: ACCENT },
          paragraph: { spacing: { before: mm(8), after: mm(2) } }
        },
        {
          id: 'Heading2',
          name: 'heading 2',
          basedOn: 'Normal',
          run: { font: FONT, size: pt(13), bold: true, color: BLACK },
          paragraph: { spacing: { before: mm(6), after: mm(2) } }
        }
      ]
    },
    sections: [{
      properties: {
        page: {
          size: { width: mm(210), height: mm(297) },
          margin: { top: mm(20), bottom: mm(20), left: mm(20), right: mm(20) }
        }
      },
      children
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  log('   Document built in memory');
  return buffer;
}

module.exports = generateDocx;
