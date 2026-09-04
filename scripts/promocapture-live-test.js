#!/usr/bin/env electron
'use strict';

const http = require('http');
const path = require('path');
const { app, BrowserWindow, desktopCapturer } = require('electron');
const promo = require('../electron/promocapture');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function main() {
  await app.whenReady();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>منتج الاختبار</title><style>body{margin:0;background:#17324d;color:white;font:48px sans-serif}.box{width:180px;height:180px;background:#d9a441;animation:move 1s infinite alternate}@keyframes move{to{transform:translateX(500px)}}</style><h1>منتج مرئي</h1><div class="box"></div>');
  });
  const port = await listen(server);
  const url = 'http://127.0.0.1:' + port + '/';
  const receiver = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await receiver.loadURL(url);
  const downloads = app.getPath('downloads');
  let recorded = null;
  let captureContents = null;
  let expectedSourceId = '';
  let controller;
  controller = promo.create({
    BrowserWindow,
    desktopCapturer,
    displaySession: receiver.webContents.session,
    ownerWebContents: receiver.webContents,
    downloadsPath: downloads,
    isHttpUrl: (value) => /^https?:\/\//.test(value),
    readyDelayMs: 300,
    onTarget(webContents) {
      captureContents = webContents;
      const captureWindow = webContents && BrowserWindow.fromWebContents(webContents);
      if (captureWindow) {
        expectedSourceId = captureWindow.getMediaSourceId();
        // OBS-036: الالتقاط يحتاج نافذة مقدَّمة مرسومة — تحت حمل الطقم قد تتغطّى
        // نافذة الالتقاط بنافذة اختبار أخرى فتصل إطارات صفرية. نواجهها ونمنحها التركيز
        // قبل بدء التسجيل.
        captureWindow.moveTop();
        captureWindow.focus();
      }
    },
    emit(event) {
      if (event.type === 'capture_start') {
        recorded = { sourceEnumerated: event.source_enumerated };
        receiver.webContents.executeJavaScript(`(async function(){
          const stream = await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{
            chromeMediaSource:'desktop',chromeMediaSourceId:${JSON.stringify(event.source_id)},
            minFrameRate:30,maxFrameRate:30
          }}});
          const candidates=['video/mp4;codecs=avc1.42E01E','video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm'];
          const mime=candidates.find((item)=>MediaRecorder.isTypeSupported(item))||'';
          window.__promoLive={stream,chunks:[],mime,rec:new MediaRecorder(stream,mime?{mimeType:mime}:{})};
          window.__promoLive.rec.ondataavailable=(chunk)=>{if(chunk.data&&chunk.data.size)window.__promoLive.chunks.push(chunk.data);};
          window.__promoLive.rec.start(100);
          const track=stream.getVideoTracks()[0];
          return {tracks:stream.getVideoTracks().length,settings:track.getSettings(),mime};
        })()`, true).then((result) => {
          recorded.start = result;
          controller.rendererReady(event.session_id, true, '');
        }).catch(() => controller.rendererReady(event.session_id, false, 'media_failed'));
      } else if (event.type === 'capture_stop') {
        receiver.webContents.executeJavaScript(`new Promise((resolve)=>{
          const state=window.__promoLive;
          state.rec.onstop=async()=>{
            const blob=new Blob(state.chunks,{type:state.mime||'video/webm'});
            const bytes=new Uint8Array(await blob.arrayBuffer());
            state.stream.getTracks().forEach((track)=>track.stop());
            resolve({size:blob.size,type:blob.type,head:Array.from(bytes.slice(0,16))});
          };
          state.rec.stop();
        })`, true).then((result) => {
          recorded.stop = result;
          const ext = /mp4/.test(result.type) ? 'mp4' : 'webm';
          const filename = promo.segmentFilename(event.session_id, new Date(), ext);
          controller.rendererCommit(event.session_id, 1000, filename);
          controller.downloadResult({ type: 'promo_recording_saved', filename, path: path.join(downloads, filename) });
        });
      }
    },
  });

  const started = await controller.start({ aspect: '16:9', url });
  if (!started.ok) {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } });
    throw new Error('ERR_FAILED=' + (started.error === 'load_failed') + ' start=' + started.error
      + ' expected=' + expectedSourceId
      + ' sources=' + JSON.stringify(sources.map((source) => ({ id: source.id, name: source.name }))));
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const stopped = await controller.stop();
  if (!stopped.ok || !recorded || !recorded.start || recorded.start.tracks !== 1 || !recorded.stop) {
    throw new Error('فشل stream/MediaRecorder: ' + JSON.stringify({ stopped, recorded }));
  }
  // فشل صريح مميّز لعثرة OBS-036: المسار كله نجح لكن الترميز أنتج صفر بايت —
  // أي لم تصل إطارات، وهذا عطب التقاط النافذة تحت الحمل لا عطب الترميز.
  if (recorded.stop.size === 0 || !recorded.stop.head.length) {
    throw new Error('لم تصل إطارات إلى MediaRecorder رغم نجاح المسار — عثرة بيئية في التقاط (نافذة الالتقاط لم تُرسَم، انظر OBS-036): '
      + JSON.stringify({ stopped, tracks: recorded.start.tracks, frameRate: recorded.start.settings.frameRate, size: recorded.stop.size, head: recorded.stop.head }));
  }
  if (recorded.stop.size < 1024) {
    throw new Error('حجم تسجيل مشبوه (<1024 بايت): ' + JSON.stringify({ stopped, size: recorded.stop.size, head: recorded.stop.head }));
  }
  const mp4 = /mp4/.test(recorded.stop.type);
  const ascii = String.fromCharCode(...recorded.stop.head);
  if (mp4 && !ascii.includes('ftyp')) throw new Error('ملف mp4 بلا ترويسة ftyp');
  await controller.stopAll();
  if (controller.currentWebContents()) throw new Error('نافذة الالتقاط لم تُغلق');
  if (!receiver.isDestroyed()) receiver.destroy();
  await new Promise((resolve) => server.close(resolve));
  console.log('promocapture-live: ERR_FAILED=false · stream=ok · fps=' + (recorded.start.settings.frameRate || 'native')
    + ' · getSources=' + (recorded.sourceEnumerated ? 'matched' : 'self-id-fallback')
    + ' · mime=' + recorded.stop.type + ' · bytes=' + recorded.stop.size + ' · close=ok');
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('promocapture-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
