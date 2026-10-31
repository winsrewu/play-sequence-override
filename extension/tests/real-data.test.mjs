import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

import { dataDir } from './data-dir.mjs'

import { Recommender } from '../src/lib/algorithm.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

test('the bundled catalog and embedding matrix agree', () => {
  const catalog = JSON.parse(readFileSync(path.join(dataDir, 'music.v2.json'), 'utf8'))
  const index = JSON.parse(readFileSync(path.join(dataDir, 'embeddings-index.json'), 'utf8'))
  const buffer = readFileSync(path.join(dataDir, 'embeddings.bin'))
  assert.equal(index.dim, 960)
  assert.equal(index.count, index.ids.length)
  assert.equal(buffer.byteLength, index.count * index.dim * 4)

  const data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
  const vectors = new Map()
  for (let row = 0; row < index.ids.length; row += 1) {
    vectors.set(index.ids[row], data.subarray(row * index.dim, (row + 1) * index.dim))
  }
  const catalogIds = new Set(catalog.tracks.map((track) => track.id))
  for (const id of index.ids) assert.ok(catalogIds.has(id), id)

  const recommender = new Recommender({ tracks: catalog.tracks, vectors })
  assert.equal(recommender.size, index.count)
  assert.equal(recommender.dim, 960)

  const current = index.ids[0]
  const history = [current, index.ids[1], index.ids[2]]
  const next = recommender.selectNext(current, history, 0.7, Math.random, {})
  assert.ok(recommender.has(next))
  assert.notEqual(next, current)
  assert.ok(!history.includes(next))

  const { probabilities } = recommender.probabilities(current, history, 0.7, {})
  assert.ok(probabilities.size > 1000)
  const total = [...probabilities.values()].reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
})
