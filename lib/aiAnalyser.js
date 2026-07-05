'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── System prompt builder ─────────────────────────────────────────────────
function buildSystemPrompt(templateText) {
  const templateSection = templateText
    ? `\n\nThe user has provided a demo script template. Mirror its section titles, headings, language style, persona names/roles, and benefits phrasing as closely as possible. Use the same tone and terminology:\n---\n${templateText}\n---\n`
    : '';

  return `You are an expert SAP demo script analyst. Analyse frames from a recorded SAP system demo video and produce a structured JSON script documenting every distinct UI interaction.${templateSection}

Rules you MUST follow:
- Return ONLY valid JSON. No markdown fences, no preamble, no explanation.
- SKIP frames showing only loading screens, spinners, progress bars, "Please wait" messages, or blank transitions where NO interactive UI element is visible. Do NOT skip the home page, launchpad, or any starting screen — even if it is just a tile grid or dashboard, it is the beginning of the demo and MUST be step 1.
- ALWAYS document the very first frame as the first action, even if it is just the home screen or launchpad. The first action shows where the demo starts.
- Only document frames where the UI is fully loaded and a meaningful user interaction is visible or has just completed.
- Do NOT create two consecutive actions that describe the same screen state or the same interaction. If multiple frames show the same UI state, document it as ONE action only. Each action must advance the screen to a new state.
- Identify EVERY distinct UI interaction as a separate action step — clicks, form inputs, dialog interactions, dropdown selections, confirmations, navigation steps. Do NOT group multiple interactions into one step.
- A 90-second demo should produce 15-25 action steps. Be granular.
- Each subAction must start with an active imperative verb: Click, Select, Input, Enter, Navigate to, Open, Choose, Expand, Search for, Confirm, Review. NEVER use: Observe, Note, See, Watch, Look at.
- Format subActions as: "Click on the [element name]" or "Input [value] in the [field name] field"
- The processHierarchy must be derived from the navigation breadcrumbs or menu path VISIBLE in the video frames — not invented.
- CRITICAL — frameNumber semantics: frameNumber must be the 1-based index of the frame that shows the screen WHERE the action is performed — i.e., the frame the user is LOOKING AT when they perform the subActions. This is the "before" frame, showing the element that is about to be clicked or interacted with. For example: if the user clicks the "Process Purchase Requisitions" tile on frame 2 and the worklist loads on frame 3, the frameNumber for that action is 2 (the tile page), NOT 3 (the result). The screenshot for each action must show the element being interacted with so the reader knows exactly what to click.
- For each action, write a talkTrack of 1-2 sentences explaining what is happening and why it matters from a business perspective.`;
}


// ─── Per-batch prompt ──────────────────────────────────────────────────────
function batchPrompt(description, batchIdx, totalBatches, frameOffset, actionOffset) {
  const frameStart = frameOffset + 1;
  const frameEnd = frameOffset + 20;
  const batchLabel = `batch ${batchIdx + 1} of ${totalBatches}`;
  const actionStart = actionOffset + 1;

  return `The user recorded a demo of: "${description}"

These are frames ${frameStart}–${frameEnd} of the video (${batchLabel}).
Action numbers in this batch must start from ${actionStart}.
Section numbers: use "${batchIdx + 1}" as the base (e.g. ${batchIdx + 1}, ${batchIdx + 1}.1).

Analyse EVERY distinct UI interaction visible in these frames. Each click, input, navigation, dropdown selection, dialog, or confirmation is a separate action. Return a JSON array using the EXACT schema below. Respond with ONLY the JSON array:

[
  {
    "sectionNumber": "${batchIdx + 1}",
    "sectionTitle": "string — derived from what is shown on screen",
    "sectionDescription": "string — 2-3 sentence business context paragraph",
    "processHierarchy": "string — navigation path visible in video e.g. 'Purchasing > Purchase Orders > Create Purchase Order'",
    "subSections": [
      {
        "subSectionNumber": "${batchIdx + 1}.1",
        "subSectionTitle": "string",
        "benefits": ["string", "string", "string"],
        "persona": { "name": "string", "role": "string" },
        "activityTitle": "string",
        "activityDescription": "string — one sentence",
        "actions": [
          {
            "actionNumber": ${actionStart},
            "title": "string — short action title",
            "stepNumber": 1,
            "subActions": ["Click on the [element]", "Input [value] in the [field] field"],
            "talkTrack": "string — 1-2 sentences of presenter narration explaining this step",
            "frameNumber": 1 // frame index where THIS action is performed (the 'before' screen showing what to click — NOT the result screen)
          }
        ]
      }
    ]
  }
]`;
}

// ─── Main analyser ─────────────────────────────────────────────────────────
async function analyseVideo(frames, description, log, templateText = '') {
  const BATCH_SIZE = 20;
  const batches = [];
  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    batches.push(frames.slice(i, i + BATCH_SIZE));
  }

  log(`   Sending ${frames.length} frame(s) to AI in ${batches.length} batch(es)...`);

  const allBatchResults = [];
  let globalActionOffset = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const frameOffset = batchIdx * BATCH_SIZE;
    log(`   Processing batch ${batchIdx + 1}/${batches.length} (${batch.length} frames)...`);

    const imageContent = [];
    for (const framePath of batch) {
      try {
        const base64 = fs.readFileSync(framePath).toString('base64');
        const mediaType = framePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        imageContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
      } catch { /* skip unreadable frame */ }
    }

    if (imageContent.length === 0) continue;

    imageContent.push({ type: 'text', text: batchPrompt(description, batchIdx, batches.length, frameOffset, globalActionOffset) });

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: buildSystemPrompt(templateText),
        messages: [{ role: 'user', content: imageContent }]
      });

      const rawText = response.content[0].text.trim();
      const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

      let batchData;
      try {
        batchData = JSON.parse(cleaned);
      } catch (parseErr) {
        console.error(`[aiAnalyser] Batch ${batchIdx + 1} raw response:\n${rawText}`);
        log(`   ⚠️  Batch ${batchIdx + 1} returned invalid JSON — skipping`, 'warn');
        continue;
      }

      if (!Array.isArray(batchData) || batchData.length === 0) {
        log(`   ⚠️  Batch ${batchIdx + 1} returned empty result — skipping`, 'warn');
        continue;
      }

      // Count steps in this batch and log
      const batchSteps = batchData.reduce((s, sec) =>
        s + (sec.subSections || []).reduce((ss, sub) => ss + (sub.actions || []).length, 0), 0);
      log(`   Batch ${batchIdx + 1}: ${batchSteps} step(s) identified`);

      // Skip batches that added no new steps (continuation batches often return empty sections)
      if (batchSteps === 0) continue;

      // Re-number frame numbers to be absolute (add batch frame offset)
      for (const section of batchData) {
        for (const sub of (section.subSections || [])) {
          for (const action of (sub.actions || [])) {
            // Adjust relative frame numbers to absolute
            if (action.frameNumber && action.frameNumber > 0) {
              action.frameNumber = frameOffset + action.frameNumber;
            }
            // Re-number actions globally
            globalActionOffset++;
            action.actionNumber = globalActionOffset;
          }
        }
      }

      allBatchResults.push(batchData);
    } catch (err) {
      log(`   ⚠️  AI batch ${batchIdx + 1} error: ${err.message}`, 'warn');
    }
  }

  if (allBatchResults.length === 0) {
    log('   ⚠️  All AI batches failed, using fallback structure', 'warn');
    return buildFallbackStructure(description);
  }

  let merged;
  try {
    merged = mergeBatchResults(allBatchResults, description);
  } catch (mergeErr) {
    console.error('[aiAnalyser] mergeBatchResults error:', mergeErr);
    log(`   ⚠️  Merge failed: ${mergeErr.message} — using first batch only`, 'warn');
    merged = allBatchResults[0];
  }

  const totalSteps = merged.reduce((s, sec) =>
    s + (sec.subSections || []).reduce((ss, sub) => ss + (sub.actions || []).length, 0), 0);
  log(`   Merged total: ${merged.length} section(s), ${totalSteps} step(s) across all batches`);

  try {
    sanitise(merged, description);
  } catch (sanitiseErr) {
    console.error('[aiAnalyser] sanitise error:', sanitiseErr);
    log(`   ⚠️  Sanitise step failed: ${sanitiseErr.message}`, 'warn');
  }

  try {
    const removed = deduplicateActions(merged);
    if (removed > 0) log(`   Removed ${removed} duplicate action(s)`);
  } catch (dedupErr) {
    console.error('[aiAnalyser] dedup error:', dedupErr);
  }

  return merged;
}

// ─── Merge batch results into unified section array ────────────────────────
function mergeBatchResults(allBatchResults, description) {
  if (allBatchResults.length === 1) return allBatchResults[0];

  // Use first batch as the base structure
  const base = allBatchResults[0];

  for (let i = 1; i < allBatchResults.length; i++) {
    const batch = allBatchResults[i];
    for (const batchSection of batch) {
      // Find matching section in base by number or title
      const existing = base.find(s =>
        s.sectionNumber === batchSection.sectionNumber ||
        s.sectionTitle === batchSection.sectionTitle
      );

      if (existing) {
        // Merge sub-sections
        for (const batchSub of (batchSection.subSections || [])) {
          const existingSub = existing.subSections.find(ss =>
            ss.subSectionNumber === batchSub.subSectionNumber ||
            ss.subSectionTitle === batchSub.subSectionTitle
          );
          if (existingSub) {
            // Append new actions to existing sub-section
            existingSub.actions.push(...(batchSub.actions || []));
          } else {
            existing.subSections.push(batchSub);
          }
        }
      } else {
        base.push(batchSection);
      }
    }
  }

  return base;
}

// ─── Post-processing sanitisation ─────────────────────────────────────────
function sanitise(scriptData, userDescription) {
  const passiveMap = {
    'Observe ': 'Click on ',
    'observe ': 'Click on ',
    'Note ': 'Review ',
    'note ': 'Review ',
    'See ': 'Review ',
    'see ': 'Review ',
    'Watch ': 'Review ',
    'watch ': 'Review ',
    'Look at ': 'Review ',
    'look at ': 'Review ',
    'Review the available': 'Select from the available'
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
        action.subActions = (action.subActions || []).map(sa => {
          let s = (sa || '').trim();
          for (const [passive, active] of Object.entries(passiveMap)) {
            if (s.startsWith(passive)) {
              s = active + s.slice(passive.length);
              break;
            }
          }
          return s;
        }).filter(Boolean);
      }
    }
  }
}

// ─── Deduplication — remove consecutive actions with near-identical subActions ─
function deduplicateActions(scriptData) {
  let removed = 0;

  function normalise(subActions) {
    return (subActions || []).map(s => s.toLowerCase().replace(/[^a-z0-9]/g, '')).join('|');
  }

  function similarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const la = a.split('|'), lb = b.split('|');
    const common = la.filter(x => lb.some(y => x && y && (x.includes(y) || y.includes(x))));
    return common.length / Math.max(la.length, lb.length, 1);
  }

  for (const section of scriptData) {
    for (const sub of (section.subSections || [])) {
      const actions = sub.actions || [];
      const kept = [];
      for (let i = 0; i < actions.length; i++) {
        if (kept.length === 0) { kept.push(actions[i]); continue; }
        const prev = kept[kept.length - 1];
        const sim = similarity(normalise(prev.subActions), normalise(actions[i].subActions));
        if (sim >= 0.7) {
          // Merge: keep prev, take the longer talkTrack
          if ((actions[i].talkTrack || '').length > (prev.talkTrack || '').length) {
            prev.talkTrack = actions[i].talkTrack;
          }
          removed++;
        } else {
          kept.push(actions[i]);
        }
      }
      sub.actions = kept;
    }
  }

  return removed;
}

// ─── Fallback structure ────────────────────────────────────────────────────
function buildFallbackStructure(description) {
  return [{
    sectionNumber: '3.1',
    sectionTitle: description || 'Demo Section',
    sectionDescription: `This section demonstrates the ${description || 'demo'} process in SAP S/4HANA.`,
    processHierarchy: description || 'SAP S/4HANA',
    subSections: [{
      subSectionNumber: '3.1.1',
      subSectionTitle: description || 'Demo Process',
      benefits: [
        'Streamlines the end-to-end process with automation',
        'Provides real-time visibility and control',
        'Reduces manual effort and errors'
      ],
      persona: { name: 'Alex Johnson', role: 'Process Manager' },
      activityTitle: description || 'Execute Demo Process',
      activityDescription: `The process manager executes the ${description || 'demo'} process in SAP.`,
      actions: [{
        actionNumber: 1,
        title: description || 'Demo Process',
        stepNumber: 1,
        subActions: ['Navigate to the application', 'Review the overview screen'],
        talkTrack: `In this step we navigate to the ${description || 'demo'} application and review the starting screen.`,
        frameNumber: 1
      }]
    }]
  }];
}

module.exports = analyseVideo;
