import assert from 'node:assert/strict'
import test from 'node:test'

test('background and all extension modules resolve their imports', async () => {
  let listenerRegistered = false
  globalThis.chrome = {
    runtime: {
      id: 'module-test',
      getURL: (path) => `chrome-extension://module-test/${path}`,
      onMessage: { addListener: () => { listenerRegistered = true } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    storage: { local: { get: async () => ({}), remove: async () => {} } },
    identity: {
      getRedirectURL: (path) => `https://module-test.chromiumapp.org/${path || ''}`,
    },
  }

  await import('../src/background.js')
  assert.equal(listenerRegistered, true)

  for (const module of [
    '../src/lib/config.js',
    '../src/lib/storage.js',
    '../src/lib/db.js',
    '../src/lib/auth.js',
    '../src/lib/embed-api.js',
    '../src/lib/embeddings.js',
    '../src/lib/embedding-json.js',
    '../src/lib/playlist.js',
    '../src/lib/algorithm.js',
  ]) {
    await import(module)
  }
})
