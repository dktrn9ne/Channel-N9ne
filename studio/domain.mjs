/**
 * Local-only producer domain. No network, DOM, model inference, or media claims.
 * All strings are plain text; consumers must use textContent, never innerHTML.
 */
export const PROJECT_VERSION = 1;
export const MAX_CLIP_SECONDS = 120;
const MAX_CUES = 20000;
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const STATUSES = new Set(['pending', 'approved', 'rejected']);
const AUDIENCES = new Set(['general', 'community', 'new-viewers']);

function plainText(value, maximum = 4000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function subtitleText(value) {
  // Remove subtitle/HTML tags before decoding entities. Encoded comparisons are
  // literal speech, and must not be interpreted as markup on subsequent saves.
  return plainText(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<\/?[a-z][a-z0-9]*(?:\.[^\s>]*)?(?:\s[^>]*)?\s*\/?>|<\d{2,}:\d{2}(?::\d{2})?\.\d{3}>/gi, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
      const number = entity[1].toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number) : '';
    }));
}

function timestamp(value) {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match) throw new Error(`Invalid timestamp "${value}". Use HH:MM:SS.mmm or MM:SS.mmm.`);
  const [, hours = '0', minutes, seconds, milliseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) throw new Error(`Invalid timestamp "${value}".`);
  const result = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(milliseconds) / 1000;
  if (!Number.isFinite(result)) throw new Error(`Invalid timestamp "${value}".`);
  return result;
}

/** Parse WebVTT or SubRip (SRT), fail closed on malformed timing blocks. */
export function parseTranscript(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Choose a non-empty WebVTT or SRT transcript.');
  if (text.length > MAX_TRANSCRIPT_BYTES) throw new Error('Transcript is too large. Use a file smaller than 5 MB.');
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n[\t ]*\n+/);
  const cues = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    let lines = blocks[blockIndex].split('\n').map(line => line.trim());
    if (/^(NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0])) continue;
    if (blockIndex === 0 && /^WEBVTT(?:\s|$)/.test(lines[0])) {
      const firstTiming = lines.findIndex(line => line.includes('-->'));
      if (firstTiming === -1) continue;
      // Accept a missing blank line after the header without treating it as speech.
      lines = lines.slice(firstTiming);
    }
    if (/^(X-TIMESTAMP-MAP=|Kind:|Language:)/i.test(lines[0]) && !cues.length) continue;
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex < 0 || timingIndex > 1) {
      throw new Error(`Transcript block ${blockIndex + 1} has no valid cue timing.`);
    }
    const timing = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timingIndex]);
    if (!timing) throw new Error(`Transcript block ${blockIndex + 1} has malformed cue timing.`);
    let start, end;
    try { start = timestamp(timing[1]); end = timestamp(timing[2]); }
    catch (error) { throw new Error(`Transcript block ${blockIndex + 1}: ${error.message}`); }
    if (end <= start) throw new Error(`Transcript block ${blockIndex + 1} must end after it starts.`);
    if (lines.slice(timingIndex + 1).some(line => line.includes('-->'))) {
      throw new Error(`Transcript block ${blockIndex + 1} contains multiple timings. Separate cues with a blank line.`);
    }
    const body = subtitleText(lines.slice(timingIndex + 1).join(' '));
    if (body) cues.push({ start, end, text: body });
    if (cues.length > MAX_CUES) throw new Error(`Transcript contains more than ${MAX_CUES.toLocaleString('en-US')} cues.`);
  }
  if (!cues.length) throw new Error('No spoken transcript cues found. Import WebVTT or SRT with timed text.');
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

function validDuration(duration) { return typeof duration === 'number' && Number.isFinite(duration) && duration > 0; }
function validCue(cue, duration = Infinity) {
  return cue && typeof cue === 'object' && typeof cue.start === 'number' && Number.isFinite(cue.start)
    && typeof cue.end === 'number' && Number.isFinite(cue.end)
    && cue.start >= 0 && cue.end > cue.start && cue.end <= duration && typeof cue.text === 'string';
}
function cleanCues(cues, duration = Infinity) {
  if (!Array.isArray(cues)) return [];
  return cues.slice(0, MAX_CUES).filter(cue => validCue(cue, duration))
    .map(cue => ({ start: cue.start, end: cue.end, text: plainText(cue.text) }))
    .filter(cue => cue.text).sort((a, b) => a.start - b.start || a.end - b.end);
}

const SIGNALS = [
  { label: 'question punctuation', pattern: /\?/, weight: 3 },
  { label: 'explanation or payoff phrase', pattern: /\b(?:here(?:'s| is) (?:how|why)|the (?:reason|secret|lesson)|turns? out|that(?:'s| is) why|because|finally|in (?:short|summary))\b/i, weight: 4 },
  { label: 'emphasis word', pattern: /\b(?:wow|amazing|unbelievable|incredible|insane|hilarious|surprising|unexpected|important|mistake|never|best|worst)\b/i, weight: 2 },
  { label: 'exclamation punctuation', pattern: /!/, weight: 1 },
];
function evidence(text) {
  const matches = SIGNALS.flatMap(signal => {
    const match = signal.pattern.exec(text);
    return match ? [{ label: signal.label, quote: match[0], weight: signal.weight }] : [];
  });
  return { matches, score: matches.reduce((sum, match) => sum + match.weight, 0) };
}
function intersects(a, b) { return a.start < b.end && b.start < a.end; }
function excerpt(text, length = 76) {
  if (text.length <= length) return text;
  const slice = text.slice(0, length - 1);
  const space = slice.lastIndexOf(' ');
  return `${slice.slice(0, space > length / 2 ? space : undefined)}…`;
}
function roundTime(value) { return Math.round(value * 1000) / 1000; }

/**
 * Select up to five non-overlapping transcript windows using explicit lexical rules.
 * These are review candidates, not claims about humor, quality, virality, or video content.
 * Sparse/short transcripts can correctly yield fewer than the requested count.
 */
export function recommendClips(inputCues, duration, limit = 5) {
  if (!validDuration(duration)) throw new Error('Load a source video with a known positive duration first.');
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(5, Math.floor(limit))) : 5;
  if (!count) return [];
  const cues = cleanCues(inputCues, duration);
  if (!cues.length) return [];
  const targetLength = Math.min(40, Math.max(15, duration / count));
  const candidates = [];
  const seen = new Set();
  for (const cue of cues) {
    // Never pretend to locate individual words inside a cue longer than the window.
    if (cue.end - cue.start > 60) continue;
    const start = Math.max(0, cue.start - Math.min(2, 60 - (cue.end - cue.start)));
    const end = Math.min(duration, start + 60, Math.max(cue.end, start + targetLength));
    const key = `${roundTime(start)}-${roundTime(end)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const signal = evidence(cue.text);
    candidates.push({ start, end, anchor: cue, ...signal });
  }
  const selected = [];
  const isAvailable = candidate => selected.every(other => !intersects(candidate, other));
  for (const candidate of candidates.filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (isAvailable(candidate)) selected.push(candidate);
    if (selected.length === count) break;
  }
  // Fill remaining slots from evenly spaced parts of the actual transcript,
  // explicitly labeling these as coverage rather than inventing positive signals.
  if (selected.length < count && candidates.length) {
    const first = candidates[0].start;
    const last = candidates.at(-1).start;
    for (let slot = 0; slot < count && selected.length < count; slot += 1) {
      const target = count === 1 ? first : first + (last - first) * slot / (count - 1);
      let best = null;
      for (const candidate of candidates) {
        if (isAvailable(candidate) && (!best || Math.abs(candidate.start - target) < Math.abs(best.start - target))) best = candidate;
      }
      if (best) selected.push(best);
    }
  }
  return selected.map(candidate => {
    const inWindow = cues.filter(cue => cue.start >= candidate.start && cue.end <= candidate.end);
    const rationale = candidate.matches.length
      ? `Rule-based transcript match: ${candidate.matches.map(match => `${match.label} (${JSON.stringify(match.quote)})`).join('; ')}. Review the video for context and quality.`
      : 'Transcript coverage only: selected for timeline coverage rather than highlight evidence. This timed excerpt is a review starting point, not an assessed highlight.';
    return {
      id: `clip-${Math.round(candidate.start * 1000)}-${Math.round(candidate.end * 1000)}`,
      start: candidate.start, end: candidate.end,
      title: excerpt(candidate.anchor.text), rationale,
      transcript: inWindow.map(cue => cue.text).join(' '),
      origin: 'transcript-heuristic', status: 'pending', audience: 'general',
    };
  });
}

/** Validate user-editable trim bounds. Times are seconds; no string coercion. */
export function validateClip(clip, duration) {
  const errors = [];
  if (!validDuration(duration)) errors.push('Source duration must be a positive, finite number.');
  if (!clip || typeof clip !== 'object' || Array.isArray(clip)) return { valid: false, errors: [...errors, 'Clip must be an object.'] };
  const startValid = typeof clip.start === 'number' && Number.isFinite(clip.start);
  const endValid = typeof clip.end === 'number' && Number.isFinite(clip.end);
  if (!startValid || clip.start < 0) errors.push('Start must be a finite time at or after zero.');
  if (!endValid) errors.push('End must be a finite time.');
  if (startValid && endValid) {
    if (clip.end <= clip.start) errors.push('End must be after start.');
    if (clip.end - clip.start > MAX_CLIP_SECONDS) errors.push(`Clips must be ${MAX_CLIP_SECONDS} seconds or shorter.`);
    if (validDuration(duration) && clip.end > duration) errors.push('Clip must end within the source video.');
  }
  return { valid: !errors.length, errors };
}

/**
 * Whitelist persisted JSON; never restore media URLs, blobs, HTML, or arbitrary keys.
 * A saved source is metadata only: the UI must ask the user to reattach the video.
 */
export function normalizeProject(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const duration = validDuration(input.duration) ? input.duration : 0;
  const sourceInput = input.source && typeof input.source === 'object' && !Array.isArray(input.source) ? input.source : null;
  const source = sourceInput ? {
    name: typeof sourceInput.name === 'string' ? sourceInput.name.slice(0, 255) : '',
    size: Number.isSafeInteger(sourceInput.size) && sourceInput.size >= 0 ? sourceInput.size : 0,
    lastModified: Number.isSafeInteger(sourceInput.lastModified) && sourceInput.lastModified >= 0 ? sourceInput.lastModified : 0,
    type: plainText(sourceInput.type, 100),
  } : null;
  const usedIds = new Set();
  const clips = (Array.isArray(input.clips) ? input.clips : []).slice(0, 100)
    .filter(clip => validateClip(clip, duration).valid).map((clip, index) => {
      let id = typeof clip.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(clip.id) ? clip.id : `clip-saved-${index + 1}`;
      let suffix = 1;
      while (usedIds.has(id)) id = `clip-saved-${index + 1}-${suffix++}`;
      usedIds.add(id);
      return {
        id, start: clip.start, end: clip.end,
        title: plainText(clip.title, 160) || `Clip ${index + 1}`,
        rationale: plainText(clip.rationale, 2000), transcript: plainText(clip.transcript, 40000),
        origin: clip.origin === 'transcript-heuristic' ? 'transcript-heuristic' : 'manual',
        status: STATUSES.has(clip.status) ? clip.status : 'pending',
        audience: AUDIENCES.has(clip.audience) ? clip.audience : 'general',
      };
    });
  return {
    version: PROJECT_VERSION,
    name: plainText(input.name, 160) || 'Untitled producer session',
    sourceName: source?.name || plainText(input.sourceName, 255),
    source, duration,
    transcriptName: plainText(input.transcriptName, 255),
    cues: duration ? cleanCues(input.cues, duration) : [],
    clips,
    selectedClipId: clips.some(clip => clip.id === input.selectedClipId) ? input.selectedClipId : (clips[0]?.id ?? null),
  };
}

/** HH:MM:SS.mmm (or MM:SS.mmm below an hour), suitable for editable trim inputs. */
export function formatTime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '00:00.000';
  const total = Math.round(seconds * 1000);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const secs = Math.floor(total / 1000) % 60;
  const milliseconds = total % 1000;
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}
