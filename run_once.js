'use strict';

require('dotenv').config();

const pipeline = require('./lib/pipeline');
const path = require('path');

const jobs = {};
const jobId = 'test_job';
jobs[jobId] = { status: 'running', logs: [], outputFile: null };

pipeline.run({
  jobId,
  videoPath: '/root/.claude/uploads/8f2dcf24-7a9f-5407-aa98-b2859f374893/1ed6a0de-Purchase_Order_Creation.mp4',
  description: 'Purchase Order Creation in SAP S/4HANA',
  template: '',
  generateHtmlOutput: false,
  jobs
}).then(({ docxFilename, htmlFilename }) => {
  console.log('\n✅ Done:', docxFilename, htmlFilename || '');
}).catch(err => {
  console.error('\n❌ Error:', err.message);
});

// Stream logs to console
setInterval(() => {
  const job = jobs[jobId];
  if (!job) return;
  while (job.logs.length > 0) {
    const entry = job.logs.shift();
    console.log(`[${entry.type}] ${entry.message}`);
  }
}, 300);
