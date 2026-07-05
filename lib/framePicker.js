'use strict';

/**
 * Pick the best frame index for a given action step.
 * Uses the AI-provided frameNumber when available, otherwise
 * distributes steps evenly across the available frames.
 */
function pickFrameForStep(aiFrameNumber, stepNumber, totalSteps, totalFrames) {
  if (!totalFrames) return 0;

  // AI provided a specific frame number (1-based)
  if (aiFrameNumber && aiFrameNumber > 0) {
    const idx = aiFrameNumber - 1;
    return Math.min(idx, totalFrames - 1);
  }

  // Evenly distribute steps across frames
  const ratio = (stepNumber - 1) / Math.max(totalSteps - 1, 1);
  return Math.min(Math.round(ratio * (totalFrames - 1)), totalFrames - 1);
}

module.exports = { pickFrameForStep };
