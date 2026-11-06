import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LANE_INSTRUMENTAL,
  LYRICS_THRESHOLD_DEFAULT,
  LANE_LYRICS,
  formatLyricsRatio,
  laneAt,
  laneCandidates,
  lanePreview,
  lyricsCounts,
  normalizeLyricsShare,
  parseLyricsRatio,
  shareWeights,
} from '../src/lib/lyrics.js'

const lanes = (share, length = 10) => lanePreview(share, length)

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b)
}

test('share defaults, clamps and handles both pure modes', () => {
  assert.equal(normalizeLyricsShare(undefined), 50)
  assert.equal(normalizeLyricsShare(-10), 0)
  assert.equal(normalizeLyricsShare(120), 100)
  assert.equal(normalizeLyricsShare(40), 40)
  assert.equal(normalizeLyricsShare(33.333), 33.33)
})

test('the displayed ratio reaches 0 and +inf', () => {
  assert.equal(formatLyricsRatio(50), '1 : 1')
  assert.equal(formatLyricsRatio(40), '1 : 1.5')
  assert.equal(formatLyricsRatio(20), '1 : 4')
  assert.equal(formatLyricsRatio(0), '0 : 1 (all instrumentals)')
  assert.equal(formatLyricsRatio(100), '1 : 0 (all lyrics)')
  assert.equal(formatLyricsRatio(66.67), '1 : 0.5')
})

test('parsing accepts ratios, infinity, percentages and the old form', () => {
  assert.equal(parseLyricsRatio('1:1.5'), 40)
  assert.equal(parseLyricsRatio('2:3'), 40)
  assert.equal(parseLyricsRatio('1:0'), 100)
  assert.equal(parseLyricsRatio('0:1'), 0)
  assert.equal(parseLyricsRatio('1:inf'), 0)
  assert.equal(parseLyricsRatio('1:∞'), 0)
  assert.equal(parseLyricsRatio('40%'), 40)
  assert.equal(parseLyricsRatio('0.5'), 66.67)
  assert.throws(() => parseLyricsRatio('0:0'), /at least one side/)
  assert.throws(() => parseLyricsRatio('nope'), /ratio/)
  assert.throws(() => parseLyricsRatio('140%'), /between 0 and 100/)
})

test('1:1 alternates lyrics and instrumentals', () => {
  assert.deepEqual(lanes(50, 6), [
    LANE_LYRICS,
    LANE_INSTRUMENTAL,
    LANE_LYRICS,
    LANE_INSTRUMENTAL,
    LANE_LYRICS,
    LANE_INSTRUMENTAL,
  ])
})

test('1:1.5 plays L NL L NL NL', () => {
  assert.deepEqual(lanes(40, 10), [
    LANE_LYRICS,
    LANE_INSTRUMENTAL,
    LANE_LYRICS,
    LANE_INSTRUMENTAL,
    LANE_INSTRUMENTAL,
    LANE_LYRICS,
    LANE_INSTRUMENTAL,
    LANE_LYRICS,
    LANE_INSTRUMENTAL,
    LANE_INSTRUMENTAL,
  ])
})

test('pure modes play one lane only', () => {
  assert.ok(lanes(0, 8).every((lane) => lane === LANE_INSTRUMENTAL))
  assert.ok(lanes(100, 8).every((lane) => lane === LANE_LYRICS))
})

test('1:4 is exact', () => {
  assert.deepEqual(lanes(20, 5), [
    LANE_LYRICS,
    LANE_INSTRUMENTAL,
    LANE_INSTRUMENTAL,
    LANE_INSTRUMENTAL,
    LANE_INSTRUMENTAL,
  ])
})

test('weights reduce to the simplest exact ratio', () => {
  assert.deepEqual(shareWeights(50), { lyrics: 1, total: 2 })
  assert.deepEqual(shareWeights(40), { lyrics: 2, total: 5 })
  assert.deepEqual(shareWeights(66.67), { lyrics: 2, total: 3 })
  assert.deepEqual(shareWeights(0), { lyrics: 0, total: 10000 })
  assert.deepEqual(shareWeights(100), { lyrics: 10000, total: 10000 })
})

test('the schedule repeats over its exact cycle', () => {
  for (const share of [0, 20, 25, 40, 50, 60, 66.67, 75, 80, 100]) {
    const { lyrics, total } = shareWeights(share)
    const cycle = total / gcd(lyrics, total)
    const head = lanes(share, cycle)
    const next = lanes(share, cycle * 2).slice(cycle)
    assert.deepEqual(next, head, `share ${share}`)
  }
})

test('no randomness: the same position always yields the same lane', () => {
  assert.equal(laneAt(7, 40), laneAt(7, 40))
  assert.equal(lanes(40, 20).filter((lane) => lane === LANE_LYRICS).length, 8)
})

test('unknown tracks belong to neither lane', () => {
  const entries = new Map([
    ['a', { lyrics: true }],
    ['b', { lyrics: false }],
  ])
  const ids = ['a', 'b', 'c']
  assert.deepEqual([...laneCandidates(entries, ids, LANE_LYRICS)], ['a'])
  assert.deepEqual([...laneCandidates(entries, ids, LANE_INSTRUMENTAL)], ['b'])
  assert.equal(laneCandidates(entries, [], LANE_LYRICS).size, 0)
})

test('counts split known and unknown', () => {
  const entries = new Map([
    ['a', { lyrics: true, source: 'detected' }],
    ['b', { lyrics: false, source: 'detected' }],
    ['c', { lyrics: false, source: 'manual' }],
  ])
  assert.deepEqual(lyricsCounts(entries, ['a', 'b', 'c', 'd']), {
    tracks: 4,
    withLyrics: 1,
    withoutLyrics: 2,
    unknown: 1,
    known: 3,
  })
})


test('the client threshold mirrors the service default', () => {
  assert.equal(LYRICS_THRESHOLD_DEFAULT, 0.5)
})
