'use strict';

// حارس حي لمسار التسجيل والحفظ الإنتاجي، بلا محرك مدفوع أو إذن ملف محقون.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { BrowserWindow, webContents } = require('electron');
const promo = require('../electron/promocapture');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function smoke({ owner, run, recordStart, recordStop, evidence }) {
  const fixture = http.createServer((request, response) => {
    if (request.url === '/fixture.css') {
      response.writeHead(200, { 'content-type': 'text/css' });
      // لون علامة اصطناعية لفحص بكسلات الفيديو؛ ليس نمطاً جديداً لواجهة المنتج.
      response.end('body{margin:0;background:rgb(0,255,0);color:black;font:24px sans-serif}.detail{width:256px;height:64px;background:repeating-linear-gradient(to right,#000 0px,#000 1px,#fff 1px,#fff 2px)}.marker{width:80px;height:80px;background:rgb(255,0,255);animation:move 1s infinite alternate}@keyframes move{to{transform:translateX(180px)}}');
    } else {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="en" dir="ltr"><head><link rel="stylesheet" href="/fixture.css"></head><body><h1>LIVE PREVIEW 314159</h1><div class="detail"></div><div class="marker"></div></body></html>');
    }
  });
  let decoder;
  try {
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + fixture.address().port;
    const hd = process.argv.includes('--recording-hd');
    if (!hd) owner.setSize(1180, 800);
    owner.show();
    // المنزل نظيف بلا دخول محرك: نجهّز سطح الالتقاط فقط، ولا نبث gate-ready ولا نثبت جاهزية محرك.
    await owner.webContents.executeJavaScript('(async()=>{const gate=document.querySelector("satr-gate");const until=Date.now()+20000;while(gate._btn.disabled&&Date.now()<until)await new Promise(r=>setTimeout(r,100));if(gate._btn.disabled)throw Error("gate_probe_timeout");gate.hidden=true;const panel=document.querySelector("satr-preview-panel");await panel.openWith(' + JSON.stringify(url) + ');return true;})()');
    const preview = require('../electron/preview');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && String(preview.currentUrl() || '').replace(/\/$/, '') !== url) await wait(100);
    assert.strictEqual(preview.currentUrl().replace(/\/$/, ''), url, 'production preview must remain the test page');
    const page = webContents.getAllWebContents().find(wc => wc.getURL().replace(/\/$/, '') === url);
    assert(page, 'production preview must have its own renderer');
    await page.executeJavaScript('(async()=>{const until=Date.now()+15000;while((document.readyState!=="complete"||!document.querySelector(".marker"))&&Date.now()<until)await new Promise(r=>setTimeout(r,50));if(!document.querySelector(".marker"))throw Error("fixture_not_ready");await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()');
    // العلامة بعرض بكسل فعلي واحد؛ بكسل CSS يكبر مع كثافة الشاشة أو تقريب صفحة المعاينة.
    const scale = await page.executeJavaScript(`(async () => {
      const scale = window.devicePixelRatio;
      if (!Number.isFinite(scale) || scale <= 0) throw Error('bad_pixel_ratio');
      const rule = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
        .find(rule => rule.selectorText === '.detail');
      if (!rule) throw Error('detail_rule_missing');
      const pixel = 1 / scale;
      rule.style.backgroundImage = 'repeating-linear-gradient(to right,#000 0px,#000 '
        + pixel + 'px,#fff ' + pixel + 'px,#fff ' + (pixel * 2) + 'px)';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return scale;
    })()`);
    const detailBounds = await page.executeJavaScript('(()=>{const r=document.querySelector(".detail").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');
    const pageView = owner.contentView.children.find(view => view.webContents === page);
    assert(pageView, 'preview must be attached to the test window');
    const viewBounds = pageView.getBounds();
    const detailSample = { x: (viewBounds.x + detailBounds.x + 20) * scale,
      y: (viewBounds.y + detailBounds.y + 32) * scale, step: 1, count: 200 };
    const pageImage = await page.capturePage();
    fs.writeFileSync(path.join(run.paths.evidence, 'preview-source.png'), pageImage.toPNG());
    owner.moveTop();
    owner.focus();
    const before = await owner.webContents.capturePage();
    fs.writeFileSync(path.join(run.paths.evidence, 'before-recording.png'), before.toPNG());
    const started = await recordStart('app-window-smoke');
    assert(started.ok, 'app window recording must start: ' + started.error);
    assert.strictEqual(promo.currentWebContents(), null, 'recording must not redirect browser tools into Satr');
    await wait(1800);
    // IPC الإيقاف الحقيقي يستدعي stopAll({scope:run})؛ يجب أن يستمر تسجيل تجربة عدة أدوار.
    await owner.webContents.executeJavaScript('window.satr.stop()');
    assert(!owner.isDestroyed(), 'stopping a turn must preserve the test app');
    await wait(2000);
    const stopped = await recordStop();
    assert(stopped.ok, 'production download must complete: ' + stopped.error);
    assert(!owner.isDestroyed(), 'stopping recording must preserve the test app');
    assert.strictEqual(preview.currentUrl().replace(/\/$/, ''), url, 'recording must preserve the preview URL');
    const segment = promo.listSegments().segments.find(item => item.path === stopped.path);
    assert(segment && segment.available && segment.target_kind === 'app-window'
      && segment.scenario === 'app-window-smoke' && segment.test_run === run.id, 'saved segment must retain scenario ownership');
    assert.strictEqual(segment.timing_quality, 'unverified', 'no fabricated beacon timing');
    const header = fs.readFileSync(stopped.path).subarray(0, 32);
    if (stopped.path.endsWith('.mp4')) assert(header.toString('latin1').includes('ftyp'), 'MP4 must have an actual file header');
    decoder = new BrowserWindow({ show: false, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      partition: 'live-test-decoder',
    } });
    const decoderPage = path.join(run.paths.evidence, 'decoder.html');
    fs.writeFileSync(decoderPage, '<!doctype html><html lang="en"><body><video preload="auto" muted></video></body></html>', { flag: 'wx' });
    await decoder.loadFile(decoderPage);
    const frames = await decoder.webContents.executeJavaScript('document.querySelector("video").src=' + JSON.stringify(pathToFileURL(stopped.path).href) + ';(' + decodeFrames.toString() + ')(' + JSON.stringify(hd ? detailSample : null) + ')', true);
    for (let index = 0; index < frames.length; index++) {
      fs.writeFileSync(path.join(run.paths.evidence, 'decoded-frame-' + index + '.png'),
        Buffer.from(frames[index].png.split(',')[1], 'base64'));
    }
    console.log('LIVE_TEST_FRAMES ' + JSON.stringify(frames.map(({ png, ...data }) => data)));
    assert(frames.length === 2 && frames.every(frame => frame.width > 700 && frame.height > 400), 'two decoded frames must show desktop dimensions');
    assert(frames.every(frame => frame.width === segment.width && frame.height === segment.height), 'saved dimensions must match decoded video');
    if (hd) {
      assert(frames.every(frame => frame.width >= 1920 && frame.height >= 1080), 'HD recording must contain at least 1920x1080 native pixels');
      assert(frames.every(frame => frame.detailContrast >= 180), 'HD recording must preserve one-pixel detail contrast >= 180');
    }
    assert(frames.every(frame => frame.green > 5000), 'recording must include the actual preview BrowserView');
    assert(frames.every(frame => frame.other > frame.green / 2), 'recording must include Satr around the preview');
    evidence('scenario', 'passed', { scenario: 'app-window-smoke', frames: frames.length,
      width: frames[0].width, height: frames[0].height, bytes: stopped.bytes, durationMs: stopped.durationMs,
      file: path.basename(stopped.path), sha256: stopped.sha256 });
    console.log('LIVE_TEST_VIDEO ' + JSON.stringify({ path: stopped.path, bytes: stopped.bytes,
      durationMs: stopped.durationMs, frames: frames.map(({ png, ...data }) => data),
      scope: 'recording_download_preview_stop_ipc', realModel: false, hd, detailBounds }));
  } finally {
    if (decoder && !decoder.isDestroyed()) decoder.destroy();
    await new Promise(resolve => fixture.close(resolve));
  }
};

async function decodeFrames(detailSample) {
  const video = document.querySelector('video');
  if (!video) throw new Error('missing_video');
  video.pause();
  if (video.readyState < 1) await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('decode_failed')), { once: true });
  });
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  const frames = [];
  for (const time of [1, 3]) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('seek_timeout')), 8000);
      video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
      video.currentTime = time;
    });
    ctx.drawImage(video, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let green = 0, other = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 50 && pixels[index + 1] > 200 && pixels[index + 2] < 50) green++;
      else other++;
    }
    let detailContrast = null;
    if (detailSample) {
      const sums = [0, 0], y = Math.round(detailSample.y);
      for (let column = 0; column < detailSample.count; column++) {
        const x = Math.floor(detailSample.x + (column + 0.5) * detailSample.step);
        const offset = (y * canvas.width + x) * 4;
        sums[column % 2] += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
      }
      detailContrast = Math.abs(sums[0] - sums[1]) / (detailSample.count / 2);
    }
    frames.push({ width: canvas.width, height: canvas.height, green, other, detailContrast, png: canvas.toDataURL('image/png') });
  }
  return frames;
}
