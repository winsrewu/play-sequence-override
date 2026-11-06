// Port of the C app.py selector: history <= 400, 500 candidates, top-10 draw, style weight 1/3.
export const ALGORITHM_DEFAULTS = Object.freeze({
  MAX_HISTORY_LENGTH: 400,
  MIN_HISTORY_LENGTH: 10,
  DEFAULT_HISTORY_LENGTH: 400,
  HISTORY_LENGTH: 400,
  MAX_FORCE_SKIP: 1767,
  DEFAULT_FORCE_SKIP: 1767,
  CANDIDATE_SAMPLE: 500,
  TOP_K: 10,
  PENALTY_STRENGTH: 3.0,
  CURVE: 0.5,
  SIM_CURVE: 0.5,
  STYLE_WEIGHT: 1 / 3,
  SIMILARITY_SIGMA: 25.0,
  NOVELTY_PENALTY: 0.2,
})

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function numberOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function dot(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

function normalize(vector) {
  const copy = vector instanceof Float32Array ? vector : Float32Array.from(vector)
  let norm = 0
  for (let i = 0; i < copy.length; i += 1) norm += copy[i] * copy[i]
  norm = Math.sqrt(norm)
  if (norm > 1e-12) {
    for (let i = 0; i < copy.length; i += 1) copy[i] /= norm
  }
  return copy
}

function sampleWithoutReplacement(pool, size, random) {
  const copy = pool.slice()
  const count = Math.min(size, copy.length)
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(random() * (copy.length - i))
    const value = copy[i]
    copy[i] = copy[j]
    copy[j] = value
  }
  return copy.slice(0, count)
}

export class Recommender {
  constructor({ tracks, vectors, constants = {}, styleLabels = null, styleCentroids = null }) {
    this.constants = { ...ALGORITHM_DEFAULTS, ...constants }
    this.trackIds = tracks.map((track) => track.id)
    this.ids = []
    this.indexById = new Map()
    this.vectors = []
    this._minSimilarityCache = new Map()
    this.styleCentroids = Array.isArray(styleCentroids) ? styleCentroids : []
    const labelFor = (id) => {
      if (styleLabels instanceof Map) return styleLabels.get(id)
      if (styleLabels && typeof styleLabels === 'object') return styleLabels[id]
      return undefined
    }
    this.styleLabels = []
    let hasStyleLabels = Boolean(styleLabels) || this.styleCentroids.length > 0

    for (const track of tracks) {
      const vector = vectors instanceof Map ? vectors.get(track.id) : vectors[track.id]
      if (!vector || vector.length === 0) continue
      const normalized = normalize(vector)
      this.indexById.set(track.id, this.ids.length)
      this.ids.push(track.id)
      this.vectors.push(normalized)
      let label = labelFor(track.id)
      if (label === undefined && this.styleCentroids.length > 0) {
        label = this.nearestStyle(normalized)
      }
      this.styleLabels.push(Number.isInteger(label) ? label : -1)
    }

    if (!hasStyleLabels) this.styleLabels = null

    const dims = new Set(this.vectors.map((vector) => vector.length))
    if (dims.size > 1) {
      throw new Error(`embedding dimensions differ: ${[...dims].join(', ')}`)
    }
    this.dim = this.vectors[0]?.length || 0
  }

  get size() {
    return this.ids.length
  }

  has(id) {
    return this.indexById.has(id)
  }

  _tuning(raw = {}) {
    const defaults = this.constants
    const minHistory = Number(defaults.MIN_HISTORY_LENGTH) || 10
    const maxHistory = Number(defaults.MAX_HISTORY_LENGTH) || 400
    const historyValue = numberOr(
      raw.historyLength ?? raw.HISTORY_LENGTH,
      defaults.DEFAULT_HISTORY_LENGTH,
    )
    return {
      historyLength: Math.round(clamp(historyValue, minHistory, maxHistory)),
      penaltyStrength: clamp(
        numberOr(raw.penaltyStrength, defaults.PENALTY_STRENGTH),
        0,
        20,
      ),
      curve: clamp(numberOr(raw.curve, defaults.CURVE), 0.25, 8),
      simCurve: clamp(
        numberOr(raw.simCurve ?? raw.similarityCurve, defaults.SIM_CURVE),
        0.25,
        8,
      ),
      forceSkip: Math.round(
        clamp(
          numberOr(raw.forceSkip, defaults.DEFAULT_FORCE_SKIP),
          0,
          Number(defaults.MAX_FORCE_SKIP) || 1767,
        ),
      ),
    }
  }

  nearestStyle(vector) {
    let best = -1
    let bestDistance = Infinity
    for (let label = 0; label < this.styleCentroids.length; label += 1) {
      const centroid = this.styleCentroids[label]
      let distance = 0
      for (let i = 0; i < vector.length; i += 1) {
        const delta = vector[i] - centroid[i]
        distance += delta * delta
      }
      if (distance < bestDistance) {
        bestDistance = distance
        best = label
      }
    }
    return best
  }

  minSimilarity(index) {
    if (this.vectors.length < 2) return 1
    const cached = this._minSimilarityCache.get(index)
    if (cached !== undefined) return cached
    const vector = this.vectors[index]
    let minimum = Infinity
    for (let other = 0; other < this.vectors.length; other += 1) {
      if (other === index) continue
      const similarity = dot(vector, this.vectors[other])
      if (similarity < minimum) minimum = similarity
    }
    if (!Number.isFinite(minimum)) minimum = 1
    this._minSimilarityCache.set(index, minimum)
    return minimum
  }

  normalizedSimilarity(raw, referenceIndex, floor = null) {
    const low = floor === null || floor === undefined
      ? this.minSimilarity(referenceIndex)
      : floor
    if (low >= 1) return 1
    return clamp((raw - low) / (1 - low), 0, 1)
  }

  // Lowest similarity inside a selected lane. Normalizing against it keeps the
  // target percentage meaningful after the candidate pool is restricted.
  similarityFloor(referenceIndex, ids) {
    if (!(ids instanceof Set)) return 1
    const vector = this.vectors[referenceIndex]
    if (!vector) return 1
    let minimum = Infinity
    for (const id of ids) {
      const index = this.indexById.get(id)
      if (index === undefined || index === referenceIndex) continue
      const similarity = dot(vector, this.vectors[index])
      if (similarity < minimum) minimum = similarity
    }
    return Number.isFinite(minimum) ? minimum : 1
  }

  prepareHistory(rawHistory, current, historyLength = this.constants.DEFAULT_HISTORY_LENGTH) {
    const seen = new Set()
    const ordered = []
    const list = Array.isArray(rawHistory)
      ? rawHistory
      : rawHistory && typeof rawHistory === 'object'
        ? Object.keys(rawHistory)
        : []
    for (const id of list) {
      if (this.indexById.has(id) && !seen.has(id)) {
        seen.add(id)
        ordered.push(id)
      }
    }
    if (this.indexById.has(current)) {
      const existing = ordered.indexOf(current)
      if (existing >= 0) ordered.splice(existing, 1)
      ordered.unshift(current)
    }
    const limit = Math.round(
      clamp(
        numberOr(historyLength, this.constants.DEFAULT_HISTORY_LENGTH),
        this.constants.MIN_HISTORY_LENGTH,
        this.constants.MAX_HISTORY_LENGTH,
      ),
    )
    return ordered.slice(0, limit)
  }

  // allowedIds restricts the pool to one lane, so the 500-candidate draw and the
  // top-10 draw contain only those tracks. The caller decides what to do when a
  // lane is empty; it never mixes lanes here.
  candidatePool(current, historyIds, forceSkip = 0, recentIds = [], allowedIds = null) {
    const blocked = new Set([current, ...historyIds])
    const allowed = allowedIds instanceof Set ? allowedIds : null
    const collect = (excluded) => {
      const pool = []
      for (let index = 0; index < this.ids.length; index += 1) {
        const id = this.ids[index]
        if (excluded.has(id)) continue
        if (allowed && !allowed.has(id)) continue
        pool.push(index)
      }
      return pool
    }
    const base = collect(blocked)
    const recent = Array.isArray(recentIds)
      ? recentIds
      : recentIds && typeof recentIds === 'object'
        ? Object.keys(recentIds)
        : []
    if (forceSkip > 0 && recent.length > 0) {
      const forced = new Set(blocked)
      for (const id of recent.slice(0, forceSkip)) forced.add(id)
      const forcedPool = collect(forced)
      if (forcedPool.length > 0) return forcedPool
    }
    return base
  }

  _historyWeights(count, tuning) {
    const denominator = Math.max(tuning.historyLength - 1, 1)
    const weights = new Float64Array(count)
    for (let position = 0; position < count; position += 1) {
      weights[position] = Math.pow(1 - position / denominator, tuning.curve)
    }
    return weights
  }

  historyPenalty(candidateIndices, historyIds, tuning = {}) {
    const t = this._tuning(tuning)
    const history = historyIds
      .map((id) => this.indexById.get(id))
      .filter((index) => index !== undefined)
    if (history.length === 0) return new Float64Array(candidateIndices.length)

    const weights = this._historyWeights(history.length, t)
    let weightSum = 0
    for (const weight of weights) weightSum += weight
    const lows = history.map((index) => this.minSimilarity(index))
    const result = new Float64Array(candidateIndices.length)

    for (let c = 0; c < candidateIndices.length; c += 1) {
      const candidate = this.vectors[candidateIndices[c]]
      let weighted = 0
      let maximum = 0
      for (let h = 0; h < history.length; h += 1) {
        const raw = dot(candidate, this.vectors[history[h]])
        const low = lows[h]
        const similarity = clamp(
          (raw - low) / Math.max(1 - low, 1e-12),
          0,
          1,
        )
        const curved = Math.pow(similarity, t.simCurve)
        weighted += curved * weights[h]
        if (curved > maximum) maximum = curved
      }
      result[c] = 0.5 * (weighted / (weightSum || 1)) + 0.5 * maximum
    }
    return result
  }

  stylePenalty(candidateIndices, historyIds, tuning = {}) {
    if (!this.styleLabels) return new Float64Array(candidateIndices.length)
    const t = this._tuning(tuning)
    const history = historyIds
      .map((id) => this.indexById.get(id))
      .filter((index) => index !== undefined)
    if (history.length === 0) return new Float64Array(candidateIndices.length)
    const weights = this._historyWeights(history.length, t)
    const result = new Float64Array(candidateIndices.length)
    for (let c = 0; c < candidateIndices.length; c += 1) {
      const label = this.styleLabels[candidateIndices[c]]
      if (label < 0) continue
      let value = 0
      for (let h = 0; h < history.length; h += 1) {
        if (label === this.styleLabels[history[h]]) value += weights[h]
      }
      result[c] = value
    }
    return result
  }

  scoreCandidates(
    current,
    candidateIndices,
    historyIds,
    targetSimilarity,
    sessionPlays = null,
    tuning = {},
    floor = null,
  ) {
    const currentIndex = this.indexById.get(current)
    if (currentIndex === undefined) throw new Error(`unknown current track ${current}`)
    const t = this._tuning(tuning)
    const target = clamp(Number(targetSimilarity), 0, 1)
    const penalties = this.historyPenalty(candidateIndices, historyIds, t)
    const styles = this.stylePenalty(candidateIndices, historyIds, t)
    const scores = new Float64Array(candidateIndices.length)
    const sigma = this.constants.SIMILARITY_SIGMA
    const noveltyPenalty = this.constants.NOVELTY_PENALTY

    for (let c = 0; c < candidateIndices.length; c += 1) {
      const index = candidateIndices[c]
      const raw = dot(this.vectors[index], this.vectors[currentIndex])
      const similarity = this.normalizedSimilarity(raw, currentIndex, floor)
      const base = Math.exp(-sigma * (similarity - target) ** 2)
      const combined = penalties[c] + this.constants.STYLE_WEIGHT * styles[c]
      let score = base * Math.exp(-t.penaltyStrength * combined)
      if (noveltyPenalty > 0 && sessionPlays) {
        const plays = sessionPlays[this.ids[index]] || 0
        score *= Math.pow(1 + plays, -noveltyPenalty)
      }
      scores[c] = score
    }
    return scores
  }

  explainCandidate(
    current,
    candidateIndex,
    historyIds,
    targetSimilarity,
    sessionPlays = null,
    tuning = {},
    floor = null,
  ) {
    const currentIndex = this.indexById.get(current)
    if (currentIndex === undefined) throw new Error(`unknown current track ${current}`)
    const t = this._tuning(tuning)
    const target = clamp(Number(targetSimilarity), 0, 1)
    const raw = dot(this.vectors[candidateIndex], this.vectors[currentIndex])
    const similarity = this.normalizedSimilarity(raw, currentIndex, floor)
    const base = Math.exp(-this.constants.SIMILARITY_SIGMA * (similarity - target) ** 2)
    const historyPenalty = this.historyPenalty([candidateIndex], historyIds, t)[0]
    const stylePenalty = this.stylePenalty([candidateIndex], historyIds, t)[0]
    const combinedPenalty = historyPenalty + this.constants.STYLE_WEIGHT * stylePenalty
    const penaltyFactor = Math.exp(-t.penaltyStrength * combinedPenalty)
    const id = this.ids[candidateIndex]
    const plays = sessionPlays?.[id] || 0
    const novelty = this.constants.NOVELTY_PENALTY > 0
      ? Math.pow(1 + plays, -this.constants.NOVELTY_PENALTY)
      : 1
    return {
      id,
      rawSimilarity: raw,
      normalizedSimilarity: similarity,
      targetSimilarity: target,
      targetScore: base,
      historyPenalty,
      stylePenalty,
      combinedPenalty,
      penaltyFactor,
      historyFactor: penaltyFactor,
      plays,
      novelty,
      score: base * penaltyFactor * novelty,
    }
  }

  selectNextDetailed(
    current,
    rawHistory,
    targetSimilarity,
    random = Math.random,
    sessionPlays = null,
    tuning = {},
    options = {},
  ) {
    if (!this.indexById.has(current)) throw new Error(`unknown current track ${current}`)
    const t = this._tuning(tuning)
    const history = this.prepareHistory(rawHistory, current, t.historyLength)
    const pool = this.candidatePool(
      current,
      history,
      t.forceSkip,
      rawHistory,
      options.allowedIds ?? null,
    )
    const target = clamp(Number(targetSimilarity), 0, 1)
    // When a lane is selected its similarity range is narrower than the whole
    // catalog; measuring against the lane keeps 75% meaning 75%.
    const floor = options.allowedIds instanceof Set
      ? this.similarityFloor(this.indexById.get(current), options.allowedIds)
      : null
    if (pool.length === 0) {
      return {
        id: current,
        current,
        targetSimilarity: target,
        similarityFloor: floor,
        history,
        tuning: t,
        poolSize: 0,
        sampleSize: 0,
        sampledCandidates: [],
        topCandidates: [],
        chosen: { id: current, rank: 0 },
        randomValues: [],
      }
    }

    const randomValues = []
    const tracedRandom = () => {
      const value = random()
      randomValues.push(value)
      return value
    }

    const sampleSize = Math.min(this.constants.CANDIDATE_SAMPLE, pool.length)
    const candidates = sampleWithoutReplacement(pool, sampleSize, tracedRandom)
    const scores = this.scoreCandidates(
      current,
      candidates,
      history,
      target,
      sessionPlays,
      t,
      floor,
    )

    const k = Math.min(this.constants.TOP_K, candidates.length)
    const ranked = candidates
      .map((_index, position) => position)
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, k)
    const choicePosition = Math.floor(tracedRandom() * ranked.length)
    const chosenSamplePosition = ranked[choicePosition]
    const chosenIndex = candidates[chosenSamplePosition]

    const topCandidates = ranked.map((position, rank) => {
      const details = this.explainCandidate(
        current,
        candidates[position],
        history,
        target,
        sessionPlays,
        t,
        floor,
      )
      return { ...details, rank: rank + 1, samplePosition: position, score: scores[position] }
    })

    return {
      id: this.ids[chosenIndex],
      current,
      targetSimilarity: target,
      similarityFloor: floor,
      history,
      tuning: t,
      poolSize: pool.length,
      sampleSize,
      sampledCandidates: candidates.map((index, position) => ({
        id: this.ids[index],
        score: scores[position],
      })),
      topCandidates,
      chosen: {
        ...topCandidates[choicePosition],
        topPosition: choicePosition + 1,
      },
      randomValues,
    }
  }

  selectNext(
    current,
    rawHistory,
    targetSimilarity,
    random = Math.random,
    sessionPlays = null,
    tuning = {},
    options = {},
  ) {
    return this.selectNextDetailed(
      current,
      rawHistory,
      targetSimilarity,
      random,
      sessionPlays,
      tuning,
      options,
    ).id
  }

  probabilities(
    current,
    rawHistory,
    targetSimilarity,
    sessionPlays = null,
    tuning = {},
    options = {},
  ) {
    if (!this.indexById.has(current)) throw new Error(`unknown current track ${current}`)
    const t = this._tuning(tuning)
    const history = this.prepareHistory(rawHistory, current, t.historyLength)
    const pool = this.candidatePool(
      current,
      history,
      t.forceSkip,
      rawHistory,
      options.allowedIds ?? null,
    )
    if (pool.length === 0) return { probabilities: new Map(), maxProbability: 0 }

    const floor = options.allowedIds instanceof Set
      ? this.similarityFloor(this.indexById.get(current), options.allowedIds)
      : null
    const scores = this.scoreCandidates(
      current,
      pool,
      history,
      targetSimilarity,
      sessionPlays,
      t,
      floor,
    )
    let total = 0
    for (const score of scores) total += score

    const probabilities = new Map()
    let maximum = 0
    for (let i = 0; i < pool.length; i += 1) {
      const probability = total > 0 ? scores[i] / total : 1 / pool.length
      probabilities.set(this.ids[pool[i]], probability)
      if (probability > maximum) maximum = probability
    }
    return { probabilities, maxProbability: maximum }
  }

  rawSimilarities(current) {
    const currentIndex = this.indexById.get(current)
    if (currentIndex === undefined) throw new Error(`unknown current track ${current}`)
    const result = new Map()
    for (let index = 0; index < this.ids.length; index += 1) {
      result.set(this.ids[index], index === currentIndex ? 1 : dot(this.vectors[index], this.vectors[currentIndex]))
    }
    return result
  }

  debugScores(current, candidateIds, historyIds, targetSimilarity, sessionPlays = null, tuning = {}) {
    const t = this._tuning(tuning)
    const history = this.prepareHistory(historyIds, current, t.historyLength)
    const indices = candidateIds.map((id) => {
      const index = this.indexById.get(id)
      if (index === undefined) throw new Error(`unknown candidate ${id}`)
      return index
    })
    return Array.from(
      this.scoreCandidates(current, indices, history, targetSimilarity, sessionPlays, t),
    )
  }
}
