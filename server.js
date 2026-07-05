'use strict';

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const pipeline = require('./lib/pipeline');
const objectStore = require('./lib/objectStore');

const app = express();
const PORT = process.env.PORT || 3000;

const jobs = {};

// Uploads are buffered in memory, then either written to a local tmpdir
// scratch file (for ffmpeg/AI processing) or streamed straight to Object
// Store — no persisted local filesystem usage, since CF instances are
// ephemeral and don't share disk.
const uploadVideo = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/webm'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only mp4, mov, webm videos are allowed'));
  },
  limits: { fileSize: 500 * 1024 * 1024 }
});

const uploadTemplate = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/pdf',
      'application/msword'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(file.mimetype) || ext === '.docx' || ext === '.pdf' || ext === '.doc') {
      cb(null, true);
    } else {
      cb(new Error('Only .docx and .pdf files are allowed'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

function writeTempFile(buffer, originalname) {
  const tmpPath = path.join(os.tmpdir(), `${Date.now()}_${uuidv4()}_${originalname}`);
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API: List templates
app.get('/api/templates', async (req, res) => {
  try {
    const keys = await objectStore.listObjects('templates/');
    const templates = keys
      .map(k => k.slice('templates/'.length))
      .filter(name => name && (name.endsWith('.docx') || name.endsWith('.pdf') || name.endsWith('.doc')));
    res.json({ templates });
  } catch (err) {
    console.error('[server] Failed to list templates:', err);
    res.json({ templates: [] });
  }
});

// --- API: Upload template
app.post('/api/upload-template', uploadTemplate.single('template'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    await objectStore.putObject(`templates/${req.file.originalname}`, req.file.buffer, req.file.mimetype);
    res.json({ success: true, filename: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Delete template
app.delete('/api/templates/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename);
  try {
    await objectStore.deleteObject(`templates/${filename}`);
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

// --- API: Calibrate frame extraction (no AI, returns frame zip)
app.post('/api/calibrate', uploadVideo.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded.' });

  const threshold = Math.min(1, Math.max(0.01, parseFloat(req.body.threshold) || 0.02));
  const jobId = uuidv4();
  const videoPath = writeTempFile(req.file.buffer, req.file.originalname);
  const framesDir = path.join(os.tmpdir(), 'demoscript', `cal_${jobId}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const { ZipArchive } = require('archiver');
  const extractFrames = require('./lib/frameExtractor');

  try {
    // Use the same two-pass logic as the main pipeline
    const resizedFrames = await extractFrames(videoPath, framesDir, (msg) => console.log('[calibrate]', msg));
    const frames = resizedFrames.map(f => path.basename(f)).sort();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="calibration_t${threshold}_${frames.length}frames.zip"`);

    const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.pipe(res);

    // Add a summary text file
    archive.append(
      `Threshold: ${threshold}\nFrames captured: ${frames.length}\n\nFiles:\n${frames.join('\n')}`,
      { name: '_summary.txt' }
    );
    for (const f of frames) {
      archive.file(path.join(framesDir, f), { name: f });
    }

    archive.finalize();
    archive.on('finish', () => {
      try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(videoPath); } catch {}
    });
  } catch (err) {
    try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(videoPath); } catch {}
    res.status(500).json({ error: err.message });
  }
});

// --- API: Generate demo script
app.post('/api/generate', uploadVideo.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded.' });
  const { description, template, generateHtml } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required.' });

  const jobId = uuidv4();
  const videoPath = writeTempFile(req.file.buffer, req.file.originalname);

  // Persist the original upload to Object Store so it survives if this
  // instance restarts mid-job; the pipeline deletes it again on completion.
  let videoUploadKey = null;
  try {
    videoUploadKey = `uploads/${jobId}_${req.file.originalname}`;
    await objectStore.putObject(videoUploadKey, req.file.buffer, req.file.mimetype);
  } catch (err) {
    console.error('[server] Failed to persist upload to Object Store:', err);
    videoUploadKey = null;
  }

  jobs[jobId] = { status: 'running', logs: [], outputFile: null, htmlFile: null, startedAt: new Date() };

  setImmediate(() => {
    pipeline.run({ jobId, videoPath, videoUploadKey, description, template, generateHtmlOutput: generateHtml === 'true', jobs })
      .then(({ docxFilename, htmlFilename }) => {
        jobs[jobId].status = 'done';
        jobs[jobId].outputFile = docxFilename;
        jobs[jobId].htmlFile = htmlFilename;
        jobs[jobId].logs.push({ type: 'done', message: `Done: ${docxFilename}` });
      })
      .catch(err => {
        console.error('[server] Pipeline error:', err);
        jobs[jobId].logs.push({ type: 'info', message: `❌ Pipeline failed: ${err.message}` });
        jobs[jobId].status = 'error';
      });
  });

  res.json({ jobId });
});

// --- API: SSE status stream
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sentIndex = 0;
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const flush = () => {
    while (sentIndex < job.logs.length) send(job.logs[sentIndex++]);
    if (job.status === 'done') {
      send({ type: 'done', outputFile: job.outputFile, htmlFile: job.htmlFile });
      clearInterval(interval); res.end();
    } else if (job.status === 'error') {
      send({ type: 'error' });
      clearInterval(interval); res.end();
    }
  };

  flush();
  const interval = setInterval(flush, 500);
  req.on('close', () => clearInterval(interval));
});

// --- API: Download output
app.get('/api/download/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename);
  try {
    const { stream, contentType, contentLength } = await objectStore.getObjectStream(`output/${filename}`);
    if (filename.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html');
    } else {
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
    }
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    stream.pipe(res);
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

app.listen(PORT, () => console.log(`DemoScriptGenerator running at http://localhost:${PORT}`));
