import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LYRICS_FORMAT,
  parseLyrics,
  parseLyricsText,
  serializeLyrics,
} from '../src/lib/lyrics-json.js'

const ID = 'BBV16y4y127Dz'
const OTHER = 'BBV1AA411p7zs'

test('round trip keeps verdicts and metadata', () => {
  const entries = new Map([
    [
      ID,
      {
        lyrics: true,
        confidence: 0.91234,
        source: 'detected',
        at: '2026-01-01T00:00:00.000Z',
      },
    ],
    [OTHER, { lyrics: false, confidence: null, source: 'manual', at: null }],
  ])
  const { text, count } = serializeLyrics(entries, { threshold: 0.5 })
  assert.equal(count, 2)
  const document = JSON.parse(text)
  assert.equal(document.format, LYRICS_FORMAT)
  assert.equal(document.version, 1)
  assert.equal(document.threshold, 0.5)

  const parsed = parseLyrics(text)
  assert.equal(parsed.entries.get(ID).lyrics, true)
  assert.equal(parsed.entries.get(ID).confidence, 0.9123)
  assert.equal(parsed.entries.get(ID).source, 'detected')
  assert.equal(parsed.entries.get(OTHER).lyrics, false)
  assert.equal(parsed.entries.get(OTHER).source, 'manual')
})

test('the lyrics file cannot be mistaken for a vector file', () => {
  assert.throws(() => parseLyrics(JSON.stringify({ [ID]: [0.1, 0.2] })), /format/)
  assert.throws(() => parseLyrics('not json'), /not valid JSON/)
  assert.throws(
    () => parseLyrics(JSON.stringify({ format: LYRICS_FORMAT, version: 99, tracks: {} })),
    /version/,
  )
})

test('malformed entries are rejected', () => {
  const document = (tracks) =>
    JSON.stringify({ format: LYRICS_FORMAT, version: 1, tracks })
  assert.throws(
    () => parseLyrics(document({ [ID]: { lyrics: 'yes' } })),
    /lyrics must be/,
  )
  assert.throws(
    () => parseLyrics(document({ [ID]: { lyrics: true, confidence: 2 } })),
    /confidence/,
  )
  assert.throws(() => parseLyrics(document({ nope: { lyrics: true } })), /nope/)
  assert.throws(
    () => parseLyrics(JSON.stringify({ format: LYRICS_FORMAT, version: 1 })),
    /tracks/,
  )
})

test('missing confidence and source default cleanly', () => {
  const entries = parseLyricsText(
    JSON.stringify({
      format: LYRICS_FORMAT,
      version: 1,
      tracks: { [ID]: { lyrics: false } },
    }),
  )
  assert.deepEqual(entries.get(ID), {
    lyrics: false,
    confidence: null,
    source: 'detected',
    at: null,
  })
})

test('detected verdicts keep their source', () => {
  const entries = new Map([
    [ID, { lyrics: true, confidence: 0.7, source: 'detected', at: null }],
  ])
  const parsed = parseLyrics(serializeLyrics(entries).text)
  assert.equal(parsed.entries.get(ID).source, 'detected')
  assert.equal(parsed.entries.get(ID).lyrics, true)
})
