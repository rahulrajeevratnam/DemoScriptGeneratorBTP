# Demo Script Generator (SAP BTP Cloud Foundry Edition)

An AI-powered Node.js/Express web application that automates the creation of SAP interactive demo scripts (Word `.docx` and optional HTML5) from a recorded demo video. This edition is adapted to run on **SAP BTP Cloud Foundry**, built and deployed from **SAP Business Application Studio (BAS)**.

## What It Does

1. **Extracts frames** from the uploaded video using a two-pass ffmpeg scene-change detector (`ffmpeg-static`)
2. **Analyses frames** using Claude, called through **SAP AI Core's Generative AI Hub** (orchestration service), to identify sections, sub-sections, personas, benefits and step-by-step UI actions
3. **Maps frames to steps** and prepares per-step screenshots (`sharp`)
4. **Annotates screenshots** with numbered callouts
5. **Generates a Word document** (`.docx`) and optionally an interactive HTML5 page, matching SAP's demo script format

## Architecture on BTP Cloud Foundry

| Concern | Implementation |
|---|---|
| AI / LLM calls | `@sap-ai-sdk/orchestration` (SAP Cloud SDK for AI) calling Claude via the SAP AI Core Generative AI Hub orchestration service. Credentials come from the bound `aicore` service instance (`VCAP_SERVICES`) — no `ANTHROPIC_API_KEY` anywhere. |
| Persisted files (uploaded templates, generated `.docx`/`.html` output, in-flight video uploads) | SAP Object Store (S3-compatible), via `@aws-sdk/client-s3`. Credentials come from the bound `objectstore` service instance (`VCAP_SERVICES`). See `lib/objectStore.js` / `lib/serviceCredentials.js`. |
| Transient per-run processing files (extracted frames, raw/annotated screenshots) | `os.tmpdir()` — deliberately **not** persisted. These are pure intermediate artifacts of a single job and are deleted at the end of the pipeline run; there's no reason to pay for durable storage or cross-instance access for them. |
| Job status (`jobs` object in `server.js`) | In-memory — see trade-off discussion below. |
| Bundled default template (`templates/DemoScript_Template.docx`) | Ships with the app image itself (part of the build artifact), so it's identical and available on every instance without needing Object Store. |

### Job state: in-memory vs. Redis

`server.js` keeps job status/logs in a plain in-memory `jobs` object, matching the original app's design. Trade-offs, for the record:

- **In-memory (current choice)**: zero extra moving parts, zero extra service cost, simplest code. Downsides: a job's state is lost if that instance restarts or crashes mid-run (the client's SSE stream just breaks — the user has to re-submit); it does **not** work correctly with `instances > 1`, since `/api/status/:jobId` might land on a different instance than the one running the job. This app is deployed with `instances: 1` in `manifest.yml`/`mta.yaml` specifically to make that limitation survivable.
- **Redis (SAP BTP Redis / rediscloud service)**: would let `jobs` survive an instance restart and let you scale to multiple instances (with sticky sessions or a shared status store). Adds a service dependency, serialization overhead for the `logs` array, and a bit of code (replace object reads/writes with Redis calls, e.g. `RPUSH`/`LRANGE` for logs). Worth doing if you need horizontal scaling or the jobs are long/valuable enough that losing one on a restart is a real cost.

Given a single video-processing job at a time is the realistic usage pattern here, in-memory is the pragmatic default — but it's a one-file change (`server.js` + a `lib/jobStore.js` abstraction) if that changes.

### `ffmpeg-static` on Cloud Foundry

`ffmpeg-static` bundles a prebuilt Linux x64 ffmpeg binary and downloads it during `npm install`'s postinstall step. This runs fine under the standard `nodejs_buildpack` on `cflinuxfs4` (glibc-based, no extra buildpack needed) **as long as the CF staging environment has outbound internet access** to GitHub Releases (`github.com/eugeneware/ffmpeg-static`) during `cf push` / `mbt build` staging. If your subaccount's outbound network policy blocks that during staging (common in locked-down enterprise landscapes), either:
- allowlist that host for staging, or
- vendor the ffmpeg binary yourself (set `FFMPEG_PATH` via `ffmpeg-static`'s override mechanism, or swap to a buildpack that provides ffmpeg).

## Deploying from SAP Business Application Studio

### Prerequisites (all provided by the standard BAS "Full Stack Cloud Application" dev space)

- MTA Build Tool (`mbt`)
- Cloud Foundry CLI + `cf deploy` (multiapps) plugin
- Node.js 18+

### 1. Build

```bash
mbt build
```

This produces `mta_archives/demoscriptgenerator_1.0.0.mtar`.

### 2. Deploy

```bash
cf login   # target the right org/space
cf deploy mta_archives/demoscriptgenerator_1.0.0.mtar
```

`mta.yaml` bakes in defaults for `AICORE_ORCHESTRATION_MODEL`/`AICORE_MAX_TOKENS`, so `cf-vars.yml` is optional — only pass it if you want to override one of them, e.g. to pick a different Claude model:

```bash
cf deploy mta_archives/demoscriptgenerator_1.0.0.mtar -f cf-vars.yml
```

`cf deploy` will automatically:
- create a `demoscriptgenerator-aicore` service instance (`aicore`, plan `extended`)
- create a `demoscriptgenerator-objectstore` service instance (`objectstore`, plan `s3-standard`)
- bind both to the app, so their credentials show up in `VCAP_SERVICES` at runtime
- push and start the `demoscriptgenerator-srv` application

Before your first real run, an AI Core orchestration deployment for a Claude model has to exist in your subaccount (this is a one-time AI Core setup step, separate from `cf deploy` — see below). Verify the model name in `mta.yaml`/`cf-vars.yml` (`AICORE_ORCHESTRATION_MODEL`, default `anthropic--claude-4.6-sonnet`) matches what's actually deployed there.

#### One-time AI Core setup (not automated by MTA)

Creating the `aicore` service instance only gives the app a tenant + credentials — it does not deploy a model. Before Claude calls will succeed, once per subaccount:

1. In SAP AI Launchpad (or via the AI Core REST API), enable the desired Claude model in **Generative AI Hub → Model Library** (third-party models may need a provider agreement accepted first)
2. Create a **Configuration** for the `orchestration` scenario/executable in resource group `default`
3. Create a **Deployment** from that configuration and wait for it to reach `RUNNING`

This is an AI Core resource lifecycle, not a CF resource, so it can't be expressed in `mta.yaml` — it has to be done once via AI Launchpad or scripted separately with `@sap-ai-sdk/ai-api`.

### Alternative: plain `cf push`

If you'd rather manage services yourself instead of using MTA:

```bash
cf create-service aicore extended demoscriptgenerator-aicore
cf create-service objectstore s3-standard demoscriptgenerator-objectstore
cf push
```

(`manifest.yml` references both service instances by name.)

### Troubleshooting: `organization's memory limit exceeded`

Trial and small subaccounts often have a total org memory quota well under what a single app can request. `manifest.yml`/`mta.yaml` default to `memory: 1024M`. If staging fails with this error:

- check your quota and what's already using it: `cf org <your-org>` and `cf apps`
- free up quota by stopping/deleting unused apps, or ask your BTP admin to raise the org's memory quota
- if quota genuinely won't stretch past ~512M, you can lower `memory`/`disk-quota` back down — but see the next section, since 512M is tight for real video processing

If a deploy fails mid-staging and a retry keeps 404ing on a stale build/package, delete the app and redeploy clean: `cf delete demoscriptgenerator-srv -r` (plain `cf push`) or re-run `cf deploy` (MTA handles this itself in most cases).

### Troubleshooting: ffmpeg killed with `SIGKILL` on large/high-res videos

This is the container's OOM killer, not an ffmpeg bug — decoding a 4K (or high-fps) source video needs real reference-frame buffer memory that no amount of output-side filtering can avoid. `lib/frameExtractor.js` forces single-threaded decode (`-threads 1`, since multi-threaded decode multiplies the reference-frame buffer pool — the single biggest avoidable cost) and downscales before scene-detection/output (screenshots get resized to 1024px for the AI and ~643px for the docx anyway, so decoding/encoding at native 4K was always wasted work). Those mitigations help, but if you still hit `SIGKILL` on very large source videos:

- raise `memory` in `manifest.yml`/`mta.yaml` as far as your org quota allows (video decode is the most memory-hungry part of this app by far)
- as a practical workaround, ask presenters to record demos at 1080p rather than 4K — a 4K recording provides no benefit here since everything gets downscaled for the AI/output anyway, and 1080p decode needs a fraction of the memory

## Local Development

```bash
npm install
cp .env.example .env   # fill in AICORE_SERVICE_KEY and S3_* values
npm start
```

Open http://localhost:3000

Locally, `@sap-ai-sdk/orchestration` reads AI Core credentials from the `AICORE_SERVICE_KEY` env var (the full service key JSON, one line) instead of `VCAP_SERVICES`. For Object Store, either point `S3_*` env vars at a real S3-compatible bucket (AWS S3, MinIO, etc.) or bind a real `objectstore` instance if testing against `cf run` locally.

## Usage

1. Upload a demo video (MP4, MOV, or WebM — up to 500MB)
2. Enter a short description of the demo process
3. Optionally select or upload a template (used only to steer the AI's writing style — the template's headings/tone are extracted as text context)
4. Optionally tick "Also generate HTML5 interactive page"
5. Click **Generate Demo Script**
6. Watch real-time progress in the log terminal (via Server-Sent Events)
7. Download the generated `.docx` (and `.html`, if requested) when complete

## Project Structure

```
DemoScriptGeneratorBTP/
├── server.js               # Express server + API routes
├── mta.yaml                # MTA descriptor — nodejs module + aicore/objectstore resources
├── manifest.yml            # Plain `cf push` manifest (services created manually)
├── cf-vars.yml             # Non-service env config substituted into mta.yaml at deploy time
├── lib/
│   ├── pipeline.js         # Pipeline orchestrator
│   ├── frameExtractor.js   # ffmpeg two-pass scene-change frame extraction
│   ├── aiAnalyser.js       # Claude video analysis via SAP AI Core orchestration
│   ├── framePicker.js      # Maps AI-identified steps back to extracted frames
│   ├── annotator.js        # Screenshot annotation
│   ├── docxGenerator.js    # Word document generation (returns a Buffer)
│   ├── htmlGenerator.js    # HTML5 interactive script generation (returns a string)
│   ├── templateReader.js   # Extracts text from uploaded .docx/.pdf template buffers
│   ├── videoQualityCheck.js
│   ├── objectStore.js      # SAP Object Store (S3) read/write/list/delete wrapper
│   └── serviceCredentials.js # VCAP_SERVICES parsing (objectstore) + local .env fallback
├── public/                 # Single-page web UI (index.html, calibrate.html)
└── templates/              # Bundled default template (ships with the app)
```

Note what's *not* here anymore: `uploads/`, `frames/`, `screenshots/`, `annotated/`, `output/` — those are either `os.tmpdir()` scratch space (ephemeral, per-job) or live in the Object Store bucket (`templates/`, `output/`, `uploads/` prefixes), not in the git repo or the local filesystem.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/templates` | List template files (from Object Store `templates/` prefix) |
| POST | `/api/upload-template` | Upload a `.docx`/`.pdf` template (stored in Object Store) |
| DELETE | `/api/templates/:filename` | Delete a template from Object Store |
| POST | `/api/calibrate` | Run frame-extraction only, returns a zip of frames (no AI, no persistence) |
| POST | `/api/generate` | Start the generation pipeline (multipart video upload) |
| GET | `/api/status/:jobId` | SSE stream of live pipeline logs |
| GET | `/api/download/:filename` | Stream a generated `.docx`/`.html` from Object Store |

## Notes

- The AI analysis uses vision — quality depends on video resolution and clarity (minimum 1280×720 is enforced)
- All pipeline steps stream real-time log messages to the browser via Server-Sent Events
- Uploaded videos, extracted frames, and screenshots are deleted as the last step of a *successful* pipeline run (this mirrors the original app's behavior — a failed run currently leaves its tmpdir scratch files and Object Store upload copy behind; consider adding a `try/finally` in `lib/pipeline.js` plus a periodic Object Store `uploads/` sweep if orphaned files become a problem in practice)
