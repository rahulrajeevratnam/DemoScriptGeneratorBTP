'use strict';

// Experimental, isolated pipeline (see lib/pipelineGeminiVideo.js): sends the
// whole video directly to Gemini for native video understanding, instead of
// the primary pipeline's ffmpeg scene-detection + static-frame batches.
// Deliberately self-contained (own prompt, own sanitiser) rather than
// sharing code with lib/aiAnalyser.js, so nothing here can regress the
// working Claude pipeline.

const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStatic);

const MODEL_NAME = process.env.AICORE_GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_TOKENS = parseInt(process.env.AICORE_GEMINI_MAX_TOKENS, 10) || 16384;
// Gemini's inline_data video input is documented for files under ~20MB —
// stay comfortably under that after compression.
const MAX_UPLOAD_MB = 18;

let _orchestrationClientCtor;
async function getOrchestrationClient() {
  if (!_orchestrationClientCtor) {
    const mod = await import('@sap-ai-sdk/orchestration');
    _orchestrationClientCtor = mod.OrchestrationClient;
  }
  return new _orchestrationClientCtor({
    promptTemplating: {
      model: { name: MODEL_NAME, params: { max_tokens: MAX_TOKENS } }
    }
  });
}

// Same diagnostic pattern as lib/aiAnalyser.js — the real AI Core error body
// lives at err.cause.response.data, not err.message.
function extractOrchestrationErrorDetail(err) {
  const httpError = err.cause || err;
  const body = httpError?.response?.data;
  const summary = body
    ? (typeof body === 'string' ? body : (body.message || body.error?.message || JSON.stringify(body)))
    : (err.message || 'no further detail available');
  return { body, summary };
}

// ─── Compress the source video for upload ──────────────────────────────────
// This is a single lightweight transcode, unrelated to the primary
// pipeline's full-video scene-detection decode — downscaling here is purely
// to fit Gemini's inline size limit, not a memory-safety measure.
function compressVideoForUpload(videoPath, outPath, log) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        '-threads', '1',
        '-vf', `scale='min(854\\,iw)':-2`,
        '-r', '15',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-b:v', '800k',
        '-maxrate', '1000k',
        '-bufsize', '2000k',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-movflags', '+faststart'
      ])
      .output(outPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`ffmpeg compress error: ${err.message}`)))
      .run();
  });
}

// ─── System prompt builder ─────────────────────────────────────────────────
function buildSystemPrompt(templateText) {
  const templateSection = templateText
    ? `\n\nThe user has provided a demo script template. Mirror its section titles, headings, language style, persona names/roles, and benefits phrasing as closely as possible. Use the same tone and terminology:\n---\n${templateText}\n---\n`
    : '';

  return `You are an expert SAP demo script analyst. Watch this recorded SAP system demo video and produce a structured JSON script documenting every distinct UI interaction.${templateSection}

Rules you MUST follow:
- Return ONLY valid JSON. No markdown fences, no preamble, no explanation.
- SKIP moments showing only loading screens, spinners, progress bars, "Please wait" messages, or blank transitions where NO interactive UI element is visible. Do NOT skip the home page, launchpad, or any starting screen — even if it is just a tile grid or dashboard, it is the beginning of the demo and MUST be step 1.
- ALWAYS document the very first moment as the first action, even if it is just the home screen or launchpad.
- Do NOT create two consecutive actions that describe the same screen state or the same interaction. Each action must advance the screen to a new state.
- Identify EVERY distinct UI interaction as a separate action step — clicks, form inputs, dialog interactions, dropdown selections, confirmations, navigation steps. Do NOT group multiple interactions into one step.
- A 90-second demo should produce 15-25 action steps. Be granular.
- Each subAction must start with an active imperative verb: Click, Select, Input, Enter, Navigate to, Open, Choose, Expand, Search for, Confirm, Review. NEVER use: Observe, Note, See, Watch, Look at.
- Format subActions as: "Click on the [element name]" or "Input [value] in the [field name] field"
- The processHierarchy must be derived from the navigation breadcrumbs or menu path VISIBLE in the video — not invented.
- CRITICAL — timestamp semantics: timestamp must be the time in seconds (a number, may be fractional) into the video WHERE the action is performed — i.e. the moment the user is LOOKING AT the screen just before they click or interact. This is the "before" moment, showing the element that is about to be interacted with, NOT the moment after (the result screen). The screenshot grabbed at this timestamp must show the element being interacted with so the reader knows exactly what to click.
- For each action, write a talkTrack of 1-2 sentences explaining what is happening and why it matters from a business perspective.`;
}

function buildUserPrompt(description) {
  return `The user recorded a demo of: "${description}"

Watch the attached video and analyse EVERY distinct UI interaction. Each click, input, navigation, dropdown selection, dialog, or confirmation is a separate action. Return a JSON array using the EXACT schema below. Respond with ONLY the JSON array:

[
  {
    "sectionNumber": "1",
    "sectionTitle": "string — derived from what is shown on screen",
    "sectionDescription": "string — 2-3 sentence business context paragraph",
    "processHierarchy": "string — navigation path visible in video e.g. 'Purchasing > Purchase Orders > Create Purchase Order'",
    "subSections": [
      {
        "subSectionNumber": "1.1",
        "subSectionTitle": "string",
        "benefits": ["string", "string", "string"],
        "persona": { "name": "string", "role": "string" },
        "activityTitle": "string",
        "activityDescription": "string — one sentence",
        "actions": [
          {
            "actionNumber": 1,
            "title": "string — short action title",
            "stepNumber": 1,
            "subActions": ["Click on the [element]", "Input [value] in the [field] field"],
            "talkTrack": "string — 1-2 sentences of presenter narration explaining this step",
            "timestamp": 0.0 // seconds into the video where THIS action is performed (the 'before' moment — NOT the result)
          }
        ]
      }
    ]
  }
]`;
}

// ─── Light sanitisation (deliberately duplicated from aiAnalyser.js — see
// module header) ────────────────────────────────────────────────────────────
function sanitise(scriptData, userDescription) {
  const passiveMap = {
    'Observe ': 'Click on ', 'observe ': 'Click on ',
    'Note ': 'Review ', 'note ': 'Review ',
    'See ': 'Review ', 'see ': 'Review ',
    'Watch ': 'Review ', 'watch ': 'Review ',
    'Look at ': 'Review ', 'look at ': 'Review '
  };

  for (const section of scriptData) {
    section.sectionTitle = (section.sectionTitle || '').trim() || userDescription;
    section.sectionDescription = (section.sectionDescription || '').trim();

    for (const sub of (section.subSections || [])) {
      sub.subSectionTitle = (sub.subSectionTitle || '').trim();
      sub.activityTitle = (sub.activityTitle || '').trim();
      sub.activityDescription = (sub.activityDescription || '').trim();
      sub.benefits = (sub.benefits || []).map(b => b.trim()).filter(Boolean);
      if (sub.persona) {
        sub.persona.name = (sub.persona.name || '').trim();
        sub.persona.role = (sub.persona.role || '').trim();
      }

      for (const action of (sub.actions || [])) {
        action.title = (action.title || '').trim();
        action.talkTrack = (action.talkTrack || '').trim();
        action.timestamp = typeof action.timestamp === 'number' && action.timestamp >= 0 ? action.timestamp : 0;
        action.subActions = (action.subActions || []).map(sa => {
          let s = (sa || '').trim();
          for (const [passive, active] of Object.entries(passiveMap)) {
            if (s.startsWith(passive)) { s = active + s.slice(passive.length); break; }
          }
          return s;
        }).filter(Boolean);
      }
    }
  }
}

// ─── Main analyser ─────────────────────────────────────────────────────────
async function analyseVideoNative(videoPath, description, log, templateText = '') {
  const compressedPath = videoPath + '.gemini-upload.mp4';

  log('   Compressing video for upload...');
  await compressVideoForUpload(videoPath, compressedPath, log);
  const sizeMb = fs.statSync(compressedPath).size / (1024 * 1024);
  log(`   Compressed to ${sizeMb.toFixed(1)}MB`);
  if (sizeMb > MAX_UPLOAD_MB) {
    log(`   ⚠️  Compressed video is ${sizeMb.toFixed(1)}MB — over the ~${MAX_UPLOAD_MB}MB inline limit, request may be rejected`, 'warn');
  }

  try {
    const base64 = fs.readFileSync(compressedPath).toString('base64');
    const fileData = `data:video/mp4;base64,${base64}`;

    log(`   Sending video to ${MODEL_NAME}...`);
    const client = await getOrchestrationClient();

    let response;
    try {
      response = await client.chatCompletion({
        messages: [
          { role: 'system', content: buildSystemPrompt(templateText) },
          {
            role: 'user',
            content: [
              { type: 'file', file: { file_data: fileData, filename: 'demo.mp4' } },
              { type: 'text', text: buildUserPrompt(description) }
            ]
          }
        ]
      });
    } catch (err) {
      const detail = extractOrchestrationErrorDetail(err);
      console.error('[geminiVideoAnalyser] full error:', JSON.stringify(detail, null, 2));
      throw new Error(`${MODEL_NAME} request failed: ${detail.summary}`);
    }

    const rawText = response.getContent().trim();
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let scriptData;
    try {
      scriptData = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error(`[geminiVideoAnalyser] raw response:\n${rawText}`);
      throw new Error(`${MODEL_NAME} returned invalid JSON`);
    }

    if (!Array.isArray(scriptData) || scriptData.length === 0) {
      throw new Error(`${MODEL_NAME} returned an empty result`);
    }

    const totalSteps = scriptData.reduce((s, sec) =>
      s + (sec.subSections || []).reduce((ss, sub) => ss + (sub.actions || []).length, 0), 0);
    log(`   ${MODEL_NAME}: ${scriptData.length} section(s), ${totalSteps} step(s) identified`);

    sanitise(scriptData, description);

    return scriptData;
  } finally {
    try { fs.unlinkSync(compressedPath); } catch {}
  }
}

module.exports = analyseVideoNative;
