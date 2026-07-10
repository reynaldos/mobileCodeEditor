/*
 * Service worker — push notifications only.
 *
 * Hand-written on purpose, not vite-plugin-pwa. This app is useless offline by
 * definition (it's a view over a server's log), so there is nothing to precache
 * and no offline shell to maintain. Two event handlers is the whole job.
 *
 * See docs/PHASE-1.md.
 */

self.addEventListener('push', (event) => {
  const data = safeJson(event)

  event.waitUntil(
    (async () => {
      // Suppress if the app is already open and visible: buzzing the phone in
      // your hand while you read the very card it points at is worse than useless.
      // iOS requires userVisibleOnly, so we cannot receive a push and show
      // nothing — the decision has to happen here, in the handler.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const visible = clients.some((c) => c.visibilityState === 'visible')
      if (visible) return

      await self.registration.showNotification(data.title || 'Claude', {
        body: data.body || '',
        // Same tag replaces rather than stacks — a debounced approval burst is
        // one notification, and a later one supersedes the last.
        tag: data.tag || 'mce',
        renotify: true,
        data: { url: data.url || '/' },
        // No icon/badge yet — iOS uses the home-screen icon regardless, and a
        // reference to a missing file is worse than none. Add when we have art.
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

      // Focus an existing window rather than spawning a second one.
      for (const client of clients) {
        if ('focus' in client) {
          await client.focus()
          if ('navigate' in client && url !== '/') await client.navigate(url).catch(() => {})
          return
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})

function safeJson(event) {
  try {
    return event.data ? event.data.json() : {}
  } catch {
    return {}
  }
}
