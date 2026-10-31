// Strict v2 playlist. Canonical id is B<BVID> with an optional _<page> suffix.
export const FORMAT = 'jawbts.music-playlist'
export const VERSION = 2

const PROVIDER_LETTERS = { bilibili: 'B' }
const LETTER_PROVIDERS = { B: 'bilibili' }

const ID_RE = /^([A-Z])([0-9A-Za-z]{12})(?:_([1-9][0-9]{0,3}))?$/
const BVID_RE = /^BV[0-9A-Za-z]{10}$/
const TRACK_KEYS = new Set(['id', 'provider', 'video_id', 'page', 'title'])

export class PlaylistError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlaylistError'
  }
}

export function buildInternalId(provider, videoId, page = 1) {
  const letter = PROVIDER_LETTERS[provider]
  if (!letter) throw new PlaylistError(`unsupported provider ${JSON.stringify(provider)}`)
  if (!BVID_RE.test(videoId)) throw new PlaylistError(`invalid Bilibili BVID ${JSON.stringify(videoId)}`)
  if (!Number.isInteger(page) || page < 1) throw new PlaylistError('page must be a positive integer')
  return `${letter}${videoId}${page > 1 ? `_${page}` : ''}`
}

export function parseInternalId(value) {
  if (typeof value !== 'string') throw new PlaylistError('internal id must be a string')
  const raw = value.trim()
  const match = ID_RE.exec(raw)
  if (!match) {
    throw new PlaylistError(
      `internal id must look like B + BVID, optionally with _<page> (got ${JSON.stringify(value)})`,
    )
  }
  const [, letter, videoId, pageText] = match
  const provider = LETTER_PROVIDERS[letter]
  if (!provider) throw new PlaylistError(`unsupported provider letter ${JSON.stringify(letter)}`)
  if (!BVID_RE.test(videoId)) throw new PlaylistError(`invalid Bilibili BVID ${JSON.stringify(videoId)}`)
  const page = Number(pageText || 1)
  const canonical = buildInternalId(provider, videoId, page)
  if (canonical !== raw) {
    throw new PlaylistError(`internal id is not canonical: expected ${canonical}, got ${raw}`)
  }
  return { provider, videoId, page, value: canonical, id: canonical }
}

function integer(value, fallback = 0) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new PlaylistError(`expected an integer, got ${JSON.stringify(value)}`)
  return parsed
}

export function trackFromEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlaylistError('each track must be a JSON object')
  }
  const unknown = Object.keys(raw).filter((key) => !TRACK_KEYS.has(key))
  if (unknown.length > 0) throw new PlaylistError(`unexpected track field(s): ${unknown.join(', ')}`)
  if (!('id' in raw)) throw new PlaylistError('track is missing id')

  const internal = parseInternalId(String(raw.id))
  const provider = String(raw.provider || '').toLowerCase() === 'b'
    ? 'bilibili'
    : String(raw.provider || '').toLowerCase()
  if (provider !== internal.provider) {
    throw new PlaylistError(`provider ${JSON.stringify(raw.provider)} conflicts with internal id ${internal.id}`)
  }
  if (raw.video_id == null || String(raw.video_id) !== internal.videoId) {
    throw new PlaylistError(`video_id ${JSON.stringify(raw.video_id)} conflicts with internal id ${internal.id}`)
  }
  if (integer(raw.page, 0) !== internal.page) {
    throw new PlaylistError(`page ${JSON.stringify(raw.page)} conflicts with internal id ${internal.id}`)
  }

  return {
    id: internal.id,
    provider: internal.provider,
    videoId: internal.videoId,
    video_id: internal.videoId,
    page: internal.page,
    title: String(raw.title || ''),
  }
}

function playlistFromEntries(entries) {
  const tracks = entries.map(trackFromEntry)
  const seen = new Set()
  for (const track of tracks) {
    if (seen.has(track.id)) throw new PlaylistError(`duplicate internal id ${track.id}`)
    seen.add(track.id)
  }
  return { format: FORMAT, version: VERSION, generatedAt: null, tracks }
}

export function parsePlaylist(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new PlaylistError('playlist root must be a JSON object')
  }
  const unknown = Object.keys(document).filter(
    (key) => !['format', 'version', 'generated_at', 'tracks'].includes(key),
  )
  if (unknown.length > 0) throw new PlaylistError(`unexpected playlist field(s): ${unknown.join(', ')}`)
  if (document.format !== FORMAT) {
    throw new PlaylistError(`unsupported playlist format ${JSON.stringify(document.format)}`)
  }
  const version = integer(document.version, 0)
  if (version !== VERSION) {
    throw new PlaylistError(`unsupported playlist version ${version}; this build reads v${VERSION}`)
  }
  if (!Array.isArray(document.tracks)) throw new PlaylistError('v2 playlist is missing a tracks array')
  const playlist = playlistFromEntries(document.tracks)
  playlist.generatedAt = document.generated_at ? String(document.generated_at) : null
  return playlist
}

function trackToV2(track) {
  return {
    id: track.id,
    provider: track.provider,
    video_id: track.videoId,
    page: track.page,
    title: track.title,
  }
}

export function exportV2(playlist, generatedAt = null) {
  return {
    format: FORMAT,
    version: VERSION,
    generated_at:
      generatedAt ||
      playlist.generatedAt ||
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tracks: playlist.tracks.map(trackToV2),
  }
}

export function playlistSummary(playlist) {
  const providers = {}
  let multiPage = 0
  for (const track of playlist.tracks) {
    providers[track.provider] = (providers[track.provider] || 0) + 1
    if (track.page > 1) multiPage += 1
  }
  return { count: playlist.tracks.length, providers, multiPage }
}
