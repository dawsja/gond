self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Gond", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      const url = new URL(data.url || "/app", self.location.origin);
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const inFront = clients.some((client) => client.focused && client.visibilityState === "visible" && new URL(client.url).pathname === url.pathname);
      if (inFront) return;
      await self.registration.showNotification(data.title || "Gond", {
        body: data.body || "",
        tag: data.tag || undefined,
        renotify: Boolean(data.tag),
        icon: "/logo.png",
        badge: "/logo.png",
        data: { url: url.href },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/app";
  event.waitUntil(
    (async () => {
      const target = new URL(url, self.location.origin);
      const clients = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((client) => new URL(client.url).origin === self.location.origin);
      const client = clients.find((c) => new URL(c.url).pathname === target.pathname) || clients[0];
      if (client) {
        const focused = await client.focus();
        if (new URL(client.url).href !== target.href && "navigate" in client) await client.navigate(target.href);
        if (focused) return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
