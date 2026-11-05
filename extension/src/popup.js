const $ = (id) => document.getElementById(id)

let refreshing = false
let refreshQueued = false
let targetSave = Promise.resolve()
let lastDecision = null
let launchMode = false

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

function renderDecision(log) {
  lastDecision = log || null
  const summary = $('decision-summary')
  if (!log) {
    summary.textContent = launchMode
      ? 'No selection yet. Launch opens the next track in a new tab.'
      : 'No selection yet. Press Next to produce one.'
    return
  }
  const request = log.request || {}
  const result = log.result || {}
  const algorithm = log.algorithm || {}
  const chosen = algorithm.chosen || {}
  const currentTitle = request.currentTrack?.title || request.current || 'unknown'
  const nextTitle = result.nextTrack?.title || result.nextId || 'unknown'
  const randomValues = Array.isArray(algorithm.randomValues) ? algorithm.randomValues : []
  const draw = randomValues.length > 0 ? randomValues[randomValues.length - 1] : null
  const tuning = request.tuning || {}
  const lines = [
    `${currentTitle} → ${nextTitle}`,
    `target ${Number(request.targetPercent ?? 0).toFixed(0)}% · pool ${algorithm.poolSize ?? 0} · sample ${algorithm.sampleSize ?? 0} · top ${(algorithm.topCandidates || []).length}`,
    `H ${tuning.historyLength ?? '—'} · skip ${tuning.forceSkip ?? '—'} · penalty ${Number(tuning.penaltyStrength ?? 0).toFixed(2)} · curve ${Number(tuning.curve ?? 0).toFixed(2)} · sim curve ${Number(tuning.simCurve ?? 0).toFixed(2)}`,
    `chosen rank ${chosen.rank ?? '—'} · score ${Number(chosen.score ?? 0).toExponential(4)} · similarity ${Number(chosen.normalizedSimilarity ?? 0).toFixed(4)}`,
    `history ${Number(chosen.historyPenalty ?? 0).toFixed(4)} + style ${Number(chosen.stylePenalty ?? 0).toFixed(4)} = penalty ${Number(chosen.combinedPenalty ?? chosen.historyPenalty ?? 0).toFixed(4)}`,
    `penalty factor ×${Number(chosen.penaltyFactor ?? chosen.historyFactor ?? 1).toFixed(4)} · plays ${chosen.plays ?? 0} · novelty ×${Number(chosen.novelty ?? 1).toFixed(4)}`,
    draw === null
      ? 'empty candidate pool'
      : `uniform top-${(algorithm.topCandidates || []).length} draw ${draw.toFixed(4)} → rank ${chosen.rank ?? '—'}`,
  ]
  summary.textContent = lines.join('\n')
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
    $('prefetch-auth').classList.add('hidden')
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
    $('prefetch-auth').classList.add('hidden')
    label.textContent = 'All vectors are present.'
    return
  }
  progress.classList.remove('hidden')
  progress.max = total
  progress.value = Math.min(total, done)
  if (state?.waitingAuth) {
    label.textContent = `Sign in to fetch ${state?.remaining || missing} missing vectors automatically.`
    $('prefetch-auth').classList.remove('hidden')
    return
  }
  $('prefetch-auth').classList.add('hidden')
  label.textContent =
    `Auto-fetching vectors ${progress.value}/${total}` +
    (state?.remaining ? ` · ${state.remaining} remaining` : '')
}

function remaining(state) {
  return Number(state?.remaining) || 0
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

  $('target').value = String(status.targetSimilarity)
  $('target-value').textContent = `${status.targetSimilarity}%`
  $('auto').checked = Boolean(status.autoAdvance)
  $('auto-hint').textContent = status.autoAdvance
    ? 'Auto-advance is ON at the real end of the main video.'
    : 'Auto-advance is OFF — tracks will only change with Next.'

  $('library').textContent = `${status.catalogCount} tracks · ${status.embeddedCount} embedded`
  const missing = status.missingCount || 0
  renderPrefetchState(
    status.prefetch,
    status.missingCount,
    status.catalogCount,
    status.embeddedCount,
  )
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
    strong.textContent = track.title || track.id
    item.append(strong, document.createTextNode(` · ${track.id}`))
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
    try {
      const decision = await send({ type: 'decision-log' })
      renderDecision(decision.log)
    } catch {
      renderDecision(null)
    }
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

$('prefetch-auth').addEventListener('click', (event) => {
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

$('prefetch').addEventListener('click', async (event) => {
  const button = event.currentTarget
  button.disabled = true
  $('prefetch-progress').classList.remove('hidden')
  $('prefetch-progress').value = 0
  $('prefetch-progress').max = 1
  $('prefetch-label').textContent = 'Starting…'
  try {
    const result = await send({ type: 'prefetch' })
    $('prefetch-label').textContent = `Fetched ${result.done}/${result.total}.`
  } catch (error) {
    $('prefetch-label').textContent = error.message
  } finally {
    button.disabled = false
    await refresh()
  }
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

$('decision-copy').addEventListener('click', async () => {
  if (!lastDecision) return
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastDecision, null, 2))
    $('decision-copy').textContent = 'Copied'
    setTimeout(() => { $('decision-copy').textContent = 'Copy JSON' }, 1500)
  } catch (error) {
    setError($('auth-error'), error)
  }
})

$('decision-download').addEventListener('click', () => {
  if (!lastDecision) return
  const blob = new Blob([JSON.stringify(lastDecision, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `jawbts-decision-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'data-changed') {
    refresh()
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
    $('prefetch-auth').classList.remove('hidden')
    return
  }
  $('prefetch-auth').classList.add('hidden')
  progress.classList.remove('hidden')
  progress.max = Math.max(1, message.total)
  progress.value = Math.min(message.total, message.done)
  $('prefetch-label').textContent =
    `Auto-fetching vectors ${message.done}/${message.total}` +
    (message.remaining ? ` · ${message.remaining} remaining` : '')
  if (message.complete) {
    $('prefetch-auth').classList.add('hidden')
    $('prefetch-label').textContent = 'All vectors are present.'
    setTimeout(() => progress.classList.add('hidden'), 2500)
  }
})

refresh()
