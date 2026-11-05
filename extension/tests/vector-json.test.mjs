import assert from 'node:assert/strict'
import test from 'node:test'

import { parseVectors, serializeVectors } from '../src/lib/vector-json.js'

const ID_A = 'BBV16y4y127Dz'
const ID_B = 'BBV1Xx4y1277K_2'

function sample() {
  return new Map([
    [ID_A, Float32Array.from([1, 2, 3, 4])],
    [ID_B, Float32Array.from([5, 6, 7, 8])],
  ])
}

test('vectors round-trip as id: vector JSON', () => {
  const { text, count } = serializeVectors(sample())
  assert.equal(count, 2)
  const document = JSON.parse(text)
  assert.deepEqual(Object.keys(document), [ID_A, ID_B].sort())
  assert.deepEqual(document[ID_A], [1, 2, 3, 4])
  assert.deepEqual(document[ID_B], [5, 6, 7, 8])

  const parsed = parseVectors(text, { dim: 4 })
  assert.equal(parsed.dim, 4)
  assert.deepEqual([...parsed.vectors.get(ID_A)], [1, 2, 3, 4])
  assert.deepEqual([...parsed.vectors.get(ID_B)], [5, 6, 7, 8])
})

test('an empty library round-trips', () => {
  const { text, count } = serializeVectors(new Map())
  assert.equal(count, 0)
  assert.equal(text.trim(), '{}')
  const parsed = parseVectors(text)
  assert.equal(parsed.vectors.size, 0)
  assert.equal(parsed.dim, 0)
})

test('serialize rejects empty and mixed-length vectors', () => {
  assert.throws(() => serializeVectors(new Map([[ID_A, Float32Array.from([])]])), /empty/)
  assert.throws(
    () => serializeVectors(new Map([[ID_A, Float32Array.from([1, 2])], [ID_B, Float32Array.from([1, 2, 3])]])),
    /mixed vector lengths/,
  )
})

test('parse rejects malformed files', () => {
  assert.throws(() => parseVectors('nope'), /not valid JSON/)
  assert.throws(() => parseVectors('[]'), /root must be an object/)
  assert.throws(() => parseVectors(JSON.stringify({ [ID_A]: 'x' })), /must be an array/)
  assert.throws(() => parseVectors(JSON.stringify({ [ID_A]: [] })), /empty/)
  assert.throws(
    () => parseVectors(JSON.stringify({ [ID_A]: [1, 2], [ID_B]: [1, 2, 3] })),
    /differs from the others/,
  )
  assert.throws(() => parseVectors(JSON.stringify({ [ID_A]: [1, 'x'] })), /non-finite/)
  assert.throws(() => parseVectors(JSON.stringify({ [ID_A]: [1, 2] }), { dim: 4 }), /expected 4/)
  assert.throws(() => parseVectors(JSON.stringify({ nope: [1, 2] })), /nope:/)
})
