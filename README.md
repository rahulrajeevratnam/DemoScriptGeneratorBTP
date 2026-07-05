# Demo Script Generator

An AI-powered Node.js web application that automates the creation of SAP interactive demo scripts from a recorded demo video.

## What It Does

1. **Extracts frames** from the uploaded video (1 fps) using ffmpeg
2. **Analyses frames** using Claude AI (claude-sonnet-4-6) to understand the demo flow and identify sections, steps, and UI actions
3. **Replays the demo** in a real Chromium browser via Playwright, performing each identified action and capturing screenshots
4. **Annotates screenshots** with orange numbered callout circles (matching SAP demo style)
5. **Generates a Word document** (.docx) matching SAP's interactive demo script format

## Setup

### Prerequisites

- Node.js 18+
- npm 9+

### Install

```bash
npm install
npx playwright install chromium
```

### Environment Variables

Copy `.env` and fill in your values:

```
ANTHROPIC_API_KEY=your_anthropic_api_key_here
TEMPLATES_REPO=https://github.com/rahul-demo-scripts/templates
PORT=3000
```

### Run

```bash
npm start
```

Open http://localhost:3000

## Usage

1. Upload a demo video (MP4, MOV, or WebM — up to 500MB)
2. Enter a short description of the demo process
3. Provide the SAP Smart Link URL to the live system
4. Enter your IAS credentials (username + password)
5. Optionally select a template (sync from GitHub first)
6. Click **Generate Demo Script**
7. Watch real-time progress in the log terminal
8. Download the generated `.docx` when complete

## Output Document Format

The generated `.docx` follows the SAP interactive demo script format:

- **Cover page**: Demo title, process hierarchy breadcrumb, generation date
- **Per section** (e.g. "3.1. Manage Purchase Requisitions"): Section heading + business description
- **Per sub-section** (e.g. "3.1.1. Purchase Requisition Processing"): Benefits checklist, persona block, activity description, end-state screenshot
- **Per action step**: Action heading in SAP blue (#0070F2), numbered sub-actions, annotated screenshot with orange callout circles

### Typography
- Font: Arial (fallback for SAP 72)
- Heading 1: 18pt bold
- Heading 2: 14pt bold
- Action headings: 11pt bold, SAP blue #0070F2
- Body text: 10pt
- Page: A4, 20mm margins

## Project Structure

```
DemoScriptGenerator/
├── server.js           # Express server + API routes
├── lib/
│   ├── pipeline.js     # Pipeline orchestrator
│   ├── frameExtractor.js   # ffmpeg frame extraction
│   ├── aiAnalyser.js       # Claude AI video analysis
│   ├── playwrightRunner.js # Chromium browser automation
│   ├── annotator.js        # Screenshot annotation (sharp)
│   └── docxGenerator.js    # Word document generation
├── public/
│   └── index.html      # Single-page web UI
├── uploads/            # Temporary video uploads
├── frames/             # Extracted video frames (temp)
├── screenshots/        # Raw Playwright screenshots
├── annotated/          # Annotated screenshots with callouts
├── output/             # Generated .docx files
└── templates/          # Cloned SAP template files
```

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/templates` | List available template files |
| POST | `/api/sync-templates` | Clone/pull templates from GitHub |
| POST | `/api/generate` | Start generation pipeline (multipart upload) |
| GET | `/api/status/:jobId` | SSE stream of live pipeline logs |
| GET | `/api/download/:filename` | Download generated .docx |

## Notes

- The AI analysis uses vision to understand the video content — quality of analysis depends on video resolution and clarity
- Playwright automation uses the AI-inferred selectors; if a step fails, it captures the current page state and continues
- All pipeline steps stream real-time log messages to the browser via Server-Sent Events
- Frames and uploaded videos are deleted after successful generation; screenshots and output files are retained
