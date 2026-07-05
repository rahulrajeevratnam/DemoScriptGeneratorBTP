'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const extractFrames = require('./frameExtractor');
const analyseVideo = require('./aiAnalyser');
const annotateScreenshots = require('./annotator');
const generateDocx = require('./docxGenerator');
const { pickFrameForStep } = require('./framePicker');
const { extractTemplateText } = require('./templateReader');
const { checkVideoQuality } = require('./videoQualityCheck');
const generateHtml = require('./htmlGenerator');
const objectStore = require('./objectStore');

// Bundled default template — ships with the app image, identical on every
// instance, so it can safely stay on local disk (it's not user data).
const DEFAULT_TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'DemoScript_Template.docx');

async function run({ jobId, videoPath, videoUploadKey, description, template, generateHtmlOutput, jobs }) {
  const log = (message, type = 'info') => {
    jobs[jobId].logs.push({ type, message });
  };

  // Frames/screenshots/annotated images are transient per-run processing
  // artifacts — fine to live in the container's local tmpdir even though
  // it resets on restart or isn't shared across instances.
  const tmpRoot = path.join(os.tmpdir(), 'demoscript', jobId);
  const framesDir = path.join(tmpRoot, 'frames');
  const screenshotsDir = path.join(tmpRoot, 'screenshots');
  const annotatedDir = path.join(tmpRoot, 'annotated');

  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(annotatedDir, { recursive: true });

  // Stage 0: Video quality check
  log('🔍 Checking video quality...');
  const quality = await checkVideoQuality(videoPath);
  log(`✅ Video OK — ${quality.width}×${quality.height}, ${quality.duration}s, ${quality.fps}fps`);

  // Step 1: Extract frames
  log('📽️  Extracting frames from video...');
  const frames = await extractFrames(videoPath, framesDir, log);
  log(`✅ Extracted ${frames.length} frame(s)`);

  // Resolve template — fetch user-uploaded template from Object Store,
  // or fall back to the bundled default template on local disk.
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

  // Step 2: AI analysis
  log('🤖 Analysing video with AI (this may take a minute)...');
  const scriptData = await analyseVideo(frames, description, log, templateText);
  const totalSteps = scriptData.reduce((s, sec) =>
    s + (sec.subSections || []).reduce((ss, sub) => ss + (sub.actions || []).length, 0), 0);
  log(`✅ AI analysis complete — found ${scriptData.length} section(s), ${totalSteps} step(s)`);

  // Step 3: Map video frames to steps
  log('🖼️  Mapping video frames to script steps...');
  const screenshotMap = await buildFrameScreenshots({ scriptData, frames, screenshotsDir, log });
  log(`✅ ${Object.keys(screenshotMap).length} screenshot(s) ready`);

  // Step 4: Annotate
  log('🎨 Annotating screenshots with callouts...');
  const annotatedMap = await annotateScreenshots({ scriptData, screenshotMap, annotatedDir, log });
  log('✅ Annotation complete');

  // Step 5: Generate docx and upload to Object Store
  log('📄 Generating demo script document...');
  const timestamp = Date.now();
  const docxFilename = `DemoScript_${timestamp}.docx`;
  const docxBuffer = await generateDocx({ scriptData, annotatedMap, description, log });
  const docxKey = `output/${docxFilename}`;
  await objectStore.putObject(
    docxKey,
    docxBuffer,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  log(`✅ Demo script generated: ${docxFilename}`);

  // Step 5b: Generate HTML (optional)
  let htmlFilename = null;
  if (generateHtmlOutput) {
    log('🌐 Generating HTML5 demo script...');
    htmlFilename = `DemoScript_${timestamp}.html`;
    const htmlString = await generateHtml({ scriptData, annotatedMap, description, log });
    await objectStore.putObject(`output/${htmlFilename}`, Buffer.from(htmlString, 'utf8'), 'text/html');
    log(`✅ HTML demo script generated: ${htmlFilename}`);
  }

  // Step 6: Cleanup
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

async function buildFrameScreenshots({ scriptData, frames, screenshotsDir, log }) {
  const sharp = require('sharp');
  const screenshotMap = {};
  let stepGlobal = 0;

  const totalSteps = scriptData.reduce((s, sec) =>
    s + sec.subSections.reduce((ss, sub) => ss + sub.actions.length, 0), 0);

  for (const section of scriptData) {
    for (const subSection of section.subSections) {
      for (const action of subSection.actions) {
        stepGlobal++;
        const stepKey = `step_${stepGlobal}`;
        const frameIdx = pickFrameForStep(action.frameNumber, stepGlobal, totalSteps, frames.length);
        const sourcePath = frames[frameIdx];

        if (!sourcePath || !fs.existsSync(sourcePath)) {
          log(`   ⚠️  No frame available for step ${stepGlobal}`, 'warn');
          continue;
        }

        const destPath = path.join(screenshotsDir, `${stepKey}.png`);
        try {
          await sharp(sourcePath).png().toFile(destPath);
          screenshotMap[stepKey] = destPath;
          log(`   Step ${stepGlobal}: "${action.title}" — frame ${frameIdx + 1}`);
        } catch (err) {
          log(`   ⚠️  Frame copy failed for step ${stepGlobal}: ${err.message}`, 'warn');
          screenshotMap[stepKey] = sourcePath;
        }
        action._screenshotKey = stepKey;
      }
    }
  }

  return screenshotMap;
}

module.exports = { run };
