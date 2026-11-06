// Deterministic lyrics / instrumental interleaving.
//
// The setting is a lyrics share: 0 keeps only instrumentals and 100 only tracks
// with lyrics, so the displayed 1:x ratio reaches 0 (x = 0) and +inf (x -> inf)
// without storing an infinity anywhere. The lane for a position comes from a
// closed-form Bresenham schedule over a persistent cursor, never a random draw.

export const LYRICS_SHARE_MIN = 0
export const LYRICS_SHARE_MAX = 100
export const LYRICS_SHARE_DEFAULT = 50

// Mirrors the service default; /v1/vocals returns the live value, which is
// stored and wins from then on.
export const LYRICS_THRESHOLD_DEFAULT = 0.5

// Weights run in hundredths of a percent, so typed ratios stay close to exact.
const SHARE_UNITS = 10000

export const LANE_LYRICS = 'lyrics'
export const LANE_INSTRUMENTAL = 'instrumental'

export function normalizeLyricsShare(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return LYRICS_SHARE_DEFAULT
  const clamped = Math.min(LYRICS_SHARE_MAX, Math.max(LYRICS_SHARE_MIN, parsed))
  return Math.round(clamped * 100) / 100
}

function trimNumber(value) {
  // Keep small ratios readable; only a share of exactly 100 prints "1 : 0".
  return String(Number(value.toPrecision(3)))
}

// The lyrics side is fixed at 1 for mixed settings, which is the notation the
// settings page and popup use.
export function formatLyricsRatio(share) {
  const value = normalizeLyricsShare(share)
  if (value <= LYRICS_SHARE_MIN) return '0 : 1 (all instrumentals)'
  if (value >= LYRICS_SHARE_MAX) return '1 : 0 (all lyrics)'
  return `1 : ${trimNumber((100 - value) / value)}`
}

const weightsCache = new Map()

// The simplest integer pair whose ratio is within 0.01 points of the share.
// This keeps 1:1.5 or 1:0.5 exact instead of drifting with a rounded percent.
export function shareWeights(share) {
  const value = normalizeLyricsShare(share)
  const cached = weightsCache.get(value)
  if (cached) return cached
  let result = { lyrics: Math.round(value * (SHARE_UNITS / 100)), total: SHARE_UNITS }
  for (let total = 1; total <= 1000; total += 1) {
    const lyrics = Math.round((value * total) / 100)
    if (lyrics <= 0 || lyrics >= total) continue
    if (Math.abs((lyrics / total) * 100 - value) <= 0.01) {
      result = { lyrics, total }
      break
    }
  }
  weightsCache.set(value, result)
  return result
}

// Lane at a zero-based sequence position. The endpoints fall out naturally:
// a share of 0 has no lyrics weight and 100 has no instrumental weight.
export function laneAt(index, share) {
  const position = Math.max(0, Math.floor(Number(index) || 0))
  const { lyrics, total } = shareWeights(share)
  if (lyrics <= 0) return LANE_INSTRUMENTAL
  if (lyrics >= total) return LANE_LYRICS
  const before = Math.ceil((position * lyrics) / total)
  const after = Math.ceil(((position + 1) * lyrics) / total)
  return after > before ? LANE_LYRICS : LANE_INSTRUMENTAL
}

// A readable preview such as L NL L NL NL for the settings hint.
export function lanePreview(share, length = 10) {
  return Array.from({ length }, (_, index) => laneAt(index, share))
}

export function laneCandidates(entries, trackIds, lane) {
  const wanted = lane === LANE_LYRICS
  const allowed = new Set()
  for (const id of trackIds) {
    const entry = entries.get(id)
    // Only a classified track belongs to a lane; while the share is on an
    // unanalyzed track is never picked, so it cannot break the pattern.
    if (!entry) continue
    if (entry.lyrics === wanted) allowed.add(id)
  }
  return allowed
}

export function lyricsCounts(entries, trackIds = null) {
  const ids = trackIds ? [...trackIds] : [...entries.keys()]
  let withLyrics = 0
  let withoutLyrics = 0
  let unknown = 0
  for (const id of ids) {
    const entry = entries.get(id)
    if (!entry) {
      unknown += 1
      continue
    }
    if (entry.lyrics) withLyrics += 1
    else withoutLyrics += 1
  }
  return {
    tracks: ids.length,
    withLyrics,
    withoutLyrics,
    unknown,
    known: withLyrics + withoutLyrics,
  }
}
