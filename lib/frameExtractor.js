'use strict';

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegStatic);

const CAPTURE_THRESHOLD = 0.02; // 2% — triggers timer
const SETTLE_MS = 400;          // ms of quiet before capturing

// ─── Pass 1: collect timestamps where scene change > 2% ───────────────────
// Uses showinfo filter which reliably prints pts_time to stderr
function collectTriggerTimestamps(videoPath) {
  const { execFileSync } = require('child_process');

  return new Promise((resolve, reject) => {
    const timestamps = [];
    let stderrOutput = '';

    ffmpeg(videoPath)
      .outputOptions([
        // -threads 1: avoid ffmpeg's multi-threaded decoder allocating a
        // reference-frame buffer pool per thread — the dominant OOM risk on
        // high-res/high-fps source video in a memory-constrained container.
        '-threads', '1',
        // Downscale before scene-diffing — detection accuracy doesn't need
        // native resolution, and it cuts the filter graph's per-frame cost.
        '-vf', `scale='min(640\\,iw)':-2,select='eq(n\\,0)+gt(scene\\,${CAPTURE_THRESHOLD})',showinfo`,
        '-vsync', 'vfr',
        '-f', 'null'
      ])
      .output('/dev/null')
      .on('stderr', (line) => {
        stderrOutput += line + '\n';
        // showinfo outputs lines like:
        // [Parsed_showinfo_1 @ 0x...] n:  0 pts:   0 pts_time:0.000 ...
        const tsMatch = line.match(/pts_time:([\d.]+)/);
        if (tsMatch) {
          const t = parseFloat(tsMatch[1]);
          if (!isNaN(t)) timestamps.push(t);
        }
      })
      .on('end', () => {
        if (timestamps.length === 0) {
          // Log a sample of stderr to help debug if nothing found
          console.error('[frameExtractor] Pass 1 found 0 timestamps. Sample stderr:\n' + stderrOutput.slice(0, 500));
        }
        resolve(timestamps);
      })
      .on('error', (err) => reject(new Error(`ffmpeg pass 1 error: ${err.message}`)))
      .run();
  });
}

// ─── Apply 400ms settle logic → produce settled capture timestamps ─────────
function applySettleLogic(triggerTimestamps) {
  if (triggerTimestamps.length === 0) return [];

  const SETTLE_S = SETTLE_MS / 1000;
  const BUFFER_S = 0.05; // 50ms buffer before next trigger

  // Always include t=0 (first frame)
  const sorted = [0, ...triggerTimestamps].sort((a, b) => a - b);
  const unique = [...new Set(sorted)];

  const captureAt = [];
  let i = 0;

  while (i < unique.length) {
    const triggerTime = unique[i];

    // Find the last consecutive trigger within 400ms of this one
    let windowEnd = triggerTime;
    let j = i + 1;
    while (j < unique.length && unique[j] <= windowEnd + SETTLE_S) {
      windowEnd = unique[j];
      j++;
    }

    // Ideal capture: 400ms after the last trigger in this cluster
    const idealCapture = windowEnd + SETTLE_S;

    // If next trigger exists, cap at 50ms before it to avoid capturing a transition
    const nextTrigger = unique[j]; // undefined if no more triggers
    const capture = nextTrigger !== undefined
      ? Math.min(idealCapture, nextTrigger - BUFFER_S)
      : idealCapture;

    captureAt.push(Math.max(triggerTime, capture));
    i = j;
  }

  return captureAt;
}

// ─── Pass 2: extract one frame at each settled timestamp ───────────────────
function extractFrameAtTimestamp(videoPath, timestamp, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(Math.max(0, timestamp))
      .outputOptions([
        '-threads', '1',
        '-vframes', '1',
        '-q:v', '2',
        // Cap at 1080p — screenshots get resized to 1024px wide for the AI
        // and ~643px for the docx anyway, so native 4K is wasted decode cost.
        '-vf', `scale='min(1920\\,iw)':-2`
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`ffmpeg seek error at ${timestamp}s: ${err.message}`)))
      .run();
  });
}

// ─── Main extractor ────────────────────────────────────────────────────────
async function extractFrames(videoPath, framesDir, log) {
  // Pass 1 — find trigger timestamps
  log('   Pass 1: scanning for scene changes (threshold 2%)...');
  let triggerTimestamps;
  try {
    triggerTimestamps = await collectTriggerTimestamps(videoPath);
  } catch (err) {
    log(`   ⚠️  Pass 1 failed: ${err.message} — falling back to 1fps extraction`, 'warn');
    return fallbackExtract(videoPath, framesDir, log);
  }

  log(`   Found ${triggerTimestamps.length} trigger(s), applying 400ms settle logic...`);

  // Apply settle logic
  const captureTimestamps = applySettleLogic(triggerTimestamps);
  log(`   Settled to ${captureTimestamps.length} capture timestamp(s)`);

  if (captureTimestamps.length === 0) {
    log('   ⚠️  No capture timestamps — falling back to 1fps extraction', 'warn');
    return fallbackExtract(videoPath, framesDir, log);
  }

  // Pass 2 — extract one frame per settled timestamp
  log('   Pass 2: extracting settled frames...');
  const rawFrames = [];
  for (let i = 0; i < captureTimestamps.length; i++) {
    const ts = captureTimestamps[i];
    const outputPath = path.join(framesDir, `frame_${String(i + 1).padStart(4, '0')}.jpg`);
    try {
      await extractFrameAtTimestamp(videoPath, ts, outputPath);
      if (fs.existsSync(outputPath)) rawFrames.push(outputPath);
    } catch (err) {
      log(`   ⚠️  Could not extract frame at ${ts.toFixed(3)}s: ${err.message}`, 'warn');
    }
  }

  log(`   Extracted ${rawFrames.length} frame(s)`);

  // Deduplicate — drop frames that are >95% similar to the previous one
  const dedupedFrames = await deduplicateFrames(rawFrames, log);

  // Resize for AI
  const resized = [];
  for (const framePath of dedupedFrames) {
    try {
      const resizedPath = framePath + '_resized.jpg';
      await sharp(framePath)
        .resize({ width: 1024, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(resizedPath);
      resized.push(resizedPath);
    } catch {
      resized.push(framePath);
    }
  }

  return resized;
}

// ─── Deduplicate extracted frames by pixel similarity ─────────────────────
async function deduplicateFrames(frames, log) {
  if (frames.length <= 1) {
    log(`   Deduplication: only ${frames.length} frame(s), nothing to deduplicate`);
    return frames;
  }

  const SIMILARITY_THRESHOLD = 0.95; // drop if >95% similar to previous
  const THUMB_SIZE = 64;             // compare at 64x64 thumbnails — fast

  async function getPixels(framePath) {
    try {
      const result = await sharp(framePath)
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'fill' })
        .flatten({ background: { r: 255, g: 255, b: 255 } }) // remove alpha safely
        .toColorspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });
      return result.data;
    } catch (err) {
      log(`   ⚠️  Could not read pixels from ${path.basename(framePath)}: ${err.message}`, 'warn');
      return null;
    }
  }

  function similarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let same = 0;
    const tolerance = 10;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) <= tolerance) same++;
    }
    return same / a.length;
  }

  const kept = [frames[0]];
  let prevPixels = await getPixels(frames[0]);
  log(`   Deduplication started — comparing ${frames.length} frame(s) at ${SIMILARITY_THRESHOLD * 100}% threshold`);

  for (let i = 1; i < frames.length; i++) {
    const currPixels = await getPixels(frames[i]);
    if (!currPixels) {
      // Can't read frame — keep it to be safe
      kept.push(frames[i]);
      continue;
    }
    const sim = similarity(prevPixels, currPixels);
    log(`   Frame ${path.basename(frames[i])}: ${Math.round(sim * 100)}% similar to previous`);

    if (sim > SIMILARITY_THRESHOLD) {
      log(`   🗑  Dropped (${Math.round(sim * 100)}% > ${SIMILARITY_THRESHOLD * 100}% threshold)`);
    } else {
      log(`   ✅ Kept`);
      kept.push(frames[i]);
      prevPixels = currPixels;
    }
  }

  log(`   Deduplication: ${frames.length} → ${kept.length} frame(s) (removed ${frames.length - kept.length} duplicate(s))`);
  return kept;
}

// ─── Fallback: simple 1fps extraction ─────────────────────────────────────
function fallbackExtract(videoPath, framesDir, log) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        '-threads', '1',
        // fps first so the scale filter only runs on the ~1fps sampled
        // frames, not every decoded source frame.
        '-vf', `fps=1,scale='min(1920\\,iw)':-2`,
        '-q:v', '2'
      ])
      .output(path.join(framesDir, 'frame_%04d.jpg'))
      .on('end', async () => {
        const rawFrames = fs.readdirSync(framesDir)
          .filter(f => f.endsWith('.jpg') && !f.includes('resized'))
          .sort()
          .map(f => path.join(framesDir, f));

        const resized = [];
        for (const framePath of rawFrames) {
          try {
            const resizedPath = framePath + '_resized.jpg';
            await sharp(framePath)
              .resize({ width: 1024, withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toFile(resizedPath);
            resized.push(resizedPath);
          } catch {
            resized.push(framePath);
          }
        }
        resolve(resized);
      })
      .on('error', (err) => reject(new Error(`ffmpeg fallback error: ${err.message}`)))
      .run();
  });
}

module.exports = extractFrames;
