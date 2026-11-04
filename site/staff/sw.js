/* Contrail Staff service worker: shows phone alerts and opens the right call request when tapped. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});   // lets the dashboard be installed as an app; pages still load from the network

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {title: "Contrail", body: e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(d.title || "Contrail", {
    body: d.body || "", tag: d.tag, renotify: !!d.tag, icon: "icon-192.png", badge: "icon-192.png", data: {url: d.url || "./"}
  }));
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
