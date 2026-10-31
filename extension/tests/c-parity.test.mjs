import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

import { dataDir } from './data-dir.mjs'

import { Recommender } from '../src/lib/algorithm.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures/c-reference.json'), 'utf8'))
const style = JSON.parse(readFileSync(path.join(dataDir, 'style-labels.json'), 'utf8'))
const index = JSON.parse(readFileSync(path.join(dataDir, 'embeddings-index.json'), 'utf8'))
const buffer = readFileSync(path.join(dataDir, 'embeddings.bin'))
const data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)

const vectors = new Map(
  index.ids.map((id, i) => [id, data.subarray(i * 960, (i + 1) * 960)]),
)
const styleLabels = new Map(style.ids.map((id, i) => [id, style.labels[i]]))
const recommender = new Recommender({
  tracks: index.ids.map((id) => ({ id })),
  vectors,
  styleLabels,
  styleCentroids: style.centroids,
})

function tuningOf(scenario) {
  return {
    historyLength: scenario.tuning.history_length,
    penaltyStrength: scenario.tuning.penalty_strength,
    curve: scenario.tuning.curve,
    simCurve: scenario.tuning.sim_curve,
    forceSkip: scenario.force_skip,
  }
}

test('JS algorithm matches C on 35 actual app.py cases', () => {
  let worstScore = 0
  let worstPenalty = 0
  let worstStyle = 0
  let worstProbability = 0
  let worstSum = 0
  let worstSquareSum = 0
  let worstMax = 0

  for (const scenario of fixture.cases) {
    const tuning = tuningOf(scenario)
    const prepared = recommender.prepareHistory(
      scenario.history,
      scenario.current,
      tuning.historyLength,
    )
    assert.deepEqual(prepared, scenario.prepared, 'prepare_history')

    const pool = recommender.candidatePool(
      scenario.current,
      prepared,
      scenario.force_skip,
      scenario.history,
    )
    assert.equal(pool.length, scenario.pool_len, 'candidate_pool length')
    assert.deepEqual(pool.slice(0, 20), scenario.pool_head, 'candidate_pool head')

    const target = scenario.target_pct / 100
    const currentIndex = recommender.indexById.get(scenario.current)
    assert.ok(
      Math.abs(recommender.minSimilarity(currentIndex) - scenario.min_similarity) < 1e-5,
      'min_similarity',
    )
    const scores = recommender.debugScores(
      scenario.current,
      scenario.subset.map((i) => fixture.ids[i]),
      scenario.history,
      target,
      scenario.session_plays,
      tuning,
    )
    const penalties = recommender.historyPenalty(scenario.subset, prepared, tuning)
    const styles = recommender.stylePenalty(scenario.subset, prepared, tuning)
    const distribution = recommender.probabilities(
      scenario.current,
      scenario.history,
      target,
      scenario.session_plays,
      tuning,
    )

    for (let i = 0; i < scores.length; i += 1) {
      worstScore = Math.max(worstScore, Math.abs(scores[i] - scenario.scores[i]))
      worstPenalty = Math.max(worstPenalty, Math.abs(penalties[i] - scenario.history_penalties[i]))
      worstStyle = Math.max(worstStyle, Math.abs(styles[i] - scenario.style_penalties[i]))
    }

    for (const [id, probability] of Object.entries(scenario.subset_probabilities)) {
      worstProbability = Math.max(
        worstProbability,
        Math.abs(distribution.probabilities.get(id) - probability),
      )
    }

    let sum = 0
    let squareSum = 0
    let maximum = 0
    for (const probability of distribution.probabilities.values()) {
      sum += probability
      squareSum += probability * probability
      if (probability > maximum) maximum = probability
    }
    worstSum = Math.max(worstSum, Math.abs(sum - scenario.prob_sum))
    worstSquareSum = Math.max(worstSquareSum, Math.abs(squareSum - scenario.prob_sq_sum))
    worstMax = Math.max(worstMax, Math.abs(maximum - scenario.max))

    const top = scenario.subset
      .map((index, position) => ({ index, score: scores[position] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(recommender.constants.TOP_K, scenario.subset.length))
      .map((entry) => entry.index)
    assert.deepEqual(
      [...top].sort((a, b) => a - b),
      [...scenario.top10].sort((a, b) => a - b),
      'top-10 set',
    )
  }

  assert.ok(worstScore < 1e-5, `score error ${worstScore}`)
  assert.ok(worstPenalty < 1e-5, `history penalty error ${worstPenalty}`)
  assert.ok(worstStyle < 1e-5, `style penalty error ${worstStyle}`)
  assert.ok(worstProbability < 5e-4, `probability error ${worstProbability}`)
  assert.ok(worstSum < 1e-6, `probability sum error ${worstSum}`)
  assert.ok(worstSquareSum < 5e-4, `probability square-sum error ${worstSquareSum}`)
  assert.ok(worstMax < 5e-4, `max probability error ${worstMax}`)
})
