// سكربت fixture مفصول عن HTML اتباعاً لنمط المشروع (حارس CSP يرفض الكتل المضمّنة).
// المنارة تغطي الخلفية كلها كي يكشفها محلل الإطارات من بكسل بعيد عن عناصر الواجهة.
const palette = [
  [230, 40, 55], [20, 190, 80], [35, 90, 230], [235, 190, 30], [190, 40, 200],
  [25, 190, 210], [235, 105, 25], [100, 60, 210], [140, 210, 35], [235, 70, 140],
];
window.__edlProbeReady = true;
window.__edlProbePalette = palette;
window.__setEdlBeacon = (index) => {
  const color = palette[index];
  document.documentElement.style.backgroundColor = `rgb(${color.join(',')})`;
  document.getElementById('state').textContent = `state=${index + 1}`;
  document.documentElement.dataset.beacon = String(index);
};
for (let index = 0; index < palette.length; index += 1) {
  document.getElementById(`agent-${index}`).addEventListener('click', () => window.__setEdlBeacon(index));
}
document.getElementById('human-stop').addEventListener('mousedown', (event) => event.stopPropagation());
  