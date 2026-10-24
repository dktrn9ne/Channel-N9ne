# Channel N9NE Producer Studio

Open the existing protected `studio.html`, sign in, and choose **Producer · VOD clips**. This adds a local-first workspace to the PR #32 Studio control room, preserving its login, live operations, OBS settings, and audience reports. It uses the existing Studio session; no new account, API key, database migration, subscription, or upload service is required. The standalone `producer.html` checks the same session and does not unlock without it.

## Use the workflow

1. Choose a local video recording you own. OBS recordings and downloaded Twitch/Kick/YouTube VODs work if the browser can decode their container and codecs. MP4 (H.264/AAC) and WebM are the safest starting points; an MKV may need remuxing outside Studio. Platform URLs and live streams are not ingested.
2. Preview the recording and **Mark a moment**, or import a time-aligned `.srt`/`.vtt` transcript and choose **Suggest clips**.
3. Review up to five distinct suggestions, their source timestamps, title excerpts, and quoted rule-based rationale. Short/sparse transcripts can yield fewer. English lexical cues and transcript-coverage fallback are editorial starting points, not AI analysis, verified highlights, automatic transcription, or audience-performance predictions.
4. Edit title, in/out seconds, audience intent, and notes. Play the selection, then approve or reject it. Rejected cuts remain available to rescue. Editing an approved cut returns it to review. Audience labels are metadata only: they do not generate alternate edits.
5. Select an approved cut and render it. Supported browsers re-encode the selected interval to a real **WebM** video at its original aspect ratio, with source audio where present. Export is in real time, limited to 120 seconds. Keep the tab visible; cancellation, navigation, and hidden-tab interruption do not produce a partial successful download. Check the downloaded video before posting.

## Data and persistence

The source recording never leaves the device. The producer makes only same-origin, no-store session-status checks at entry and every 60 seconds. Those return an authenticated flag only, not OBS credentials or analytics. There are no media-upload, analytics, platform-publishing, or AI calls in the producer. The existing live-operations tab retains its authenticated telemetry calls. Switching back to live operations pauses producer playback/cancels an active render; logout unloads the producer frame. Browser-local project backups remain until explicitly cleared. The latest project is saved in this origin's `localStorage`: source filename/size/last-modified metadata, transcript, clip decisions, titles, and notes. This is not encrypted storage and is not an account-backed project library. Avoid shared browsers for private material; clearing browser data removes the saved project.

The video bytes are not persisted. Reselect the same file after reload or JSON restore. Name, size, last-modified time, and duration must match; keep the original file unchanged. This is a usability check, not a cryptographic identity guarantee. A different recording starts a new project only after confirmation when clips exist. Failed video/transcript imports preserve the current project. New/replaced evidence must be reviewed again.

**Save project JSON** downloads a portable edit-decision backup with transcript and notes, not a video. Restore it on another browser and reconnect the original recording. Browser storage quota failures are surfaced. Transcript imports are capped at 2 MB; project JSON imports at 10 MB. The normalized project supports up to 100 clips; clear/export old work before starting another source.

## Export support and limits

- Requires `HTMLVideoElement.captureStream` (or Firefox's prefixed equivalent) and a WebM `MediaRecorder` encoder; support is feature-detected. Unsupported browsers still support project JSON exports.
- Video is re-encoded in browser time, not frame-accurate stream-copy or server-side MP4. Long/high-resolution recordings can stress device memory/CPU. Large or unsupported files may fail visibly without an export.
- No vertical reframing, burned-in captions, automatic title generation, automatic publishing, live detection, platform OAuth, OBS control, or Mux dependency is included.
- Browser feature availability does not guarantee every source codec can decode. Watch the saved file before using it on a platform, and convert externally if the destination requires MP4.

## Run locally

Run the repository with its existing Vercel development workflow (for example `vercel dev`) so `/api/studio` is served, with `STUDIO_ADMIN_PASSWORD` and `STUDIO_SESSION_SECRET` configured as described in `STREAMING.md`. Open `/studio.html` and sign in. Producer access does not require the analytics database to be configured.

A static server alone intentionally cannot unlock the producer, because it cannot validate the existing session. Do not open via `file://`. The test suites below use explicit synthetic authentication responses, not a production bypass.

## Tests

No application build or runtime dependencies are required.

```sh
node --test tests/*.test.mjs
node --check studio/studio.mjs
node --check studio/domain.mjs
node --check studio/export.mjs
git diff --check
```

Browser integration tests require the developer tools Playwright, Chromium, Python 3, and ffmpeg/ffprobe. Install Playwright locally if needed (`npm install --no-save playwright@1.62.1`), then:

```sh
node tests/studio-shell.cjs
node tests/studio-ui.cjs
node tests/studio-export.cjs
```

Use `CHROMIUM_PATH` to select the installed Chromium binary (default `/usr/bin/chromium`), `STUDIO_TEST_PORT` to change UI test port 8877, and `STUDIO_QA_DIR` to keep UI screenshots in a chosen directory. Tests generate synthetic color/tone fixtures in a temporary directory, never use creator recordings, and never publish anything. The export test inspects actual WebM video/audio packets and decoded output with ffprobe/ffmpeg, not just a success label.

## Next milestones

A later, separately configured implementation could provide actual transcription/video analysis with evidence provenance, persistent private media storage, server-side MP4 rendering/captioning/reframing, then platform-specific publishing and live event capture. Those require separate provider, privacy, authentication, and cost decisions. They are not simulated by this MVP.
