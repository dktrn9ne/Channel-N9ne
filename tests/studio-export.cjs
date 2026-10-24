/* Run: node tests/studio-export.cjs
 * Requires Playwright, Chromium (CHROMIUM_PATH optional), ffmpeg and ffprobe.
 * Uses an ephemeral localhost server and generated temp fixtures, never user data.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'n9ne-export-'));
const run = (command, args, binary = false) => {
  const result = spawnSync(command, args, { encoding: binary ? null : 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
};
let browser;
let server;
(async () => {
  const fixture = path.join(temp, 'source.webm');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=1320:duration=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libvpx', '-b:v', '400k', '-c:a', 'libopus', '-y', fixture,
  ]);
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', fixture, '-an', '-c:v', 'copy', '-y', path.join(temp, 'silent.webm')]);
  server = http.createServer((request, response) => {
    if (request.url === '/export.mjs') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(fs.readFileSync(path.join(root, 'studio/export.mjs')));
    } else if (['/source.webm', '/silent.webm'].includes(request.url)) {
      response.writeHead(200, { 'Content-Type': 'video/webm' });
      response.end(fs.readFileSync(path.join(temp, request.url.slice(1))));
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Local export QA</title><video id="preview" controls></video>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    window.exportModule = await import('/export.mjs');
    window.fixture = await (await fetch('/source.webm')).blob();
    window.silentFixture = await (await fetch('/silent.webm')).blob();
    window.openUrls = new Set();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); openUrls.add(url); return url; };
    URL.revokeObjectURL = url => { openUrls.delete(url); revoke(url); };
    const preview = document.querySelector('#preview');
    preview.src = URL.createObjectURL(fixture);
    preview.muted = true;
    await new Promise((resolve, reject) => { preview.onloadeddata = resolve; preview.onerror = reject; });
    preview.currentTime = 1;
    await new Promise(resolve => { preview.onseeked = resolve; });
  });
  const capability = await page.evaluate(() => exportModule.getExportCapability());
  assert.equal(capability.supported, true);
  assert.equal(capability.extension, 'webm');
  assert.equal(capability.maxDuration, 120);
  console.log('PASS capability check');

  const assertClean = async () => assert.deepEqual(await page.evaluate(() => ({
    elements: document.querySelectorAll('[data-clip-export]').length,
    urls: openUrls.size,
    previewPaused: document.querySelector('#preview').paused,
    previewTime: document.querySelector('#preview').currentTime,
  })), { elements: 0, urls: 1, previewPaused: true, previewTime: 1 });

  async function render(name, start, end, silent = false) {
    const result = await page.evaluate(async ({ start, end, silent }) => {
      const progress = [];
      const started = performance.now();
      const output = await exportModule.exportClip({ file: silent ? silentFixture : fixture, start, end, onProgress: p => progress.push(p) });
      return { bytes: Array.from(new Uint8Array(await output.blob.arrayBuffer())), mimeType: output.mimeType, extension: output.extension, progress, elapsed: performance.now() - started };
    }, { start, end, silent });
    assert.match(result.mimeType, /^video\/webm/);
    assert.equal(result.extension, 'webm');
    assert.equal(result.progress.at(-1).phase, 'complete');
    assert(result.elapsed >= (end - start) * 800, 'real-time recording must not report premature completion');
    const outputPath = path.join(temp, `${name}.webm`);
    fs.writeFileSync(outputPath, Buffer.from(result.bytes));
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', outputPath]));
    assert(probe.streams.some(s => s.codec_type === 'video' && s.width === 320 && s.height === 180), 'must contain real original-dimension video');
    assert.equal(probe.streams.some(s => s.codec_type === 'audio'), !silent);
    const videoIndex = probe.streams.find(s => s.codec_type === 'video').index;
    const packets = probe.packets.filter(p => p.stream_index === videoIndex);
    assert(packets.length >= 10, 'must contain decoded video frames, not just a header');
    const actual = Math.max(...packets.map(p => Number(p.pts_time) + Number(p.duration_time || 0))) - Math.min(...packets.map(p => Number(p.pts_time)));
    assert(Math.abs(actual - (end - start)) < 0.25, `duration ${actual} should match ${end - start} within 250 ms`);
    if (!silent) {
      const audio = run('ffmpeg', ['-v', 'error', '-i', outputPath, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], true);
      let squares = 0;
      let crossings = 0;
      let previous = 0;
      for (let i = 0; i < audio.length; i += 4) {
        const value = audio.readFloatLE(i);
        squares += value * value;
        if (previous <= 0 && value > 0) crossings++;
        previous = value;
      }
      const rms = Math.sqrt(squares / (audio.length / 4));
      assert(rms > 0.02, `source audio must not be muted (RMS ${rms})`);
      if (start >= 2.2 && end <= 3.8) {
        const frequency = crossings / (audio.length / 4 / 8000);
        assert(Math.abs(frequency - 880) < 80, `trim should retain the middle tone, not source beginning (${frequency} Hz)`);
      }
    }
    // All frames in this interval must be green, not the red first scene.
    if (start >= 2.2 && end <= 3.8) {
      const pixels = run('ffmpeg', ['-v', 'error', '-i', outputPath, '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], true);
      for (let i = 0; i < pixels.length; i += 3) assert(pixels[i + 1] > pixels[i] + 60 && pixels[i + 1] > pixels[i + 2] + 60, 'every frame should come from the requested green scene');
    }
    await assertClean();
    console.log(`PASS ${name}: ${actual.toFixed(3)}s, ${packets.length} frames, ${silent ? 'video-only' : 'audible source audio'}, original dimensions`);
  }

  await render('trim-middle', 2.2, 3.7);
  const invalid = await page.evaluate(async () => {
    const cases = [{ start: -1, end: 1 }, { start: 2, end: 2 }, { start: 0, end: 121 }, { start: 5, end: 9 }];
    const errors = [];
    for (const range of cases) {
      try { await exportModule.exportClip({ file: fixture, ...range }); errors.push(null); }
      catch (error) { errors.push(error.message); }
    }
    try { await exportModule.exportClip({ file: new Blob(['not video']), start: 0, end: 1 }); errors.push(null); }
    catch (error) { errors.push(error.message); }
    return errors;
  });
  assert(invalid.every(Boolean), JSON.stringify(invalid));
  await assertClean();
  console.log('PASS invalid ranges and undecodable source fail without leaking');

  const cancellation = await page.evaluate(async () => {
    const outcomes = [];
    for (const phase of ['before', 'preparing', 'rendering', 'finalizing']) {
      const controller = new AbortController();
      if (phase === 'before') controller.abort();
      try {
        await exportModule.exportClip({ file: fixture, start: 2.2, end: 2.8, signal: controller.signal, onProgress: p => {
          if (p.phase === phase && (phase !== 'rendering' || p.progress > 0.15)) controller.abort();
        } });
        outcomes.push('unexpected success');
      } catch (error) { outcomes.push(error.name); }
    }
    return outcomes;
  });
  assert.deepEqual(cancellation, ['AbortError', 'AbortError', 'AbortError', 'AbortError']);
  await assertClean();
  console.log('PASS cancellation before/during load, during recording, and finalization');

  const autoplay = await page.evaluate(async () => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Test playback restriction', 'NotAllowedError'));
    try { await exportModule.exportClip({ file: fixture, start: 0, end: 1 }); return 'unexpected success'; }
    catch (error) { return error.message; }
    finally { HTMLMediaElement.prototype.play = play; }
  });
  assert.match(autoplay, /blocked playback/);
  await assertClean();
  console.log('PASS explicit playback-permission error');

  await render('retry-after-cancel', 2.3, 3.3);
  await render('no-audio-source', 2.2, 3.4, true);
  const sourceEnd = await page.evaluate(() => document.querySelector('#preview').duration);
  await render('source-end', 4.5, sourceEnd);
  const concurrent = await page.evaluate(async () => {
    const controller = new AbortController();
    const a = exportModule.exportClip({ file: fixture, start: 0.2, end: 1.2, signal: controller.signal, onProgress: p => {
      if (p.phase === 'rendering' && p.progress > 0.2) controller.abort();
    } });
    const b = exportModule.exportClip({ file: fixture, start: 2.2, end: 3.2 });
    const results = await Promise.allSettled([a, b]);
    return results.map(r => r.status === 'rejected' ? r.reason.name : { size: r.value.blob.size, type: r.value.mimeType });
  });
  assert.equal(concurrent[0], 'AbortError');
  assert(concurrent[1].size > 1000);
  await assertClean();
  assert.deepEqual(pageErrors, []);
  console.log('PASS concurrent isolation, preview untouched, no page errors or object-URL leaks');
  console.log('All local export integration tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (process.env.KEEP_STUDIO_EXPORT_ARTIFACTS) console.log(`Export QA artifacts: ${temp}`);
  else fs.rmSync(temp, { recursive: true, force: true });
});
