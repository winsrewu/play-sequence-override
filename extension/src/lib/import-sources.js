// Bilibili import sources, mirrored from jawbts-website-next's BiliBiliUtils:
// single video, series, collection and favourites.
import { buildInternalId } from './playlist.js'

const API = 'https://api.bilibili.com'
const BVID = /^BV[0-9A-Za-z]{10}$/

export class ImportError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ImportError'
  }
}

export const IMPORT_SOURCES = ['video', 'series', 'collection', 'favorites']

export function normalizeImportTarget(source, raw) {
  const value = String(raw ?? '').trim()
  if (!value) throw new ImportError('missing id or URL')
  let url = null
  try {
    url = new URL(value)
  } catch {
    url = null
  }
  if (source === 'video') {
    if (url) {
      const match = /\/video\/(BV[0-9A-Za-z]{10})/.exec(url.pathname)
      const bvid = match ? match[1] : url.searchParams.get('bvid') || ''
      if (!BVID.test(bvid)) throw new ImportError('that URL has no Bilibili video id')
      return { kind: 'video', bvid }
    }
    if (!BVID.test(value)) throw new ImportError('expected a BV id like BV1xx411c7mD')
    return { kind: 'video', bvid: value }
  }
  if (!IMPORT_SOURCES.includes(source)) throw new ImportError(`unknown source ${source}`)
  const id = url
    ? url.searchParams.get('sid') ||
      url.searchParams.get('series_id') ||
      url.searchParams.get('season_id') ||
      url.searchParams.get('media_id') ||
      url.searchParams.get('fid') ||
      ''
    : value
  if (!/^[0-9]+$/.test(id)) throw new ImportError(`expected a numeric ${source} id`)
  return { kind: source, id }
}

async function biliData(path, fetchImpl, signal) {
  const response = await fetchImpl(`${API}${path}`, { credentials: 'include', signal })
  if (!response.ok) throw new ImportError(`Bilibili request failed (HTTP ${response.status})`)
  let body
  try {
    body = await response.json()
  } catch {
    throw new ImportError('Bilibili returned a non-JSON response')
  }
  if (body.code !== 0) throw new ImportError(`Bilibili: ${body.message || `code ${body.code}`}`)
  return body.data
}

function makeTrack(bvid, page, title) {
  return {
    id: buildInternalId('bilibili', bvid, page),
    provider: 'bilibili',
    video_id: bvid,
    page,
    title: String(title || bvid),
  }
}

function viewTracks(data) {
  const pages = Array.isArray(data.pages) && data.pages.length > 0 ? data.pages : [{ part: '' }]
  return pages.map((info, index) => {
    // Multi-part videos carry the P number and its name; single videos stay clean.
    const label = `P${index + 1}`
    const part = String(info.part ?? '').trim()
    const title = pages.length === 1 ? data.title : part ? `${data.title} · ${label} ${part}` : `${data.title} · ${label}`
    return makeTrack(data.bvid, index + 1, title)
  })
}

export function dedupeTracks(tracks) {
  const seen = new Set()
  const result = []
  for (const track of tracks) {
    if (seen.has(track.id)) continue
    seen.add(track.id)
    result.push(track)
  }
  return result
}

export async function resolveImportTracks(source, raw, { fetchImpl = fetch, signal } = {}) {
  const target = normalizeImportTarget(source, raw)
  const get = (path) => {
    if (signal?.aborted) throw new ImportError('import cancelled')
    return biliData(path, fetchImpl, signal)
  }
  const tracks = []

  if (target.kind === 'video') {
    tracks.push(...viewTracks(await get(`/x/web-interface/view?bvid=${target.bvid}`)))
  } else if (target.kind === 'series') {
    const series = await get(`/x/series/series?series_id=${target.id}`)
    for (const aid of series.recent_aids || []) {
      tracks.push(...viewTracks(await get(`/x/web-interface/view?aid=${aid}`)))
    }
  } else if (target.kind === 'collection') {
    const listing = await get(
      `/x/polymer/web-space/seasons_archives_list?mid=0&page_num=1&page_size=30&season_id=${target.id}`,
    )
    const first = (listing.aids || [])[0]
    if (!first) throw new ImportError('that collection has no videos')
    const view = await get(`/x/web-interface/view?aid=${first}`)
    const season = view.ugc_season
    if (!season) throw new ImportError('that collection has no season data')
    for (const section of season.sections || []) {
      for (const episode of section.episodes || []) {
        if (!BVID.test(episode.bvid || '')) continue
        tracks.push(makeTrack(episode.bvid, 1, `${season.title}/${section.title}/${episode.title}`))
      }
    }
  } else {
    let page = 1
    while (page <= 200) {
      const data = await get(
        `/x/v3/fav/resource/list?ps=20&media_id=${target.id}&pn=${page}`,
      )
      const batch = data.medias || []
      if (batch.length === 0) break
      for (const media of batch) {
        if (!BVID.test(media.bvid || '')) continue
        if (Number(media.page) > 1) {
          tracks.push(...viewTracks(await get(`/x/web-interface/view?bvid=${media.bvid}`)))
        } else {
          tracks.push(makeTrack(media.bvid, 1, media.title))
        }
      }
      if (data.has_more === false) break
      page += 1
    }
  }

  if (tracks.length === 0) throw new ImportError('no playable videos found at that target')
  return dedupeTracks(tracks)
}
