'use strict';

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const pipeline = require('./lib/pipeline');

const app = express();
const PORT = process.env.PORT || 3000;

['uploads', 'frames', 'screenshots', 'annotated', 'output', 'templates'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const jobs = {};

// Multer for video uploads
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const uploadVideo = multer({
  storage: videoStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/webm'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only mp4, mov, webm videos are allowed'));
  },
  limits: { fileSize: 500 * 1024 * 1024 }
});

// Multer for template uploads
const templateStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'templates')),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const uploadTemplate = multer({
  storage: templateStorage,
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API: List templates
app.get('/api/templates', (req, res) => {
  const templatesDir = path.join(__dirname, 'templates');
  try {
    const files = fs.readdirSync(templatesDir).filter(f =>
      f.endsWith('.docx') || f.endsWith('.pdf') || f.endsWith('.doc')
    );
    res.json({ templates: files });
  } catch {
    res.json({ templates: [] });
  }
});

// --- API: Upload template
app.post('/api/upload-template', uploadTemplate.single('template'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ success: true, filename: req.file.originalname });
});

// --- API: Delete template
app.delete('/api/templates/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(__dirname, 'templates', filename);
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

// --- API: Calibrate frame extraction (no AI, returns frame zip)
app.post('/api/calibrate', uploadVideo.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded.' });

  const threshold = Math.min(1, Math.max(0.01, parseFloat(req.body.threshold) || 0.02));
  const settleMs = 400;
  const jobId = uuidv4();
  const framesDir = path.join(__dirname, 'frames', `cal_${jobId}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const ffmpeg = require('fluent-ffmpeg');
  const ffmpegStatic = require('ffmpeg-static');
  const { ZipArchive } = require('archiver');
  const extractFrames = require('./lib/frameExtractor');
  ffmpeg.setFfmpegPath(ffmpegStatic);

  try {
    // Use the same two-pass logic as the main pipeline
    const resizedFrames = await extractFrames(req.file.path, framesDir, (msg) => console.log('[calibrate]', msg));
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
      try { fs.unlinkSync(req.file.path); } catch {}
    });
  } catch (err) {
    try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: err.message });
  }
});

// --- API: Generate demo script
app.post('/api/generate', uploadVideo.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded.' });
  const { description, template, generateHtml } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required.' });

  const jobId = uuidv4();
  jobs[jobId] = { status: 'running', logs: [], outputFile: null, htmlFile: null, startedAt: new Date() };

  setImmediate(() => {
    pipeline.run({ jobId, videoPath: req.file.path, description, template, generateHtmlOutput: generateHtml === 'true', jobs })
      .then(({ docxPath, htmlPath }) => {
        jobs[jobId].status = 'done';
        jobs[jobId].outputFile = docxPath;
        jobs[jobId].htmlFile = htmlPath;
        jobs[jobId].logs.push({ type: 'done', message: `Done: ${path.basename(docxPath)}` });
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
app.get('/api/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(__dirname, 'output', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (filename.endsWith('.html')) {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.sendFile(filePath);
  }
  res.download(filePath);
});

app.listen(PORT, () => console.log(`DemoScriptGenerator running at http://localhost:${PORT}`));
