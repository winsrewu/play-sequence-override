import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

import { Recommender } from '../src/lib/algorithm.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures/algorithm-parity.json'), 'utf8'))

function build() {
  const tracks = fixture.ids.map((id) => ({ id }))
  const vectors = new Map(fixture.ids.map((id, index) => [id, Float32Array.from(fixture.vectors[index])]))
  return new Recommender({ tracks, vectors })
}

test('scores match the NumPy reference implementation', () => {
  const recommender = build()
  const scores = recommender.debugScores(
    fixture.current,
    fixture.candidate_ids,
    fixture.history,
    fixture.target,
    fixture.session_plays,
  )
  assert.equal(scores.length, fixture.scores.length)
  let worst = 0
  for (let i = 0; i < scores.length; i += 1) {
    worst = Math.max(worst, Math.abs(scores[i] - fixture.scores[i]))
  }
  assert.ok(worst < 1e-4, `max score error ${worst}`)
})

test('probabilities match the NumPy reference implementation', () => {
  const recommender = build()
  const { probabilities, maxProbability } = recommender.probabilities(
    fixture.current,
    fixture.history,
    fixture.target,
    fixture.session_plays,
  )
  let worst = 0
  for (const [id, expected] of Object.entries(fixture.probabilities)) {
    worst = Math.max(worst, Math.abs(probabilities.get(id) - expected))
  }
  assert.ok(worst < 1e-5, `max probability error ${worst}`)
  assert.ok(Math.abs(maxProbability - fixture.max_probability) < 1e-4)
  assert.ok(Math.abs([...probabilities.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9)
})

test('prepareHistory puts current first, dedupes and caps at 50', () => {
  const recommender = build()
  const history = recommender.prepareHistory([...fixture.history, 'T03', 'T99'], fixture.current)
  assert.equal(history[0], fixture.current)
  assert.equal(new Set(history).size, history.length)
  assert.ok(history.length <= 400)
  assert.ok(!history.includes('T99'))
})

test('candidate pool excludes current and history', () => {
  const recommender = build()
  const history = recommender.prepareHistory(fixture.history, fixture.current)
  const pool = recommender.candidatePool(fixture.current, history)
  const ids = pool.map((index) => recommender.ids[index])
  assert.ok(!ids.includes(fixture.current))
  for (const id of history) assert.ok(!ids.includes(id))
  assert.equal(ids.length, fixture.candidate_ids.length)
})

test('selectNext always returns an eligible track', () => {
  const recommender = build()
  for (let seed = 0; seed < 100; seed += 1) {
    const next = recommender.selectNext(fixture.current, fixture.history, fixture.target, Math.random, fixture.session_plays)
    assert.ok(recommender.has(next))
    assert.notEqual(next, fixture.current)
    assert.ok(!fixture.history.includes(next))
  }
})

test('selectNext returns current when the pool is empty', () => {
  const tracks = [{ id: 'A' }, { id: 'B' }]
  const vectors = new Map([['A', Float32Array.from([1, 0])], ['B', Float32Array.from([0, 1])]])
  const recommender = new Recommender({ tracks, vectors })
  assert.equal(recommender.selectNext('A', ['A', 'B'], 0.5), 'A')
})

test('different embedding dimensions are rejected', () => {
  const tracks = [{ id: 'A' }, { id: 'B' }]
  const vectors = new Map([['A', Float32Array.from([1, 0])], ['B', Float32Array.from([1, 0, 0])]])
  assert.throws(() => new Recommender({ tracks, vectors }), /dimensions differ/)
})

test('selectNextDetailed explains the selection and is replayable', () => {
  const recommender = build()
  const seed = (initial) => {
    let state = initial >>> 0
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x100000000
    }
  }

  const detailed = recommender.selectNextDetailed(
    fixture.current,
    fixture.history,
    fixture.target,
    seed(12345),
    fixture.session_plays,
  )
  const direct = recommender.selectNext(
    fixture.current,
    fixture.history,
    fixture.target,
    seed(12345),
    fixture.session_plays,
  )

  assert.equal(detailed.id, direct)
  assert.equal(detailed.chosen.id, detailed.id)
  assert.equal(detailed.sampledCandidates.length, detailed.sampleSize)
  assert.equal(detailed.topCandidates.length, Math.min(10, detailed.sampleSize))
  assert.equal(detailed.randomValues.length, detailed.sampleSize + 1)

  for (let i = 1; i < detailed.topCandidates.length; i += 1) {
    assert.ok(detailed.topCandidates[i - 1].score >= detailed.topCandidates[i].score)
  }

  let cursor = 0
  const replay = () => detailed.randomValues[cursor++]
  const replayed = recommender.selectNextDetailed(
    fixture.current,
    fixture.history,
    fixture.target,
    replay,
    fixture.session_plays,
  )
  assert.equal(replayed.id, detailed.id)
  assert.equal(cursor, detailed.randomValues.length)
})
