'use strict';

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const CIRCLE_DIAMETER = 28;
const CIRCLE_RADIUS = CIRCLE_DIAMETER / 2;
const ORANGE = '#FF6B00';
const STACK_SPACING = 40; // px between stacked callouts

function buildCalloutSvg(number) {
  const n = String(number);
  const fontSize = n.length > 1 ? 11 : 13;
  return Buffer.from(`<svg width="${CIRCLE_DIAMETER}" height="${CIRCLE_DIAMETER}" xmlns="http://www.w3.org/2000/svg">
  <circle cx="${CIRCLE_RADIUS}" cy="${CIRCLE_RADIUS}" r="${CIRCLE_RADIUS}" fill="${ORANGE}"/>
  <text x="${CIRCLE_RADIUS}" y="${CIRCLE_RADIUS + fontSize * 0.35}" text-anchor="middle"
    font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="white">${n}</text>
</svg>`);
}

async function annotateScreenshots({ scriptData, screenshotMap, annotatedDir, log }) {
  const annotatedMap = {};
  let stepGlobal = 0;

  for (const section of scriptData) {
    for (const subSection of section.subSections) {
      for (const action of subSection.actions) {
        stepGlobal++;
        const stepKey = `step_${stepGlobal}`;
        const srcPath = screenshotMap[stepKey];

        if (!srcPath || !fs.existsSync(srcPath)) {
          annotatedMap[stepKey] = srcPath || null;
          continue;
        }

        const destPath = path.join(annotatedDir, `${stepKey}_annotated.png`);

        try {
          fs.copyFileSync(srcPath, destPath);

          annotatedMap[stepKey] = destPath;
        } catch (err) {
          log(`   ⚠️  Annotation failed for ${stepKey}: ${err.message}`, 'warn');
          annotatedMap[stepKey] = srcPath;
        }
      }
    }
  }

  return annotatedMap;
}

module.exports = annotateScreenshots;
