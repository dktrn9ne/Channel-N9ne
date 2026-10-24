import { parseTranscript, recommendClips, validateClip, normalizeProject, formatTime } from './domain.mjs';
import { getExportCapability, exportClip } from './export.mjs';

const $ = id => document.getElementById(id);
const embedded = new URLSearchParams(location.search).get('embedded') === '1';
if (embedded) document.body.classList.add('embedded');
const STORAGE_KEY = 'n9ne.producer.v1';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_BYTES = 10 * 1024 * 1024;
const MAX_CLIPS = 100;
let project = normalizeProject(null);
let recording = null;
let sourceURL = null;
let selectedId = null;
let filter = 'all';
let dirty = false;
let importing = false;
let importGeneration = 0;
let exportController = null;
let selectionEnd = null;
const capability = getExportCapability();

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}
function persist() {
  project.selectedClipId = selectedId;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    $('storage-warning').hidden = true;
    return true;
  } catch {
    $('storage-warning').hidden = false;
    return false;
  }
}
function selected() { return project.clips.find(clip => clip.id === selectedId); }
function evidence(start, end) {
  return project.cues.filter(cue => cue.start >= start && cue.end <= end)
    .map(cue => `[${formatTime(cue.start)}] ${cue.text}`).join('\n');
}
function allowDiscard() { return !dirty || confirm('Discard the unsaved changes to this cut?'); }
function revokeSource() {
  $('preview').pause();
  $('preview').removeAttribute('src');
  $('preview').load();
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  sourceURL = null;
  recording = null;
  selectionEnd = null;
}
function renderList() {
  const list = $('clip-list');
  list.replaceChildren();
  $('clip-count').textContent = project.clips.length;
  const visible = project.clips.filter(clip => filter === 'all' || clip.status === filter);
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = project.clips.length ? 'No clips in this view.' : 'Your moments will appear here. Add a manual cut or import a transcript to get started.';
    list.append(empty);
  }
  for (const clip of visible) {
    const card = document.createElement('button');
    card.className = 'clip-card';
    card.dataset.clipId = clip.id;
    card.setAttribute('aria-pressed', String(clip.id === selectedId));
    card.disabled = !!exportController || importing;
    const meta = document.createElement('span');
    meta.className = 'clip-meta';
    const time = document.createElement('span');
    time.className = 'clip-time';
    time.textContent = `${formatTime(clip.start)} → ${formatTime(clip.end)}`;
    const state = document.createElement('span');
    state.className = `clip-state ${clip.status}`;
    state.textContent = clip.status === 'pending' ? 'To review' : clip.status;
    meta.append(time, state);
    const title = document.createElement('strong');
    title.textContent = clip.title;
    const rationale = document.createElement('p');
    rationale.textContent = clip.rationale || 'Manual selection. Add your producer notes.';
    card.append(meta, title, rationale);
    card.addEventListener('click', () => {
      if (!allowDiscard()) return;
      selectedId = clip.id;
      dirty = false;
      selectionEnd = null;
      if (recording) { $('preview').pause(); $('preview').currentTime = clip.start; }
      persist();
      render();
    });
    list.append(card);
  }
}
function renderEditor() {
  const clip = selected();
  $('editor').hidden = !clip;
  if (!clip) return;
  if (!dirty) {
    $('clip-title').value = clip.title;
    $('clip-start').value = clip.start;
    $('clip-end').value = clip.end;
    $('clip-rationale').value = clip.rationale;
    $('clip-audience').value = clip.audience || 'general';
    $('clip-transcript').textContent = clip.transcript || 'No complete transcript cues fall inside this cut. Review the recording directly.';
  }
  $('clip-origin').textContent = clip.origin === 'manual' ? 'MANUAL CUT' : 'TRANSCRIPT HEURISTIC';
  $('approve').hidden = clip.status === 'approved';
  $('reject').hidden = clip.status === 'rejected';
  $('rescue').hidden = clip.status !== 'rejected';
  for (const control of $('clip-form').elements) control.disabled = !!exportController || importing;
  for (const id of ['set-in', 'set-out', 'preview-clip', 'approve']) $(id).disabled ||= !recording;
}
function render() {
  const busy = !!exportController || importing;
  $('recording').disabled = busy;
  $('transcript').disabled = busy || !recording;
  $('project-import').disabled = busy;
  $('add-clip').disabled = busy || !recording;
  $('recommend').disabled = busy || !recording || !project.cues.length;
  $('download-project').disabled = busy || !project.source;
  $('clear-project').disabled = busy || !project.source;
  $('source-name').textContent = project.source?.name || 'No recording selected';
  $('source-duration').textContent = project.duration ? `${formatTime(project.duration)} · ${recording ? 'Local file connected' : 'Reselect the same recording to preview or render'}` : 'MP4, WebM, or another browser-playable video';
  $('source-badge').textContent = recording ? 'LOCAL FILE' : project.source ? 'RECONNECT FILE' : 'NO SOURCE';
  $('player-empty').hidden = !!recording;
  $('transcript-info').textContent = project.cues.length ? `${project.transcriptName || 'Imported transcript'} · ${project.cues.length} cues. Verify transcript alignment against the recording before approval.` : 'No transcript yet. Manual clips work without one. No transcription service is connected.';
  renderList();
  renderEditor();
  const clip = selected();
  $('export').disabled = busy || !recording || !clip || clip.status !== 'approved' || !capability.supported || dirty;
  $('cancel-export').hidden = !exportController;
  $('export-progress').hidden = !exportController;
  $('export-summary').textContent = clip?.status === 'approved' ? `Selected: ${clip.title} · ${formatTime(clip.end - clip.start)}. ${recording ? 'Ready for your export.' : 'Reconnect the recording to render.'}` : 'Choose an approved clip to render a downloadable video.';
  updateFilters();
  $('export-capability').textContent = capability.supported ? `This browser renders ${capability.extension.toUpperCase()} video in real time, up to 120 seconds per clip. This is not an MP4 export.` : `Rendering unavailable: ${capability.reason} You can still save a project JSON with your edit decisions.`;
}

async function readDuration(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The recording could not be opened in time. Try a browser-compatible MP4 or WebM file.')), 15000);
      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        if (Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth > 0) resolve(video.duration);
        else reject(new Error('This recording has no usable video duration. Remux it to MP4 or WebM first.'));
      };
      video.onerror = () => { clearTimeout(timeout); reject(new Error('This browser cannot play that recording. Try MP4 (H.264/AAC) or WebM.')); };
      video.src = url;
    });
  } finally {
    video.onloadedmetadata = null;
    video.onerror = null;
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
function sameSource(file) {
  const saved = project.source;
  return saved && saved.name === file.name && saved.size === file.size && saved.lastModified === file.lastModified;
}
$('recording').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || exportController) return;
  if (!allowDiscard()) return;
  const reconnect = sameSource(file);
  if (!reconnect && project.clips.length && !confirm('Importing a different recording starts a new project and clears the current clips. Download a JSON backup first if needed. Continue?')) return;
  const generation = ++importGeneration;
  importing = true;
  render();
  notice('Checking the local recording…');
  try {
    const duration = await readDuration(file);
    if (generation !== importGeneration) return;
    if (reconnect && Math.abs(project.duration - duration) > 0.001) throw new Error('This file’s duration does not match the saved project. Choose the original recording.');
    revokeSource();
    if (!reconnect) {
      project = normalizeProject({ version: 1, name: file.name, sourceName: file.name, source: { name: file.name, size: file.size, lastModified: file.lastModified, type: file.type }, duration, clips: [], cues: [] });
      selectedId = null;
      filter = 'all';
    }
    recording = file;
    sourceURL = URL.createObjectURL(file);
    $('preview').src = sourceURL;
    dirty = false;
    notice(reconnect ? 'Recording reconnected. Your saved clips and review decisions are restored.' : 'Recording ready. Mark a moment manually, or import a transcript for evidence-backed suggestions.');
    persist();
  } catch (error) { if (generation === importGeneration) notice(error.message, true); }
  finally { if (generation === importGeneration) { importing = false; render(); } }
});
$('transcript').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !recording || exportController) return;
  if (file.size > MAX_TEXT_BYTES) return notice('Transcript is too large. Use an SRT or VTT file under 2 MB.', true);
  if (!allowDiscard()) return;
  if (project.cues.length && project.clips.length && !confirm('Replacing the transcript clears the current clips so old evidence cannot be mistaken for the new transcript. Continue?')) return;
  importing = true;
  render();
  try {
    const cues = parseTranscript(await file.text());
    if (!cues.length || !cues.some(cue => cue.start < project.duration)) throw new Error('No transcript cues overlap this recording. Check the file and timestamps.');
    if (project.cues.length) { project.clips = []; selectedId = null; }
    project.cues = cues;
    project.transcriptName = file.name;
    // A newly added transcript updates evidence but never silently approves a cut.
    for (const clip of project.clips) { clip.transcript = evidence(clip.start, clip.end); clip.status = 'pending'; }
    dirty = false;
    notice('Transcript imported. Suggestions are rule-based starting points, not verified highlights.');
    persist();
  } catch (error) { notice(error.message, true); }
  finally { importing = false; render(); }
});
$('recommend').addEventListener('click', () => {
  if (!recording || !allowDiscard()) return;
  const suggestions = recommendClips(project.cues, project.duration, 5);
  let added = 0;
  for (const clip of suggestions) {
    if (project.clips.length < MAX_CLIPS && !project.clips.some(existing => existing.id === clip.id)) {
      project.clips.push(clip); added++;
    }
  }
  dirty = false;
  selectedId ||= project.clips[0]?.id || null;
  filter = 'all';
  notice(added ? `${added} transcript-based ${added === 1 ? 'suggestion' : 'suggestions'} added. Watch each cut and check the evidence before approving.` : 'No new suggestions. Existing cuts and their review decisions are unchanged. Short recordings may have fewer than five distinct moments.');
  persist();
  render();
});
$('add-clip').addEventListener('click', () => {
  if (!recording || !allowDiscard()) return;
  if (project.clips.length >= MAX_CLIPS) return notice('This project has reached 100 clips. Save a JSON backup before starting a new project.', true);
  const start = Math.max(0, Math.min($('preview').currentTime, project.duration - Math.min(1, project.duration)));
  const end = Math.min(project.duration, start + 30);
  const clip = { id: crypto.randomUUID(), start, end, title: `Moment ${project.clips.length + 1}`, rationale: 'Manual selection by the producer. Review the source and add your notes.', transcript: evidence(start, end), origin: 'manual', audience: 'general', status: 'pending' };
  project.clips.push(clip);
  selectedId = clip.id;
  dirty = false;
  filter = 'all';
  persist();
  render();
  $('clip-title').focus();
});
function readCut() {
  return { ...selected(), title: $('clip-title').value.trim(), start: Number($('clip-start').value), end: Number($('clip-end').value), rationale: $('clip-rationale').value.trim(), audience: $('clip-audience').value };
}
function saveCut(status) {
  const old = selected();
  if (!old || !$('clip-form').reportValidity()) return false;
  const edited = readCut();
  const result = validateClip(edited, project.duration);
  if (!result.valid) { notice(result.errors.join(' '), true); return false; }
  if (old.origin === 'transcript-heuristic' && (old.start !== edited.start || old.end !== edited.end) && edited.rationale === old.rationale && !edited.rationale.startsWith('Original suggestion, before trimming: ')) {
    edited.rationale = `Original suggestion, before trimming: ${edited.rationale}`.slice(0, 2000);
  }
  edited.transcript = project.cues.length ? evidence(edited.start, edited.end) : '';
  edited.status = status || (dirty ? 'pending' : old.status);
  Object.assign(old, edited);
  dirty = false;
  persist();
  render();
  return true;
}
$('clip-form').addEventListener('input', () => {
  dirty = true;
  $('export').disabled = true;
  const start = Number($('clip-start').value), end = Number($('clip-end').value);
  $('clip-transcript').textContent = evidence(start, end) || 'No transcript evidence for this cut.';
});
$('clip-form').addEventListener('submit', event => { event.preventDefault(); if (saveCut()) notice('Cut saved. Edited clips return to review before export.'); });
$('approve').addEventListener('click', () => { if (recording && saveCut('approved')) notice('Clip approved. You can now render the selected cut.'); });
$('reject').addEventListener('click', () => { if (saveCut('rejected')) notice('Clip rejected, not deleted. Use the Rejected view to rescue it later.'); });
$('rescue').addEventListener('click', () => { if (saveCut('pending')) notice('Clip rescued to review.'); });
for (const [id, target] of [['set-in', 'clip-start'], ['set-out', 'clip-end']]) $(id).addEventListener('click', () => {
  if (!recording) return;
  $(target).value = $('preview').currentTime.toFixed(2);
  $(target).dispatchEvent(new Event('input', { bubbles: true }));
});
$('preview-clip').addEventListener('click', async () => {
  const cut = readCut();
  const result = validateClip(cut, project.duration);
  if (!result.valid) return notice(result.errors.join(' '), true);
  selectionEnd = cut.end;
  $('preview').currentTime = cut.start;
  try { await $('preview').play(); } catch { notice('Press play on the video to preview this selection.', true); }
});
$('preview').addEventListener('timeupdate', () => {
  if (selectionEnd !== null && $('preview').currentTime >= selectionEnd) { $('preview').pause(); selectionEnd = null; }
});
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; renderList(); updateFilters(); });
function updateFilters() { for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter)); }

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Delayed revocation lets the browser consume the download before cleanup.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function safeFilename(title) { return title.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'n9ne-clip'; }
$('download-project').addEventListener('click', () => {
  if (dirty && !saveCut()) return;
  download(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), `${safeFilename(project.name || project.source.name)}-producer.json`);
  notice('Project JSON download requested. It contains edit decisions and transcript text, not the source video.');
});
$('project-import').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || exportController) return;
  if (file.size > MAX_PROJECT_BYTES) return notice('Project JSON must be under 10 MB.', true);
  if (!allowDiscard()) return;
  if (project.clips.length && !confirm('Replace the current project with this backup?')) return;
  importing = true;
  render();
  try {
    const raw = JSON.parse(await file.text());
    if (raw?.version !== 1 || !raw.source || !Array.isArray(raw.clips)) throw new Error('Not a supported N9NE producer project.');
    const restored = normalizeProject(raw);
    if (!restored.source?.name || !restored.source.size || !restored.duration) throw new Error('The project has no valid source metadata.');
    revokeSource();
    project = restored;
    for (const clip of project.clips) clip.transcript = evidence(clip.start, clip.end);
    selectedId = project.selectedClipId || project.clips[0]?.id || null;
    dirty = false;
    filter = 'all';
    persist();
    notice('Project restored. Reselect the original recording to preview, approve, and render.');
  } catch (error) { notice(`Could not restore project: ${error.message}`, true); }
  finally { importing = false; render(); }
});
$('clear-project').addEventListener('click', () => {
  if (!confirm('Clear this browser’s project and all saved clip decisions? Your recording file is not deleted.')) return;
  ++importGeneration;
  revokeSource();
  project = normalizeProject(null);
  selectedId = null;
  dirty = false;
  filter = 'all';
  try { localStorage.removeItem(STORAGE_KEY); $('storage-warning').hidden = true; }
  catch { $('storage-warning').hidden = false; }
  render();
  notice('Project cleared. The recording on your device is unchanged.');
});
$('export').addEventListener('click', async () => {
  const clip = selected();
  if (exportController || !recording || !clip || clip.status !== 'approved' || dirty) return;
  exportController = new AbortController();
  $('preview').pause();
  selectionEnd = null;
  $('export-progress').value = 0;
  $('export-status').textContent = 'Preparing the selected cut…';
  render();
  try {
    const result = await exportClip({ file: recording, start: clip.start, end: clip.end, signal: exportController.signal, onProgress: update => {
      $('export-progress').value = update.progress;
      $('export-status').textContent = `${update.phase === 'rendering' ? 'Rendering' : update.phase} · ${Math.round(update.progress * 100)}%`;
    } });
    download(result.blob, `${safeFilename(clip.title)}.${result.extension}`);
    $('export-status').textContent = `Rendered ${result.extension.toUpperCase()} (${(result.blob.size / 1024 / 1024).toFixed(1)} MB). Download requested; review the saved video before posting.`;
    notice('Your clip has been rendered locally. Nothing was uploaded or published.');
  } catch (error) {
    const cancelled = exportController.signal.aborted || error.name === 'AbortError';
    $('export-status').textContent = cancelled ? 'Render cancelled. No clip was downloaded.' : `Render failed: ${error.message}`;
    notice(cancelled ? 'Render cancelled. Your clip and review decision are unchanged.' : `Could not render the clip: ${error.message}`, !cancelled);
  } finally { exportController = null; render(); }
});
$('cancel-export').addEventListener('click', () => exportController?.abort());
document.addEventListener('visibilitychange', () => { if (document.hidden && exportController) exportController.abort(); });
window.addEventListener('beforeunload', event => { if (dirty || exportController) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { exportController?.abort(); });
async function boot() {
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    project = normalizeProject(JSON.parse(saved));
    for (const clip of project.clips) clip.transcript = evidence(clip.start, clip.end);
    selectedId = project.selectedClipId || project.clips[0]?.id || null;
    if (project.source) notice('Your saved project is here. Reselect the original recording to reconnect preview and export.');
  }
} catch { notice('The saved project could not be loaded. Import a JSON backup or start a new recording.', true); }
render();
}

async function verifySession() {
  const response = await fetch('/api/studio?session=1', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 401 ? 'Your Studio session has expired. Sign in again.' : 'Studio access could not be verified. Return to Studio and try again.');
  const data = await response.json();
  if (data.authenticated !== true) throw new Error('Studio access could not be verified.');
}
function lockProducer(message) {
  exportController?.abort();
  $('preview').pause();
  $('producer-app').hidden = true;
  $('producer-auth').hidden = false;
  $('producer-auth').querySelector('h1').textContent = 'Studio sign-in required';
  $('producer-auth-message').textContent = message;
  if (embedded) parent.postMessage({type:'n9ne-producer-locked'}, location.origin);
}
window.addEventListener('message', event => {
  if (event.origin === location.origin && event.source === parent && event.data?.type === 'n9ne-producer-pause') { exportController?.abort(); $('preview').pause(); }
});
try {
  await verifySession();
  $('producer-auth').hidden = true;
  $('producer-app').hidden = false;
  await boot();
  const authTimer = setInterval(() => verifySession().catch(error => { clearInterval(authTimer); lockProducer(error.message); }), 60000);
} catch (error) { lockProducer(error.message); }
