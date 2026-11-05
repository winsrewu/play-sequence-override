// Console row formatting shared by listings and previews.

export function multiPageVideos(tracks) {
  const pages = new Map()
  for (const track of tracks) {
    const key = track.video_id || track.id
    if (!pages.has(key)) pages.set(key, new Set())
    pages.get(key).add(Number(track.page) || 1)
  }
  return new Set(
    [...pages.entries()].filter(([, values]) => values.size > 1).map(([key]) => key),
  )
}

export function trackText(track, { multi = false } = {}) {
  const title = String(track.title || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const page = Number(track.page) || 1
  // Every page of a multi-part video gets its P label; the first page has no
  // _1 suffix in the id, so it needs one too. Names already in the title stay.
  const labelled = new RegExp(` · P${page}(\\s|$)`).test(title)
  const label = (multi || page > 1) && !labelled ? ` · P${page}` : ''
  return `${track.id}  ${title}${label}`
}
