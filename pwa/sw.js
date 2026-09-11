/**
 * سطر — Service Worker للتحكم من الجوال
 *
 * - push فارغ: يوقظ الجهاز فقط، والتطبيق يسحب الظرف المعمّى عبر long-poll
 * - كاش القشرة وملفات الخط المحلية؛ تعمل من الجذر أو تحت /pwa/.
 */
// رفع النسخة يُبطل الكاش القديم في `activate` — إلزامي مع أي تغيير في أصول القشرة.
const CACHE_NAME = 'satr-pwa-v16';
const SHELL_ASSETS = [
  './index.html',
  './app.js',
  './crypto.js',
  './styles.css',
  './fonts.css',
  './fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2',
  './fonts/ibm-plex-sans-arabic-latin-400-normal.woff2',
  './fonts/ibm-plex-sans-arabic-arabic-500-normal.woff2',
  './fonts/ibm-plex-sans-arabic-latin-500-normal.woff2',
  './fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2',
  './fonts/ibm-plex-sans-arabic-latin-700-normal.woff2',
  './icon.svg',
  './manifest.webmanifest'
];
// موضع العامل هو أساس القشرة: قناة LAN تخدمها من /، وقد يستضيفها الوسيط تحت /pwa/.
const SHELL_BASE = new URL('./', self.location.href);
const SHELL_URLS = new Set(SHELL_ASSETS.map((asset) => new URL(asset, SHELL_BASE).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // مدخل المجلد هو index.html؛ معاملات النسخة لا تصنع مدخلاً آخر للكاش.
  const shellUrl = new URL(url.pathname === SHELL_BASE.pathname ? './index.html' : url.pathname, SHELL_BASE);
  if (!SHELL_URLS.has(shellUrl.href)) return;

  // الشبكة أولاً والكاش احتياط عند الانقطاع.
  // كان `cache-first`: الهاتف يواصل تشغيل نسخة قديمة من `app.js` بعد إصلاحها على
  // سطح المكتب، فيبدو العطل قائماً وقد أُصلح — أهدر ذلك جولة تشخيص كاملة.
  // القناة على الشبكة المحلية والتطبيق يستقصيها أصلاً، فكلفة الشبكة أولاً معدومة.
  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response && response.ok) {
          const copy = response.clone();
          await caches.open(CACHE_NAME).then((cache) => cache.put(shellUrl.href, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.open(CACHE_NAME).then((cache) => cache.match(shellUrl.href))
        .then((cached) => cached || Promise.reject(new Error('offline'))))
  );
});

self.addEventListener('push', (event) => {
  // إشعار فارغ: لا يحمل محتوى، يوقظ فقط
  event.waitUntil(
    self.registration.showNotification('سطر', {
      body: 'طلب إذن جديد في انتظارك',
      icon: './icon.svg',
      badge: './icon.svg',
      tag: 'satr-permission',
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      if (clients.length) {
        clients[0].focus();
      } else {
        self.clients.openWindow('./index.html');
      }
    })
  );
});
