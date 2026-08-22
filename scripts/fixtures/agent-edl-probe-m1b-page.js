// سكربت fixture مفصول عن HTML اتباعاً لنمط المشروع (حارس CSP يرفض الكتل المضمّنة).
// البكسل المقروء في التحليل يقع خارج اللوحة؛ لذلك تغيّر المنارة خلفية الجذر كلها.
const baseline = [17, 24, 39];
const syncStartColor = [248, 248, 248];
const syncEndColor = [248, 248, 30];
const palette = [
  [230, 40, 55], [20, 190, 80], [35, 90, 230], [235, 190, 30], [190, 40, 200],
  [25, 190, 210], [235, 105, 25], [100, 60, 210], [140, 210, 35], [235, 70, 140],
];
let syncTimer = null;
let motionFrame = 0;
const eventLog = [];
const stamp = (kind, index = null) => {
  const entry = { kind, index, date_now_ms: Date.now(), performance_now_ms: performance.now() };
  eventLog.push(entry);
  return entry;
};
const setColor = (color, label) => {
  document.documentElement.style.backgroundColor = `rgb(${color.join(',')})`;
  document.getElementById('state').textContent = `state=${label}`;
};
window.__edlM1bReady = true;
window.__edlM1bPalette = palette;
window.__getEdlM1bEvents = () => eventLog.map((entry) => ({ ...entry }));
window.__resetEdlM1b = () => {
  clearTimeout(syncTimer);
  cancelAnimationFrame(motionFrame);
  motionFrame = 0;
  eventLog.length = 0;
  setColor(baseline, 'baseline');
};
window.__startEdlM1bMotion = () => {
  clearTimeout(syncTimer);
  let index = 0;
  const tick = () => {
    index = (index + 1) % 360;
    document.documentElement.style.backgroundColor = `hsl(${index} 92% 48%)`;
    document.getElementById('state').textContent = `motion=${index}`;
    motionFrame = requestAnimationFrame(tick);
  };
  tick();
};
window.__stopEdlM1bMotion = window.__resetEdlM1b;
document.getElementById('sync-beacon-start').addEventListener('click', () => {
  clearTimeout(syncTimer);
  stamp('sync_start');
  setColor(syncStartColor, 'sync-start');
  syncTimer = setTimeout(() => setColor(baseline, 'baseline'), 700);
});
document.getElementById('sync-beacon-end').addEventListener('click', () => {
  clearTimeout(syncTimer);
  stamp('sync_end');
  setColor(syncEndColor, 'sync-end');
  syncTimer = setTimeout(() => setColor(baseline, 'baseline'), 700);
});
for (let index = 0; index < palette.length; index += 1) {
  document.getElementById(`agent-${index}`).addEventListener('click', () => {
    clearTimeout(syncTimer);
    stamp('action', index);
    setColor(palette[index], index + 1);
  });
}
  