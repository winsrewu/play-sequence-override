import { formatLyricsRatio, normalizeLyricsShare } from './lib/lyrics.js'

const $ = (id) => document.getElementById(id)

let refreshing = false
let refreshQueued = false
let targetSave = Promise.resolve()
let launchMode = false
let currentLyrics = null

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response) throw new Error('The extension service worker did not respond.')
    if (response.ok === false) {
      const error = new Error(response.error?.message || 'Request failed')
      error.code = response.error?.code ?? null
      error.name = response.error?.name || 'Error'
      throw error
    }
    return response
  })
}

function setError(element, error) {
  if (!error) {
    element.textContent = ''
    element.classList.add('hidden')
    return
  }
  element.textContent = error.message || String(error)
  element.classList.remove('hidden')
}

const HISTORY_TITLE_LENGTH = 42

function shortHistoryTitle(title) {
  const value = String(title || '')
  if (value.length <= HISTORY_TITLE_LENGTH) return value
  return `${value.slice(0, HISTORY_TITLE_LENGTH - 1)}…`
}

function formatEta(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return ''
  const total = Math.round(value)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes > 0 ? ` · ~${minutes}m ${rest}s left` : ` · ~${rest}s left`
}

function renderPrefetchState(state, missingCount, catalogCount, embeddedCount) {
  const progress = $('prefetch-progress')
  const label = $('prefetch-label')
  const missing = Number(missingCount) || 0
  if (state?.waitingConsent) {
    progress.classList.add('hidden')
    label.textContent = 'Consent required in Settings & allowlist before fetching vectors remotely.'
    return
  }
  if (!state && missing === 0) {
    progress.classList.add('hidden')
    label.textContent = ''
    return
  }
  const stateTotal = Number(state?.total) || 0
  const total = stateTotal || Number(catalogCount) || missing
  const done = stateTotal > 0
    ? Math.max(0, Number(state?.done) || 0)
    : Math.max(0, Number(embeddedCount) || 0)
  if (total <= 0) {
    progress.classList.add('hidden')
    return
  }
  if (state?.complete && remaining(state) === 0) {
    progress.classList.add('hidden')
    const unavailable = Number(state?.unavailable) || 0
    const failed = Number(state?.failed) || 0
    label.textContent =
      unavailable > 0
        ? `All available vectors are present · ${unavailable} unavailable`
        : failed > 0
          ? `All available vectors are present · ${failed} failed`
          : 'All vectors are present.'
    return
  }
  progress.classList.remove('hidden')
  progress.max = total
  progress.value = Math.min(total, done)
  if (state?.waitingAuth) {
    label.textContent = `Sign in to fetch ${state?.remaining || missing} missing vectors automatically.`
    return
  }
  const eta = formatEta(state?.etaSeconds)
  label.textContent =
    `Fetching vectors ${progress.value}/${total}` +
    (state?.remaining ? ` · ${state.remaining} remaining` : '') +
    eta +
    (state?.running && !eta ? ' · estimating…' : '')
}

function remaining(state) {
  return Number(state?.remaining) || 0
}

function renderLyricsShare(share, enabled) {
  const value = normalizeLyricsShare(share)
  $('lyrics-share-value').textContent = enabled ? formatLyricsRatio(value) : 'off'
}

function renderLyricsState(lyrics) {
  const progress = $('lyrics-progress')
  const label = $('lyrics-label')
  const job = lyrics?.job || null
  if (!lyrics || !lyrics.tracks) {
    progress.classList.add('hidden')
    label.textContent = ''
    return
  }
  if (job?.running) {
    renderLyricsProgress(job)
    return
  }
  progress.classList.add('hidden')
  if (job?.waitingConsent) {
    label.textContent = 'Consent required in Settings & allowlist before fetching lyrics remotely.'
  } else if (job?.waitingAuth) {
    label.textContent =
      `Sign in to fetch ${lyrics.unknown || 0} missing lyrics automatically.`
  } else if ((lyrics.unknown || 0) > 0) {
    label.textContent =
      `${lyrics.unknown} track(s) need a lyrics verdict; fetching automatically when connected.`
  } else {
    label.textContent =
      `All tracks have a lyrics verdict · ${formatLyricsRatio(lyrics.share)}` +
      (lyrics.enabled ? '' : ' · share off')
  }
}

function renderLyricsProgress(job) {
  if (!job?.running) return
  const progress = $('lyrics-progress')
  progress.classList.remove('hidden')
  progress.max = Math.max(1, job.total)
  progress.value = Math.min(job.total, job.done)
  $('lyrics-label').textContent =
    `Detecting lyrics ${job.done}/${job.total}` +
    (job.remaining ? ` · ${job.remaining} left` : '') +
    formatEta(job.etaSeconds)
}

function render(status, tab = null) {
  const connected = Boolean(status.session?.connected)
  const devMode = Boolean(status.session?.devMode)
  $('connection-pill').textContent = devMode ? 'dev' : connected ? 'connected' : 'offline'
  $('connection-pill').className = `pill ${connected ? 'on' : 'off'}`

  $('account').textContent = devMode
    ? 'Local dev mode — API auth disabled'
    : connected
      ? `${status.session.subject || 'unknown account'} · ${status.session.scope.join(', ') || 'no scope'}`
      : 'Not connected'
  $('connect').classList.toggle('hidden', connected || devMode)
  $('disconnect').classList.toggle('hidden', !connected || devMode)

  $('allowlist').textContent = devMode
    ? 'Dev mode: no OAuth. API must run with DEV_MODE=true.'
    : `OAuth redirect: ${status.redirectUri} · allowlist host: ${status.gatewayAllowlistHost}`

  // Exactly one detected tab drives the sequence; every other page stays inert.
  const owner = status.owner || null
  const ownedElsewhere = Boolean(owner) && owner.tabId !== tab?.id
  $('current-title').textContent = status.current?.title || 'No track detected'
  $('current-meta').textContent = status.current
    ? `${status.current.id} · page ${status.current.page}` +
      (ownedElsewhere ? ' · another tab is in control' : '')
    : 'Open a Bilibili video page to begin.'
  $('next').textContent = status.current ? 'Next' : 'Launch'
  $('next').disabled = ownedElsewhere
  $('next').title = ownedElsewhere
    ? 'Another tab owns the play sequence'
    : status.current
      ? 'Select the next track'
      : 'Open the next track in a new tab'
  launchMode = !status.current

  currentLyrics = status.lyrics?.current || null
  const lyricsToggle = $('lyrics-toggle')
  lyricsToggle.disabled = !status.current
  lyricsToggle.textContent = status.current
    ? currentLyrics
      ? `Lyrics: ${currentLyrics.lyrics ? 'yes' : 'no'}` +
        (currentLyrics.source === 'manual' ? ' (manual)' : '')
      : 'Lyrics: unknown'
    : 'Lyrics: —'
  lyricsToggle.title = status.current
    ? 'Switch this track between lyrics and instrumental'
    : 'Play a Bilibili video first'
  renderLyricsState(status.lyrics)

  $('target').value = String(status.targetSimilarity)
  $('target-value').textContent = `${status.targetSimilarity}%`

  const lyricsConfig = status.lyrics || {}
  const share = normalizeLyricsShare(lyricsConfig.share)
  const lyricsEnabled = lyricsConfig.enabled !== false
  $('lyrics-enabled').checked = lyricsEnabled
  $('lyrics-share').disabled = !lyricsEnabled
  $('lyrics-share').value = String(share)
  renderLyricsShare(share, lyricsEnabled)
  $('auto').checked = Boolean(status.autoAdvance)

  $('library').textContent = `${status.catalogCount} tracks · ${status.embeddedCount} embedded`
  const missing = status.missingCount || 0
  renderPrefetchState(
    status.prefetch,
    status.missingCount,
    status.catalogCount,
    status.embeddedCount,
  )
  const unavailable = Array.isArray(status.unavailable) ? status.unavailable : []
  const unavailableLabel = $('unavailable-label')
  if (unavailable.length > 0) {
    const names = unavailable.slice(0, 3).map((item) => item.title || item.id)
    unavailableLabel.textContent =
      `${unavailable.length} unavailable: ${names.join(', ')}` +
      (unavailable.length > 3 ? '…' : '')
  } else {
    unavailableLabel.textContent = ''
  }
  const consent = status.consent || null
  const consentNeeded = Boolean(consent?.required && !consent.granted)
  $('vector-status').textContent = consentNeeded
    ? 'Cross-border transfer consent required in Settings & allowlist; remote calls are disabled.'
    : status.catalogMissing
    ? 'No catalog yet — use Import JSON to load a playlist.'
    : status.vectorError
      ? `Embedding error: ${status.vectorError}`
      : missing > 0
        ? `${missing} track${missing === 1 ? '' : 's'} need vectors; fetching automatically when connected`
        : 'Every track has a vector.'

  const history = $('history')
  history.replaceChildren()
  for (const track of status.history || []) {
    const item = document.createElement('li')
    const strong = document.createElement('strong')
    strong.textContent = shortHistoryTitle(track.title || track.id)
    item.append(strong)
    history.append(item)
  }
  if (!history.children.length) {
    const item = document.createElement('li')
    item.textContent = 'No plays recorded yet.'
    history.append(item)
  }

  $('version').textContent = `v${chrome.runtime.getManifest().version}`
}

async function activeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return tab || null
  } catch {
    return null
  }
}

async function ensureContent(tab) {
  try {
    if (
      tab?.id &&
      typeof tab.url === 'string' &&
      tab.url.startsWith('https://www.bilibili.com/')
    ) {
      await chrome.runtime.sendMessage({ type: 'ensure-content', tabId: tab.id })
    }
  } catch {
  }
}

async function refresh() {
  if (refreshing) {
    refreshQueued = true
    return
  }
  refreshing = true
  const tab = await activeTab()
  await ensureContent(tab)
  try {
    render(await send({ type: 'status' }), tab)
  } catch (error) {
    setError($('auth-error'), error)
  } finally {
    refreshing = false
    if (refreshQueued) {
      refreshQueued = false
      refresh()
    }
  }
}

async function run(button, operation) {
  button.disabled = true
  setError($('auth-error'), null)
  setError($('library-error'), null)
  try {
    await operation()
  } catch (error) {
    setError($('auth-error'), error)
  } finally {
    button.disabled = false
    await refresh()
  }
}

$('connect').addEventListener('click', (event) => {
  run(event.currentTarget, async () => {
    await send({ type: 'connect' })
  })
})

$('disconnect').addEventListener('click', (event) => {
  run(event.currentTarget, async () => {
    await send({ type: 'disconnect' })
  })
})

$('next').addEventListener('click', (event) => {
  run(event.currentTarget, async () => {
    await targetSave.catch(() => {})
    const targetSimilarity = Number($('target').value)
    await send(launchMode ? { type: 'launch', targetSimilarity } : { type: 'next', targetSimilarity })
  })
})

$('target').addEventListener('input', (event) => {
  $('target-value').textContent = `${event.target.value}%`
})

$('target').addEventListener('change', (event) => {
  targetSave = send({ type: 'set-target', value: Number(event.target.value) }).catch((error) => {
    setError($('auth-error'), error)
  })
})

$('auto').addEventListener('change', (event) => {
  send({ type: 'set-auto', value: event.target.checked }).catch((error) => {
    setError($('auth-error'), error)
  })
})

$('lyrics-share').addEventListener('input', (event) => {
  renderLyricsShare(event.target.value, $('lyrics-enabled').checked)
})

$('lyrics-share').addEventListener('change', (event) => {
  send({
    type: 'save-config',
    config: { lyricsShare: Number(event.target.value) },
  }).catch((error) => {
    setError($('auth-error'), error)
  })
})

$('lyrics-enabled').addEventListener('change', (event) => {
  $('lyrics-share').disabled = !event.target.checked
  renderLyricsShare(Number($('lyrics-share').value), event.target.checked)
  send({
    type: 'save-config',
    config: { lyricsEnabled: event.target.checked },
  }).catch((error) => {
    setError($('auth-error'), error)
  })
})

$('lyrics-toggle').addEventListener('click', (event) => {
  const button = event.currentTarget
  if (button.disabled) return
  const wanted = currentLyrics ? !currentLyrics.lyrics : true
  // Flip the button now; the IndexedDB write and the status refresh run behind
  // it, so a toggle never waits for the whole library to be re-summarized.
  currentLyrics = {
    ...(currentLyrics || {}),
    lyrics: wanted,
    confidence: null,
    source: 'manual',
  }
  button.textContent = `Lyrics: ${wanted ? 'yes' : 'no'} (manual)`
  // Fire and forget: the write and the follow-up status refresh happen in the
  // background. A failure is reported but never rolls the label back.
  send({ type: 'set-lyrics', value: wanted }).catch((error) => {
    setError($('auth-error'), error)
  })
})

$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const result = await send({ type: 'import', text })
    $('library').textContent = `${result.count} tracks imported`
    setError($('library-error'), null)
  } catch (error) {
    setError($('library-error'), error)
  } finally {
    await refresh()
  }
})

async function downloadExport() {
  const result = await send({ type: 'export' })
  const blob = new Blob([result.json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

$('export-v2').addEventListener('click', (event) => {
  run(event.currentTarget, () => downloadExport())
})

$('clear-history').addEventListener('click', (event) => {
  run(event.currentTarget, async () => {
    await send({ type: 'clear-history' })
  })
})

$('open-options').addEventListener('click', (event) => {
  event.preventDefault()
  chrome.runtime.openOptionsPage()
})

$('open-console').addEventListener('click', (event) => {
  event.preventDefault()
  chrome.tabs.create({ url: chrome.runtime.getURL('src/console.html') })
})

$('open-graph').addEventListener('click', (event) => {
  event.preventDefault()
  chrome.tabs.create({ url: chrome.runtime.getURL('src/graph.html') })
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'data-changed') {
    refresh()
    return
  }
  if (message?.type === 'lyrics-progress') {
    renderLyricsProgress(message)
    return
  }
  if (message?.type !== 'prefetch-progress') return
  const progress = $('prefetch-progress')
  if (message.waitingAuth) {
    progress.classList.remove('hidden')
    progress.max = Math.max(1, message.total)
    progress.value = 0
    $('prefetch-label').textContent =
      `Sign in to fetch ${message.remaining || 0} missing vectors automatically.`
    return
  }
  progress.classList.remove('hidden')
  progress.max = Math.max(1, message.total)
  progress.value = Math.min(message.total, message.done)
  const eta = formatEta(message.etaSeconds)
  $('prefetch-label').textContent =
    `Fetching vectors ${message.done}/${message.total}` +
    (message.remaining ? ` · ${message.remaining} remaining` : '') +
    eta +
    (!eta && message.remaining ? ' · estimating…' : '')
  if (message.complete) {
    const unavailable = Number(message.unavailable) || 0
    const failed = Number(message.failed) || 0
    $('prefetch-label').textContent =
      unavailable > 0
        ? `All available vectors are present · ${unavailable} unavailable`
        : failed > 0
          ? `All available vectors are present · ${failed} failed`
          : 'All vectors are present.'
    setTimeout(() => progress.classList.add('hidden'), 2500)
  }
})

refresh()
