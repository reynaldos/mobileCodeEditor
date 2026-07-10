import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDb } from './db.ts'
import { Pusher, type SendFn } from './push.ts'
import { PushStore, type PushSubscription } from './push-store.ts'

const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:x@y.z' }

const sub = (endpoint: string): PushSubscription => ({
  endpoint,
  keys: { p256dh: 'p', auth: 'a' },
})

function freshStore(...endpoints: string[]): PushStore {
  const store = new PushStore(openDb(':memory:'))
  for (const e of endpoints) store.add(sub(e), 1000)
  return store
}

test('a Pusher with no VAPID is disabled and sends nothing', async () => {
  const store = freshStore('https://push/1')
  const sent: string[] = []
  const pusher = new Pusher(store, undefined, async (s) => {
    sent.push(s.endpoint)
    return { statusCode: 201 }
  })

  assert.equal(pusher.enabled, false)
  assert.equal(await pusher.notify({ title: 't', body: 'b' }, 1), 0)
  assert.deepEqual(sent, [])
})

test('notify fans out to every device and reports the delivered count', async () => {
  const store = freshStore('https://push/1', 'https://push/2', 'https://push/3')
  const got: Array<{ endpoint: string; payload: string }> = []
  const send: SendFn = async (s, payload) => {
    got.push({ endpoint: s.endpoint, payload })
    return { statusCode: 201 }
  }

  const delivered = await new Pusher(store, VAPID, send).notify(
    { title: 'Claude needs you', body: 'edit foo.ts', url: '/', tag: 'approval' },
    2000,
  )

  assert.equal(delivered, 3)
  assert.equal(got.length, 3)
  const payload = JSON.parse(got[0]!.payload)
  assert.deepEqual(payload, { title: 'Claude needs you', body: 'edit foo.ts', url: '/', tag: 'approval' })
})

test('a 410 Gone prunes the dead subscription — the reinstall-corpse case', async () => {
  const store = freshStore('https://push/live', 'https://push/dead')
  const send: SendFn = async (s) => {
    if (s.endpoint.endsWith('dead')) throw { statusCode: 410 }
    return { statusCode: 201 }
  }

  const delivered = await new Pusher(store, VAPID, send).notify({ title: 't', body: 'b' }, 1)

  assert.equal(delivered, 1)
  assert.deepEqual(
    store.all().map((s) => s.endpoint),
    ['https://push/live'],
    'the dead endpoint is gone; the live one remains',
  )
})

test('a 404 prunes too, but a transient 500 does not', async () => {
  const store = freshStore('https://push/404', 'https://push/500')
  const send: SendFn = async (s) => {
    throw { statusCode: s.endpoint.endsWith('404') ? 404 : 500 }
  }

  await new Pusher(store, VAPID, send).notify({ title: 't', body: 'b' }, 1)

  assert.deepEqual(
    store.all().map((s) => s.endpoint),
    ['https://push/500'],
    '404 is pruned, 500 is kept for a retry',
  )
})

test('notify never rejects, even if every send throws', async () => {
  const store = freshStore('https://push/1')
  const pusher = new Pusher(store, VAPID, async () => {
    throw new Error('network down')
  })

  // A failed push must not take down whatever triggered it.
  assert.equal(await pusher.notify({ title: 't', body: 'b' }, 1), 0)
})

test('a successful send stamps last_ok_at', async () => {
  const store = freshStore('https://push/1')
  await new Pusher(store, VAPID, async () => ({ statusCode: 201 })).notify({ title: 't', body: 'b' }, 5555)

  assert.equal(store.lastOkAt('https://push/1'), 5555)
})

test('re-subscribing the same endpoint refreshes rather than duplicates', () => {
  const store = new PushStore(openDb(':memory:'))
  store.add(sub('https://push/1'), 1000)
  store.add({ endpoint: 'https://push/1', keys: { p256dh: 'NEW', auth: 'NEW' } }, 2000)

  assert.equal(store.count(), 1)
  assert.equal(store.all()[0]?.keys.p256dh, 'NEW')
})
