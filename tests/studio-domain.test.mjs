import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, recommendClips, validateClip, normalizeProject, formatTime, MAX_CLIP_SECONDS } from '../studio/domain.mjs';

test('parses WebVTT header, identifiers, settings, multiline cues and inline subtitle tags', () => {
  const cues = parseTranscript('\uFEFFWEBVTT - producer export\r\nKind: captions\r\nLanguage: en\r\n\r\nintro\r\n00:01.250 --> 00:04.500 align:start position:20%\r\n<v Alex><b>Hello</b> &amp; welcome.\r\nThis is line two.\r\n\r\nnext\r\n01:02:03.000 --> 01:02:04.125\r\nThe end.\r\n');
  assert.deepEqual(cues, [
    { start: 1.25, end: 4.5, text: 'Hello & welcome. This is line two.' },
    { start: 3723, end: 3724.125, text: 'The end.' },
  ]);
});

test('parses numbered SRT, comma decimals, and sorts cues by start', () => {
  const cues = parseTranscript('2\n00:00:05,100 --> 00:00:07,200\nSecond.\n\n1\n00:00:01,000 --> 00:00:02,500\nFirst.');
  assert.deepEqual(cues.map(cue => [cue.start, cue.end, cue.text]), [[1, 2.5, 'First.'], [5.1, 7.2, 'Second.']]);
});

test('ignores WebVTT NOTE, STYLE, REGION, and timestamp metadata blocks', () => {
  const cues = parseTranscript('WEBVTT\n\nSTYLE\n::cue {color:red}\n\nREGION\nid:test\n\nNOTE This is not spoken\n00:99.000 --> not-a-time\n\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:00.000 --> 00:02.000\nActual speech.');
  assert.deepEqual(cues, [{ start: 0, end: 2, text: 'Actual speech.' }]);
});

test('accepts whitespace separators and a WebVTT header without a blank line', () => {
  const cues = parseTranscript('WEBVTT\n00:00.000 --> 00:01.000\nFirst.\n  \n00:02.000 --> 00:03.000\nSecond.');
  assert.equal(cues.length, 2);
});

test('decodes common and numeric subtitle entities without a DOM dependency', () => {
  assert.equal(parseTranscript('00:00.000 --> 00:01.000\n&quot;Hi&quot;&nbsp;&#38; &#x1f44b; &apos;yes&apos;')[0].text, '"Hi" & 👋 \'yes\'');
});

test('strips subtitle markup, script/style bodies, and control characters', () => {
  const result = parseTranscript('00:00.000 --> 00:01.000\n<script>alert(1)</script><style>bad</style><img src=x onerror=bad>Safe\u0000 <i>words</i>.');
  assert.equal(result[0].text, 'Safe words.');
});

for (const [label, source] of [
  ['missing cue timing', 'not a timed transcript'],
  ['reversed timing', '00:02.000 --> 00:01.000\nWrong.'],
  ['zero duration cue', '00:01.000 --> 00:01.000\nWrong.'],
  ['invalid minute', '00:61:00.000 --> 01:02:00.000\nWrong.'],
  ['invalid second', '00:60.000 --> 01:02.000\nWrong.'],
  ['negative timestamp', '-00:01.000 --> 00:02.000\nWrong.'],
  ['missing decimal precision', '00:01 --> 00:02\nWrong.'],
  ['malformed timestamp', 'soon --> 00:02.000\nWrong.'],
  ['missing arrow whitespace', '00:01.000-->00:02.000\nWrong.'],
  ['missing cue separators', '00:01.000 --> 00:02.000\nFirst\n00:03.000 --> 00:04.000\nSecond'],
  ['too many identifier lines', 'id\nextra\n00:00.000 --> 00:01.000\nWrong.'],
  ['metadata only', 'WEBVTT\n\nNOTE no speech'],
  ['empty speech', '00:00.000 --> 00:01.000\n<i></i>'],
]) test(`rejects ${label}`, () => assert.throws(() => parseTranscript(source), Error));

test('rejects empty, non-string, and excessively large input', () => {
  for (const value of ['', null, undefined, {}, 42, ' '.repeat(10)]) assert.throws(() => parseTranscript(value));
  assert.throws(() => parseTranscript('x'.repeat(5 * 1024 * 1024 + 1)), /too large/);
});

const spacedCues = Array.from({ length: 12 }, (_, index) => ({
  start: index * 50 + 3, end: index * 50 + 9,
  text: index === 3 ? "Why? Here's why this amazing result matters!" : `Ordinary transcript sentence number ${index}.`,
}));

test('ranks literal evidence, quotes the matched signals, and preserves actual speech', () => {
  const clips = recommendClips(spacedCues, 600);
  assert.equal(clips.length, 5);
  assert.equal(clips[0].title, spacedCues[3].text);
  assert.match(clips[0].rationale, /Rule-based transcript match/);
  assert.match(clips[0].rationale, /question punctuation/);
  assert.match(clips[0].rationale, /Here's why/);
  assert.match(clips[0].rationale, /amazing/);
  assert.equal(clips[0].transcript, spacedCues[3].text);
  for (const clip of clips) {
    assert.equal(clip.origin, 'transcript-heuristic');
    assert.equal(clip.status, 'pending');
    assert.equal(clip.audience, 'general');
    assert.ok(validateClip(clip, 600).valid);
    assert.ok(clip.end - clip.start <= 60);
    assert.ok(clip.transcript.length);
  }
});

test('recommendations are deterministic, non-overlapping, and do not mutate cues', () => {
  const original = structuredClone(spacedCues);
  const clips = recommendClips(spacedCues, 600);
  assert.deepEqual(recommendClips(spacedCues, 600), clips);
  assert.deepEqual(spacedCues, original);
  assert.equal(new Set(clips.map(clip => clip.id)).size, clips.length);
  for (let i = 0; i < clips.length; i += 1) {
    for (let j = i + 1; j < clips.length; j += 1) {
      assert.ok(clips[i].end <= clips[j].start || clips[j].end <= clips[i].start);
    }
  }
});

test('fallback explicitly labels transcript coverage, spread across actual speech', () => {
  const cues = spacedCues.map(cue => ({ ...cue, text: 'A plain statement with no special punctuation.' }));
  const clips = recommendClips(cues, 600);
  assert.equal(clips.length, 5);
  assert.ok(clips.every(clip => clip.rationale.startsWith('Transcript coverage only:')));
  assert.ok(clips.some(clip => clip.start < 50));
  assert.ok(clips.some(clip => clip.start > 500));
  assert.ok(clips.every(clip => clip.transcript === 'A plain statement with no special punctuation.'));
});

test('short sources and sparse transcripts return fewer clips, without invented material', () => {
  const clips = recommendClips([{ start: 1, end: 3, text: 'Only these words.' }], 7);
  assert.equal(clips.length, 1);
  assert.ok(clips[0].start >= 0);
  assert.equal(clips[0].end, 7);
  assert.equal(clips[0].transcript, 'Only these words.');
  assert.deepEqual(recommendClips([], 7), []);
  assert.deepEqual(recommendClips(null, 7), []);
});

test('excludes malformed and beyond-source cues without clipping or inventing their speech', () => {
  const clips = recommendClips([
    { start: -1, end: 4, text: 'Invalid negative.' },
    { start: 2, end: 4, text: 'Included words.' },
    { start: 5, end: 40, text: 'Partially outside source.' },
    { start: 20, end: 25, text: 'Outside source!' },
    { start: 8, end: 8, text: 'Zero duration.' },
    { start: '6', end: 7, text: 'String time.' },
    { start: 6, end: Infinity, text: 'Nonfinite time.' },
  ], 10);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].transcript, 'Included words.');
});

test('does not claim word-level timing within a cue longer than sixty seconds', () => {
  assert.deepEqual(recommendClips([{ start: 0, end: 90, text: 'Important words!' }], 100), []);
  const [clip] = recommendClips([{ start: 4, end: 64, text: 'Important words!' }], 100);
  assert.equal(clip.start, 4);
  assert.equal(clip.end, 64);
});

test('clips near fractional source duration stay inside the exact video bounds', () => {
  const duration = 31.234567;
  const [clip] = recommendClips([{ start: 30, end: 31, text: 'Closing words!' }], duration);
  assert.equal(clip.end, duration);
  assert.ok(validateClip(clip, duration).valid);
});

test('only complete cues inside the selected window appear in its transcript', () => {
  const cues = [
    { start: 0, end: 14, text: 'Earlier long cue.' },
    { start: 12, end: 15, text: 'Why? Amazing!' },
    { start: 16, end: 17, text: 'Context inside.' },
    { start: 24, end: 70, text: 'Partially outside the selected window.' },
  ];
  const [clip] = recommendClips(cues, 100, 1);
  assert.equal(clip.transcript, 'Why? Amazing! Context inside.');
});

test('honors lower recommendation limits and hard caps the maximum at five', () => {
  assert.equal(recommendClips(spacedCues, 600, 2).length, 2);
  assert.equal(recommendClips(spacedCues, 600, 100).length, 5);
  assert.deepEqual(recommendClips(spacedCues, 600, 0), []);
  assert.deepEqual(recommendClips(spacedCues, 600, -5), []);
});

test('rejects unknown and invalid source duration for recommendations', () => {
  for (const duration of [0, -1, NaN, Infinity, '30', undefined]) assert.throws(() => recommendClips(spacedCues, duration));
});

test('validates trim bounds and the 120-second real-time export cap', () => {
  assert.equal(MAX_CLIP_SECONDS, 120);
  for (const clip of [{ start: 0, end: 1 }, { start: 0, end: 120 }, { start: 80, end: 200 }]) {
    assert.deepEqual(validateClip(clip, 200), { valid: true, errors: [] });
  }
  for (const clip of [null, [], {}, { start: -1, end: 2 }, { start: 2, end: 2 }, { start: 3, end: 2 },
    { start: 0, end: 120.001 }, { start: 199, end: 201 }, { start: '0', end: 2 }, { start: NaN, end: 2 }, { start: 0, end: Infinity }]) {
    const validation = validateClip(clip, 200);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.length > 0);
  }
  assert.equal(validateClip({ start: 0, end: 2 }, 0).valid, false);
});

test('normalizes absent/corrupt persistence to a fresh safe project', () => {
  for (const input of [null, undefined, false, 42, [], 'string']) {
    const project = normalizeProject(input);
    assert.equal(project.version, 1);
    assert.equal(project.duration, 0);
    assert.equal(project.source, null);
    assert.equal(project.selectedClipId, null);
    assert.deepEqual(project.clips, []);
    assert.deepEqual(project.cues, []);
  }
});

test('preserves supported metadata, edits, decisions and the selected clip', () => {
  const input = {
    version: 1, name: 'October stream', duration: 600,
    source: { name: 'stream.mp4', size: 123456, lastModified: 1600000000000, type: 'video/mp4' },
    transcriptName: 'stream.vtt', cues: spacedCues,
    clips: recommendClips(spacedCues, 600).map((clip, index) => ({ ...clip, title: `Edited ${index}`, rationale: 'Producer note.', status: index ? 'rejected' : 'approved', audience: 'new-viewers' })),
  };
  input.selectedClipId = input.clips[1].id;
  const project = normalizeProject(input);
  assert.equal(project.name, input.name);
  assert.deepEqual(project.source, input.source);
  assert.equal(project.sourceName, 'stream.mp4');
  assert.equal(project.transcriptName, 'stream.vtt');
  assert.deepEqual(project.cues, input.cues);
  assert.deepEqual(project.clips, input.clips);
  assert.equal(project.selectedClipId, input.selectedClipId);
  assert.deepEqual(normalizeProject(JSON.parse(JSON.stringify(project))), project);
});

test('drops invalid clips and unsupported keys, keeps strings inert, and resolves duplicate IDs', () => {
  const clip = { start: 1, end: 20, id: 'same', title: '<b>A title</b>', rationale: 'Notes', transcript: 'Words', status: 'published', audience: 'everyone', origin: 'ai-analyzed', downloadUrl: 'javascript:bad' };
  const project = normalizeProject({ duration: 100, source: { name: 'stream.mp4', size: -5, lastModified: Infinity, type: 'video/mp4', url: 'blob:secret' },
    clips: [clip, clip, { ...clip, id: 'clip-saved-3-1' }, { ...clip, id: 'same' }, { start: 1, end: 200 }],
    cues: [{ start: 0, end: 5, text: '<i>Speech</i>' }, { start: 80, end: 110, text: 'Out of range.' }],
    selectedClipId: 'missing', __proto__: { malicious: 'yes' }, videoUrl: 'blob:secret', apiKey: 'bad',
  });
  assert.equal(project.clips.length, 4);
  assert.equal(new Set(project.clips.map(value => value.id)).size, 4);
  assert.ok(project.clips.every(value => value.status === 'pending' && value.audience === 'general' && value.origin === 'manual'));
  assert.ok(project.clips.every(value => value.title === '<b>A title</b>'));
  assert.equal(project.selectedClipId, project.clips[0].id);
  assert.deepEqual(project.cues, [{ start: 0, end: 5, text: '<i>Speech</i>' }]);
  assert.equal(project.source.size, 0);
  assert.equal(project.source.lastModified, 0);
  assert.equal(project.source.url, undefined);
  assert.equal(project.videoUrl, undefined);
  assert.equal(project.apiKey, undefined);
  assert.equal(project.malicious, undefined);
  assert.equal(project.clips[0].downloadUrl, undefined);
});

test('literal comparisons and decoded text survive recommendation and persistence unchanged', () => {
  const cues = parseTranscript('WEBVTT\n\n00:00.000 --> 00:04.000\n2 < 3 > 1; &lt;literal&gt; and &amp;lt; are spoken examples.');
  const text = '2 < 3 > 1; <literal> and &lt; are spoken examples.';
  assert.equal(cues[0].text, text);
  const clips = recommendClips(cues, 10);
  assert.equal(clips[0].transcript, text);
  const project = normalizeProject({ duration: 10, cues, clips });
  assert.equal(project.cues[0].text, text);
  assert.equal(project.clips[0].transcript, text);
  assert.deepEqual(normalizeProject(project), project);
});

test('exact source filenames are retained for metadata matching on video reattachment', () => {
  const source = { name: ' my <stream> & file.mp4 ', size: 100, lastModified: 123, type: 'video/mp4' };
  assert.deepEqual(normalizeProject({ source }).source, source);
});

test('stored text has bounded length and IDs cannot become selector markup', () => {
  const project = normalizeProject({ name: 'n'.repeat(1000), duration: 100,
    clips: [{ start: 1, end: 2, id: '"><img src=x>', title: 't'.repeat(1000), rationale: 'r'.repeat(5000), transcript: 's'.repeat(50000) }],
  });
  assert.equal(project.name.length, 160);
  assert.equal(project.clips[0].title.length, 160);
  assert.equal(project.clips[0].rationale.length, 2000);
  assert.equal(project.clips[0].transcript.length, 40000);
  assert.equal(project.clips[0].id, 'clip-saved-1');
});

test('formats millisecond times with correct rounding carry and hour support', () => {
  assert.equal(formatTime(0), '00:00.000');
  assert.equal(formatTime(1.234), '00:01.234');
  assert.equal(formatTime(59.9999), '01:00.000');
  assert.equal(formatTime(3600.125), '01:00:00.125');
  assert.equal(formatTime(360000), '100:00:00.000');
  for (const invalid of [NaN, Infinity, -1, '1', null]) assert.equal(formatTime(invalid), '00:00.000');
});

test('recommendation invariants hold over many deterministic generated transcripts', () => {
  for (let sample = 1; sample <= 100; sample += 1) {
    const duration = sample * 7.321;
    const cues = Array.from({ length: sample }, (_, index) => ({ start: index * 7, end: index * 7 + 3,
      text: index % 3 === 0 ? 'Why is that important?' : 'Ordinary sentence.' }));
    const clips = recommendClips(cues, duration);
    assert.ok(clips.length <= 5);
    for (const clip of clips) {
      assert.ok(validateClip(clip, duration).valid);
      assert.ok(clip.end - clip.start <= 60);
      assert.ok(clip.transcript);
      assert.ok(clips.every(other => clip === other || clip.end <= other.start || other.end <= clip.start));
    }
  }
});
