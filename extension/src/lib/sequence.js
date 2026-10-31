// One Bilibili video tab drives the sequence. The first detected tab keeps
// ownership until it closes; the survivors then elect again in detection order.

export function isVideoTabUrl(url) {
  return typeof url === 'string' && url.startsWith('https://www.bilibili.com/video/')
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
