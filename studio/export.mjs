/**
 * Local, real-time video export. No uploads, transcoding service, or MP4 renaming.
 * The browser re-encodes the selected interval, so cuts are not frame-accurate.
 * Call from an Export button and keep the tab visible until the promise settles.
 *
 * captureStream includes enabled source audio tracks even when the media element
 * is muted. Muting only prevents a second audible playback alongside the preview.
 * See https://w3c.github.io/mediacapture-fromelement/#html-media-element-media-capture-extensions
 */

export const MAX_EXPORT_SECONDS = 120;

const MIME_TYPES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];
const PREPARE_TIMEOUT_MS = 20000;
const FINALIZE_TIMEOUT_MS = 10000;

/** Feature detection only. File decoding and encoder allocation can still fail. */
export function getExportCapability() {
  const result = {
    supported: false,
    mimeType: null,
    extension: null,
    maxDuration: MAX_EXPORT_SECONDS,
    realtime: true,
    reason: '',
  };
  if (typeof document === 'undefined' || typeof HTMLVideoElement === 'undefined') {
    return { ...result, reason: 'Video export requires a browser.' };
  }
  const prototype = HTMLVideoElement.prototype;
  if (typeof prototype.captureStream !== 'function' && typeof prototype.mozCaptureStream !== 'function') {
    return { ...result, reason: 'This browser cannot capture local video with audio. Try desktop Chrome or Firefox.' };
  }
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return { ...result, reason: 'This browser does not support video recording.' };
  }
  const mimeType = MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    return { ...result, reason: 'This browser cannot encode WebM video. Try desktop Chrome or Firefox.' };
  }
  return { ...result, supported: true, mimeType, extension: 'webm' };
}

function abortError() {
  return new DOMException('Clip export cancelled.', 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function mediaError(video) {
  const messages = {
    1: 'The browser aborted reading this video.',
    2: 'The browser could not read this local video.',
    3: 'The browser could not decode this video. Try a browser-compatible source file.',
    4: 'This video format or codec is not supported by this browser.',
  };
  return new Error(messages[video.error?.code] || 'The browser could not read this video.');
}

/** Waiters always remove their own listeners, including on timeout and abort. */
function waitForMedia(video, { events, ready, signal, action, message }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      events.forEach(event => video.removeEventListener(event, inspect));
      video.removeEventListener('error', fail);
      signal?.removeEventListener('abort', cancel);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve();
    };
    const inspect = () => {
      if (video.error) finish(mediaError(video));
      else if (ready()) finish();
    };
    const fail = () => finish(mediaError(video));
    const cancel = () => finish(abortError());
    events.forEach(event => video.addEventListener(event, inspect));
    video.addEventListener('error', fail);
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => finish(new Error(message)), PREPARE_TIMEOUT_MS);
    if (signal?.aborted) return cancel();
    try {
      action?.();
      inspect();
    } catch (error) {
      finish(error);
    }
  });
}

function notify(callback, phase, progress, currentTime, duration) {
  // A UI callback must not strand the encoder or leak the source object URL.
  try { callback?.({ phase, progress, currentTime, duration }); } catch { /* UI-owned callback. */ }
}

/**
 * @param {{file: Blob, start: number, end: number, signal?: AbortSignal,
 *   onProgress?: (status: {phase: string, progress: number, currentTime: number, duration: number}) => void}} options
 * @returns {Promise<{blob: Blob, extension: string, mimeType: string}>}
 * Progress is a fraction (0..1); currentTime is the source timeline in seconds.
 * Cancellation rejects with AbortError and never returns a partial recording.
 */
export async function exportClip({ file, start, end, signal, onProgress } = {}) {
  checkAbort(signal);
  const capability = getExportCapability();
  if (!capability.supported) throw new Error(capability.reason);
  if (!(file instanceof Blob) || file.size === 0) throw new Error('Select a non-empty local video file first.');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('Choose a valid start and end time for this clip.');
  }
  if (end - start > MAX_EXPORT_SECONDS) {
    throw new Error(`Local exports are limited to ${MAX_EXPORT_SECONDS} seconds per clip.`);
  }
  if (document.hidden) throw new Error('Keep the Studio tab visible while exporting, then try again.');

  const video = document.createElement('video');
  const sourceUrl = URL.createObjectURL(file);
  let stream;
  let recorder;
  let duration = end - start;
  video.preload = 'auto';
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.controls = false;
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.playbackRate = 1;
  video.setAttribute('aria-hidden', 'true');
  video.setAttribute('data-clip-export', '');
  video.tabIndex = -1;
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;pointer-events:none;opacity:0;';

  try {
    (document.body || document.documentElement).append(video);
    notify(onProgress, 'preparing', 0, start, duration);
    await waitForMedia(video, {
      events: ['loadedmetadata', 'loadeddata', 'canplay'],
      ready: () => video.readyState >= 2,
      signal,
      action: () => { video.src = sourceUrl; video.load(); },
      message: 'Timed out loading the video. Try a smaller or browser-compatible source file.',
    });
    checkAbort(signal);
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('This file does not expose a finite duration. Live streams and unindexed recordings cannot be trimmed here.');
    }
    if (!video.videoWidth || !video.videoHeight) throw new Error('The selected file has no decodable video track.');
    if (start >= video.duration || end > video.duration + 0.001) {
      throw new Error('The selected clip extends beyond the end of this video.');
    }
    end = Math.min(end, video.duration);
    duration = end - start;
    await waitForMedia(video, {
      events: ['seeked', 'loadeddata', 'canplay'],
      ready: () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - start) < 0.05,
      signal,
      action: () => { video.currentTime = start; },
      message: 'Timed out seeking to the clip start. This video may not support local seeking.',
    });
    checkAbort(signal);

    const capture = video.captureStream || video.mozCaptureStream;
    stream = capture.call(video);
    if (!stream.getVideoTracks().some(track => track.readyState === 'live')) {
      throw new Error('The browser did not provide a recordable video track. Try desktop Chrome or another source format.');
    }
    const sourceHasAudio = video.mozHasAudio === true || video.audioTracks?.length > 0 || video.webkitAudioDecodedByteCount > 0;
    if (sourceHasAudio && stream.getAudioTracks().length === 0) {
      throw new Error('The browser could not capture this video’s audio. Export was stopped rather than producing a silent clip.');
    }
    recorder = new MediaRecorder(stream, {
      mimeType: capability.mimeType,
      videoBitsPerSecond: 8000000,
      audioBitsPerSecond: 192000,
    });
    const recordedTracks = new Set(stream.getTracks());

    const blob = await new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      let finishing = false;
      let interval;
      let finalizationTimer;
      let frameCallback;
      let played = false;
      let lastTime = start;
      let lastAdvance = performance.now();
      let lastProgress = 0;
      const began = performance.now();

      const cleanListeners = () => {
        clearInterval(interval);
        clearTimeout(finalizationTimer);
        if (frameCallback !== undefined && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallback);
        video.removeEventListener('error', onVideoError);
        video.removeEventListener('ended', onEnded);
        document.removeEventListener('visibilitychange', onVisibility);
        signal?.removeEventListener('abort', cancel);
        recorder.removeEventListener('dataavailable', onData);
        recorder.removeEventListener('error', onRecorderError);
        recorder.removeEventListener('stop', onStop);
        stream.removeEventListener('addtrack', onTrackChange);
        stream.removeEventListener('removetrack', onTrackChange);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanListeners();
        reject(error);
      };
      const cancel = () => fail(abortError());
      const onVideoError = () => fail(mediaError(video));
      const onRecorderError = event => fail(new Error(`Video encoding failed${event.error?.message ? `: ${event.error.message}` : '.'}`));
      const onVisibility = () => {
        if (document.hidden) fail(new Error('Export stopped because the Studio tab was hidden. Keep this tab visible and try again.'));
      };
      const onTrackChange = () => {
        // captureStream can queue initial addtrack events after returning an
        // already populated stream. Those are not a change to recorder inputs.
        const currentTracks = stream.getTracks();
        const unchanged = currentTracks.length === recordedTracks.size && currentTracks.every(track => recordedTracks.has(track));
        if (!unchanged && !finishing && !video.ended) fail(new Error('The source audio/video tracks changed during export. No partial clip was saved.'));
      };
      const onData = event => { if (event.data?.size > 0) chunks.push(event.data); };
      const finish = () => {
        if (settled || finishing) return;
        finishing = true;
        clearInterval(interval);
        if (frameCallback !== undefined && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallback);
        video.pause();
        notify(onProgress, 'finalizing', 1, end, duration);
        if (settled) return; // The progress callback may synchronously cancel.
        finalizationTimer = setTimeout(() => fail(new Error('The browser timed out finalizing this clip. No completed export is available.')), FINALIZE_TIMEOUT_MS);
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (error) { fail(error); }
      };
      const onEnded = () => {
        if (video.currentTime + 0.05 < end) fail(new Error('The source ended before the selected clip was complete.'));
        else finish();
      };
      const onStop = () => {
        if (settled) return;
        if (!finishing && video.currentTime + 0.05 < end) {
          return fail(new Error('Recording stopped before the selected end time. No partial clip was saved.'));
        }
        const mimeType = recorder.mimeType || chunks[0]?.type;
        if (!mimeType || !/^video\/webm(?:;|$)/i.test(mimeType)) {
          return fail(new Error('The browser returned an unexpected recording format.'));
        }
        const output = new Blob(chunks, { type: mimeType });
        if (output.size === 0) return fail(new Error('The browser produced an empty recording.'));
        settled = true;
        cleanListeners();
        resolve(output);
      };
      const inspect = () => {
        if (settled || finishing) return;
        const now = performance.now();
        if (video.currentTime >= end || video.ended) return finish();
        if (video.currentTime > lastTime + 0.001) {
          lastTime = video.currentTime;
          lastAdvance = now;
        }
        if (played && now - lastAdvance > 2000) {
          return fail(new Error('Video playback stalled during export. No partial clip was saved; try a smaller source or lower-resolution video.'));
        }
        if (now - began > (duration + 20) * 1000) {
          return fail(new Error('Video playback or recording timed out. Check browser playback permissions and try again.'));
        }
        if (now - lastProgress >= 100) {
          lastProgress = now;
          notify(onProgress, 'rendering', Math.min(1, Math.max(0, (video.currentTime - start) / duration)), video.currentTime, duration);
        }
      };
      const onFrame = () => {
        inspect();
        if (!settled && !finishing) frameCallback = video.requestVideoFrameCallback(onFrame);
      };
      video.addEventListener('error', onVideoError);
      video.addEventListener('ended', onEnded);
      document.addEventListener('visibilitychange', onVisibility);
      signal?.addEventListener('abort', cancel, { once: true });
      recorder.addEventListener('dataavailable', onData);
      recorder.addEventListener('error', onRecorderError);
      recorder.addEventListener('stop', onStop);
      stream.addEventListener('addtrack', onTrackChange);
      stream.addEventListener('removetrack', onTrackChange);
      if (signal?.aborted) return cancel();
      if (document.hidden) return onVisibility();
      try {
        recorder.start(250);
        interval = setInterval(inspect, 20);
        if (video.requestVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(onFrame);
        Promise.resolve(video.play()).then(() => {
          if (settled || finishing) return;
          played = true;
          lastAdvance = performance.now();
        }, error => {
          fail(new Error(error?.name === 'NotAllowedError'
            ? 'The browser blocked playback for export. Allow video playback, then click Export again.'
            : `The browser could not play this video for export${error?.message ? `: ${error.message}` : '.'}`));
        });
      } catch (error) {
        fail(error);
      }
    });
    checkAbort(signal);
    // Non-empty bytes alone can still be a container header with no video. Make
    // the browser decode the result before calling it a completed video export.
    // Reuse only our isolated element, never the user's review preview.
    video.pause();
    stream.getTracks().forEach(track => track.stop());
    const outputUrl = URL.createObjectURL(blob);
    try {
      await waitForMedia(video, {
        events: ['loadedmetadata', 'loadeddata', 'canplay'],
        ready: () => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0,
        signal,
        action: () => { video.src = outputUrl; video.load(); },
        message: 'The recorded clip could not be decoded as video. Try a longer cut or a different source file.',
      });
    } finally {
      URL.revokeObjectURL(outputUrl);
    }
    checkAbort(signal);
    notify(onProgress, 'complete', 1, end, duration);
    checkAbort(signal);
    return { blob, extension: 'webm', mimeType: blob.type };
  } finally {
    // Each call owns everything it creates; parallel/repeated exports cannot
    // pause the review preview, revoke its URL, or stop another export's tracks.
    video.pause();
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* Already stopping. */ }
    }
    stream?.getTracks().forEach(track => track.stop());
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(sourceUrl);
  }
}
