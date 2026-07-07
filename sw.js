/* Service Worker —— 网络优先离线缓存（在线永远拿最新，离线才回退缓存；file:// 打开会自动跳过） */
const CACHE = 'eng3000-v15';
const ASSETS = [
  './', './index.html', './styles.css', './app.js',
  './data/day1.js', './data/day2.js', './data/day3.js', './data/day4.js', './data/day5.js',
  './data/day6.js', './data/day7.js', './data/day8.js', './data/day9.js', './data/day10.js',
  './data/day11.js', './data/day12.js', './data/day13.js', './data/day14.js', './data/day15.js',
  './data/day16.js', './data/day17.js', './data/day18.js', './data/day19.js', './data/day20.js',
  './data/day21.js', './data/day22.js', './data/day23.js', './data/day24.js', './data/day25.js',
  './data/day26.js', './data/day27.js', './data/day28.js', './data/day29.js', './data/day30.js',
  './manifest.webmanifest', './icon.svg'
];
const ASSET_PATHS = new Set(ASSETS.map(path => new URL(path, self.location.href).pathname));
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !ASSET_PATHS.has(url.pathname)) return;
  // 网络优先：在线时总是取最新并回填缓存；断网才回退缓存（忽略 ?v= 版本号匹配）
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })
      .then(hit => hit || caches.match(url.pathname)))
  );
});
