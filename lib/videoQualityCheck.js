'use strict';

const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const MIN_WIDTH = 1280;
const MIN_HEIGHT = 720;

/**
 * Reads video metadata by running ffmpeg -i and parsing its stderr output.
 * ffmpeg-static does not ship ffprobe, so we use ffmpeg itself.
 */
function probeVideo(videoPath) {
  try {
    // ffmpeg -i always exits non-zero when no output is given — that's expected
    execFileSync(ffmpegPath, ['-i', videoPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    // stderr contains the metadata we need
    return err.stderr ? err.stderr.toString() : '';
  }
  return '';
}

/**
 * Checks video resolution using ffmpeg metadata.
 * Throws an error with a user-friendly message if below minimum.
 * Returns { width, height, duration, fps } on success.
 */
function checkVideoQuality(videoPath) {
  return new Promise((resolve, reject) => {
    let output;
    try {
      output = probeVideo(videoPath);
    } catch (e) {
      return reject(new Error(`Could not read video metadata: ${e.message}`));
    }

    if (!output) return reject(new Error('Could not read video metadata.'));

    // Parse resolution: e.g. "1920x1080"
    const resMatch = output.match(/(\d{3,5})x(\d{3,5})/);
    if (!resMatch) return reject(new Error('Could not determine video resolution.'));

    const width = parseInt(resMatch[1], 10);
    const height = parseInt(resMatch[2], 10);

    // Parse duration: e.g. "Duration: 00:01:37.42" — capture the fractional
    // seconds too (previously truncated to whole seconds, which under-
    // reported duration by up to ~1s).
    const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const duration = durMatch
      ? parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3])
      : 0;

    // Parse fps: e.g. "30 fps" or "29.97 fps"
    const fpsMatch = output.match(/([\d.]+)\s+fps/);
    const fps = fpsMatch ? Math.round(parseFloat(fpsMatch[1])) : 0;

    if (width < MIN_WIDTH || height < MIN_HEIGHT) {
      return reject(new Error(
        `Video resolution too low: ${width}×${height}. ` +
        `Minimum required is ${MIN_WIDTH}×${MIN_HEIGHT} (720p). ` +
        `Please re-record at a higher resolution and try again.`
      ));
    }

    resolve({ width, height, duration, fps });
  });
}

module.exports = { checkVideoQuality };
