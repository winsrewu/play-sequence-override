import assert from 'node:assert/strict'
import test from 'node:test'

import { batchEmbedUrl } from '../src/lib/embed-api.js'

test('the batch url derives from the embed url', () => {
  assert.equal(
    batchEmbedUrl('https://embed.jawbts.org/v1/embed'),
    'https://embed.jawbts.org/v1/embeddings',
  )
  assert.equal(
    batchEmbedUrl('http://localhost:8000/v1/embed/'),
    'http://localhost:8000/v1/embeddings',
  )
})

test('custom urls without the known path are not rewritten', () => {
  assert.equal(batchEmbedUrl('https://example.test/embed'), null)
  assert.equal(batchEmbedUrl(''), null)
})
