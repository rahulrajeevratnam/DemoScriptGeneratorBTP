'use strict';

// Experimental, isolated pipeline for comparing screenshot/action-detection
// quality against the primary lib/pipeline.js (Claude + ffmpeg scene
// detection). Skips scene-detection/frame-batching entirely — Gemini
// analyses the whole video natively and returns a timestamp per action,
// which we then grab a single native-resolution frame for. Reuses the
// existing annotator/docxGenerator/htmlGenerator unchanged.

const path = require('path');
const os = require('os');
const fs = require('fs');
const analyseVideoNative = require('./geminiVideoAnalyser');
const { extractFrameAtTimestamp } = require('./frameExtractor');
const annotateScreenshots = require('./annotator');
const generateDocx = require('./docxGenerator');
const { extractTemplateText } = require('./templateReader');
const { checkVideoQuality } = require('./videoQualityCheck');
const generateHtml = require('./htmlGenerator');
const objectStore = require('./objectStore');

const DEFAULT_TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'DemoScript_Template.docx');

async function run({ jobId, videoPath, videoUploadKey, description, template, generateHtmlOutput, jobs }) {
  const log = (message, type = 'info') => {
    jobs[jobId].logs.push({ type, message });
  };

  const tmpRoot = path.join(os.tmpdir(), 'demoscript-gemini', jobId);
  const screenshotsDir = path.join(tmpRoot, 'screenshots');
  const annotatedDir = path.join(tmpRoot, 'annotated');
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(annotatedDir, { recursive: true });

  // Stage 0: Video quality check
  log('🔍 Checking video quality...');
  const quality = await checkVideoQuality(videoPath);
  log(`✅ Video OK — ${quality.width}×${quality.height}, ${quality.duration}s, ${quality.fps}fps`);

  // Resolve template — same logic as the primary pipeline
  let templateBuffer = null;
  let templateExt = '.docx';
  let templateLabel = null;
  if (template) {
    const filename = path.basename(template);
    templateExt = path.extname(filename).toLowerCase();
    templateLabel = filename;
    try {
      templateBuffer = await objectStore.getObjectBuffer(`templates/${filename}`);
    } catch (err) {
      log(`   ⚠️  Could not load template "${filename}" from Object Store: ${err.message}`, 'warn');
    }
  } else if (fs.existsSync(DEFAULT_TEMPLATE_PATH)) {
    templateBuffer = fs.readFileSync(DEFAULT_TEMPLATE_PATH);
    templateExt = '.docx';
    templateLabel = path.basename(DEFAULT_TEMPLATE_PATH);
  }
  const templateText = extractTemplateText(templateBuffer, templateExt);
  if (templateText) {
    log(`📋 Template loaded: ${templateLabel} (${templateText.length} chars of context)`);
  }

  // Step 1: Send video directly to Gemini for native video analysis
  log('🤖 Sending video directly to Gemini (this may take a minute)...');
  const scriptData = await analyseVideoNative(videoPath, description, log, templateText, quality.duration);
  const totalSteps = scriptData.reduce((s, sec) =>
    s + (sec.subSections || []).reduce((ss, sub) => ss + (sub.actions || []).length, 0), 0);
  log(`✅ AI analysis complete — found ${scriptData.length} section(s), ${totalSteps} step(s)`);

  // Step 2: Grab one native-resolution frame per AI-identified timestamp
  log('🖼️  Extracting native-resolution screenshots at AI-identified timestamps...');
  const screenshotMap = await buildTimestampScreenshots({ scriptData, videoPath, screenshotsDir, log });
  log(`✅ ${Object.keys(screenshotMap).length} screenshot(s) ready`);

  // Step 3: Annotate
  log('🎨 Annotating screenshots with callouts...');
  const annotatedMap = await annotateScreenshots({ scriptData, screenshotMap, annotatedDir, log });
  log('✅ Annotation complete');

  // Step 4: Generate docx and upload to Object Store
  log('📄 Generating demo script document...');
  const timestamp = Date.now();
  const docxFilename = `DemoScript_gemini_${timestamp}.docx`;
  const docxBuffer = await generateDocx({ scriptData, annotatedMap, description, log });
  await objectStore.putObject(
    `output/${docxFilename}`,
    docxBuffer,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  log(`✅ Demo script generated: ${docxFilename}`);

  // Step 4b: Generate HTML (optional)
  let htmlFilename = null;
  if (generateHtmlOutput) {
    log('🌐 Generating HTML5 demo script...');
    htmlFilename = `DemoScript_gemini_${timestamp}.html`;
    const htmlString = await generateHtml({ scriptData, annotatedMap, description, log });
    await objectStore.putObject(`output/${htmlFilename}`, Buffer.from(htmlString, 'utf8'), 'text/html');
    log(`✅ HTML demo script generated: ${htmlFilename}`);
  }

  // Step 5: Cleanup
  log('🧹 Cleaning up temporary files...');
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.unlinkSync(videoPath);
  } catch {}
  if (videoUploadKey) {
    try { await objectStore.deleteObject(videoUploadKey); } catch {}
  }
  log('✅ Done');

  return { docxFilename, htmlFilename };
}

async function buildTimestampScreenshots({ scriptData, videoPath, screenshotsDir, log }) {
  const screenshotMap = {};
  let stepGlobal = 0;

  for (const section of scriptData) {
    for (const subSection of section.subSections) {
      for (const action of subSection.actions) {
        stepGlobal++;
        const stepKey = `step_${stepGlobal}`;
        const ts = typeof action.timestamp === 'number' ? action.timestamp : 0;
        const destPath = path.join(screenshotsDir, `${stepKey}.jpg`);

        try {
          await extractFrameAtTimestamp(videoPath, ts, destPath);
          screenshotMap[stepKey] = destPath;
          log(`   Step ${stepGlobal}: "${action.title}" — t=${ts.toFixed(1)}s`);
        } catch (err) {
          log(`   ⚠️  Could not grab frame at ${ts.toFixed(1)}s for step ${stepGlobal}: ${err.message}`, 'warn');
        }
        action._screenshotKey = stepKey;
      }
    }
  }

  return screenshotMap;
}

module.exports = { run };
