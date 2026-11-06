// Import/export file for the lyrics verdicts, kept separate from the vector
// file so the two can be moved independently:
//
//   {
//     "format": "jawbts.lyrics",
//     "version": 1,
//     "threshold": 0.5,
//     "tracks": {
//       "BBV16y4y127Dz": { "lyrics": true, "confidence": 0.91, "source": "detected" }
//     }
//   }
import { parseInternalId } from './playlist.js'

export const LYRICS_FORMAT = 'jawbts.lyrics'
export const LYRICS_VERSION = 1

function normalizeEntry(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${id}: entry must be an object`)
  }
  if (typeof value.lyrics !== 'boolean') {
    throw new Error(`${id}: lyrics must be true or false`)
  }
  let confidence = null
  if (value.confidence !== undefined && value.confidence !== null) {
    const parsed = Number(value.confidence)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw new Error(`${id}: confidence must be between 0 and 1`)
    }
    confidence = parsed
  }
  const source = value.source === 'manual' ? 'manual' : 'detected'
  return {
    lyrics: value.lyrics,
    confidence,
    source,
    at: typeof value.at === 'string' && value.at ? value.at : null,
  }
}

export function serializeLyrics(entries, { threshold = null } = {}) {
  if (!(entries instanceof Map)) throw new Error('lyrics must be a Map')
  const ids = [...entries.keys()].sort()
  const tracks = {}
  for (const id of ids) {
    const entry = entries.get(id)
    if (!entry || typeof entry.lyrics !== 'boolean') throw new Error(`${id}: missing lyrics flag`)
    const record = { lyrics: entry.lyrics }
    if (Number.isFinite(entry.confidence)) {
      record.confidence = Math.round(entry.confidence * 10000) / 10000
    }
    record.source = entry.source === 'manual' ? 'manual' : 'detected'
    if (typeof entry.at === 'string' && entry.at) record.at = entry.at
    tracks[id] = record
  }
  const document = { format: LYRICS_FORMAT, version: LYRICS_VERSION }
  if (Number.isFinite(threshold)) document.threshold = threshold
  document.tracks = tracks
  return { text: `${JSON.stringify(document, null, 2)}\n`, count: ids.length }
}

export function parseLyrics(text) {
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`lyrics file is not valid JSON: ${error.message}`)
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('lyrics file root must be an object')
  }
  if (document.format !== LYRICS_FORMAT) {
    throw new Error(`lyrics file must declare format ${JSON.stringify(LYRICS_FORMAT)}`)
  }
  if (Number(document.version) !== LYRICS_VERSION) {
    throw new Error(`unsupported lyrics version ${JSON.stringify(document.version)}`)
  }
  const tracks = document.tracks
  if (!tracks || typeof tracks !== 'object' || Array.isArray(tracks)) {
    throw new Error('lyrics file is missing a tracks object')
  }
  const entries = new Map()
  for (const [rawId, value] of Object.entries(tracks)) {
    let id
    try {
      id = parseInternalId(rawId).id
    } catch (error) {
      throw new Error(`${rawId}: ${error.message}`)
    }
    if (entries.has(id)) throw new Error(`${id}: duplicated track`)
    entries.set(id, normalizeEntry(value, id))
  }
  return { entries }
}

export function parseLyricsText(text) {
  return parseLyrics(text).entries
}
