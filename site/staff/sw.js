/* Contrail Staff service worker: works like an app (opens offline), shows phone alerts, opens the right request when tapped. */
const CACHE = "contrail-staff-v6";
const SHELL = ["./", "staff.js?v=6", "../config.js?v=2", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// The app's own files: use the network when it's there (always fresh), fall back to the saved copy when offline.
// Customer data from Supabase is never cached here.
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET") return;
  const ours = u.origin === location.origin && u.pathname.includes("/Contrail/");
  const lib = u.hostname === "cdn.jsdelivr.net";
  if (!ours && !lib) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(r);
      if (res.ok && (ours || lib)) { const c = await caches.open(CACHE); c.put(r, res.clone()); }
      return res;
    } catch (err) {
      const hit = await caches.match(r, {ignoreSearch: r.mode === "navigate"});
      if (hit) return hit;
      if (r.mode === "navigate") { const shell = await caches.match("./"); if (shell) return shell; }
      throw err;
    }
  })());
});

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {title: "Contrail", body: e.data ? e.data.text() : ""}; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || "Contrail", {
      body: d.body || "", tag: d.tag, renotify: !!d.tag, icon: "icon-192.png", badge: "icon-192.png", data: {url: d.url || "./"}
    }),
    (self.navigator && self.navigator.setAppBadge) ? self.navigator.setAppBadge().catch(() => {}) : null
  ]));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    for (const w of wins) if (w.url.includes("/staff/")) { await w.focus(); w.postMessage({open: url}); return; }
    await self.clients.openWindow(url);
  })());
});
