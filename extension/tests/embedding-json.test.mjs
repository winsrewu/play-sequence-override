import assert from 'node:assert/strict'
import test from 'node:test'

import {
  internalIdFromEmbeddingName,
  parseEmbeddingJson,
  parseEmbeddingText,
} from '../src/lib/embedding-json.js'

function vector(value = 0.5) {
  return Array.from({ length: 960 }, () => value)
}

test('C embedding names map to internal ids', () => {
  assert.equal(internalIdFromEmbeddingName('BV1114y127ih.mp3'), 'BBV1114y127ih')
  assert.equal(internalIdFromEmbeddingName('BBV1114y127ih.mp3'), 'BBV1114y127ih')
  assert.equal(internalIdFromEmbeddingName('BV1Xx4y1277K_2.mp3'), 'BBV1Xx4y1277K_2')
  assert.equal(internalIdFromEmbeddingName('av123.mp3'), null)
})

test('parses the C data shape and skips non-Bilibili names', () => {
  const vectors = parseEmbeddingJson({
    data: [
      { name: 'BV1114y127ih.mp3', embed: vector(0.25) },
      { name: 'av123.mp3', embed: vector(0.5) },
    ],
  })
  assert.equal(vectors.size, 1)
  assert.equal(vectors.get('BBV1114y127ih')[0], 0.25)
})

test('rejects wrong dimensions and conflicts', () => {
  assert.throws(
    () => parseEmbeddingJson({ data: [{ name: 'BV1114y127ih.mp3', embed: [0.1] }] }),
    /expected 960/,
  )
  assert.throws(
    () =>
      parseEmbeddingJson({
        data: [
          { name: 'BV1114y127ih.mp3', embed: vector(0.1) },
          { name: 'BBV1114y127ih.mp3', embed: vector(0.2) },
        ],
      }),
    /conflicting/,
  )
})

test('parseEmbeddingText rejects malformed JSON', () => {
  assert.throws(() => parseEmbeddingText('{'), /invalid/)
})

test('real C file shape is accepted', () => {
  const names = ['BV1114y127ih', 'BV113411U7F5', 'BV1184y1Q7Y3', 'BV1194y157LF', 'BV11G4y1d7am']
  const document = {
    data: names.map((name, index) => ({
      name: `${name}.mp3`,
      embed: vector(index / 10),
    })),
  }
  const vectors = parseEmbeddingJson(document)
  assert.equal(vectors.size, 5)
})

test('a legacy data folder may include music.json alongside the vectors', () => {
  const vectors = parseEmbeddingJson({
    data: [
      { inner_id: 'BBV16y4y127Dz', title: 'music.json entry' },
      { name: '', embed: vector(0.1) },
      { name: 'BV1114y127ih.mp3', embed: vector(0.25) },
    ],
  })
  assert.equal(vectors.size, 1)
  assert.equal(vectors.get('BBV1114y127ih')[0], 0.25)
})
