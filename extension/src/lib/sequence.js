// One Bilibili video tab drives the sequence. The first detected tab keeps
// ownership until it closes; the survivors then elect again in detection order.

const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/

// Festival and other player pages carry the bvid in the query string.
export function isVideoTabUrl(url) {
  if (isVideoPageUrl(url)) return true
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'www.bilibili.com' &&
      BVID_PATTERN.test(parsed.searchParams.get('bvid') || '')
    )
  } catch {
    return false
  }
}

// A page whose own path is the video player, where soft navigation works.
export function isVideoPageUrl(url) {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'www.bilibili.com' &&
      /^\/video\/BV[0-9A-Za-z]{10}/.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

export function registerTab(tabs, { tabId, id, url, title, at }) {
  const previous = tabs[tabId]
  return {
    ...tabs,
    [tabId]: {
      tabId,
      id: typeof id === 'string' && id ? id : previous?.id ?? null,
      url: typeof url === 'string' && url ? url : previous?.url ?? null,
      title: typeof title === 'string' && title ? title : previous?.title ?? null,
      // A tab keeps the moment it was first detected; navigation must not demote it.
      detectedAt: previous?.detectedAt ?? at,
    },
  }
}

export function forgetTab(tabs, tabId) {
  if (!tabs[tabId]) return tabs
  const next = { ...tabs }
  delete next[tabId]
  return next
}

export function ownerTab(tabs) {
  let owner = null
  for (const entry of Object.values(tabs)) {
    if (!entry) continue
    if (
      owner === null ||
      entry.detectedAt < owner.detectedAt ||
      (entry.detectedAt === owner.detectedAt && entry.tabId < owner.tabId)
    ) {
      owner = entry
    }
  }
  return owner
}

export function ownerTabId(tabs) {
  return ownerTab(tabs)?.tabId ?? null
}
