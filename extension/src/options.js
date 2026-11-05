import {
  buildAuthorizeUrl,
  DEFAULT_CONFIG,
  isLocalUrl,
  normalizeConfig,
} from './lib/config.js'
import { getConfig, setConfig } from './lib/storage.js'

const $ = (id) => document.getElementById(id)

function setStatus(message, kind = '') {
  $('status').textContent = message
  $('status').className = `status ${kind}`
}

function readForm() {
  return normalizeConfig({
    apiBaseUrl: $('api-base').value,
    gatewayAuthorizeUrl: $('gateway').value,
    embedApiUrl: $('embed').value,
    scope: $('scope').value,
    targetSimilarity: Number($('target').value),
    historyLength: Number($('history-length').value),
    penaltyStrength: Number($('penalty-strength').value),
    curve: Number($('curve').value),
    similarityCurve: Number($('similarity-curve').value),
    forceSkip: Number($('force-skip').value),
    autoAdvance: $('auto').checked,
    softNavigation: $('soft-nav').checked,
    devMode: $('dev-mode').checked,
  })
}

function renderMeta(config) {
  const id = chrome.runtime.id
  const redirect = chrome.identity.getRedirectURL('oauth')
  $('extension-id').textContent = id
  $('redirect-uri').textContent = redirect
  $('allowlist-host').textContent = new URL(redirect).hostname
  $('authorize-url').textContent = buildAuthorizeUrl(config, redirect, '<state>')
}

function fillForm(config) {
  $('api-base').value = config.apiBaseUrl
  $('gateway').value = config.gatewayAuthorizeUrl
  $('embed').value = config.embedApiUrl
  $('scope').value = config.scope
  $('target').value = String(config.targetSimilarity)
  $('history-length').value = String(config.historyLength)
  $('penalty-strength').value = String(config.penaltyStrength)
  $('curve').value = String(config.curve)
  $('similarity-curve').value = String(config.similarityCurve)
  $('force-skip').value = String(config.forceSkip)
  $('auto').checked = Boolean(config.autoAdvance)
  $('soft-nav').checked = Boolean(config.softNavigation)
  $('dev-mode').checked = Boolean(config.devMode)
}

async function refreshConsent() {
  const checkbox = $('transfer-consent')
  const label = $('transfer-consent-status')
  try {
    const response = await chrome.runtime.sendMessage({ type: 'consent-status' })
    const consent = response?.consent
    if (!consent || !consent.required) {
      checkbox.checked = false
      checkbox.disabled = true
      label.textContent = 'All configured services are local; no cross-border transfer is involved.'
      return
    }
    checkbox.disabled = false
    checkbox.checked = Boolean(consent.granted)
    label.textContent = consent.granted
      ? `Granted for ${consent.origins.join(', ')}${consent.at ? ` on ${consent.at}` : ''}.`
      : `Not granted. Remote services: ${consent.origins.join(', ')}.`
  } catch (error) {
    label.textContent = error?.message || String(error)
  }
}

async function load() {
  const config = await getConfig()
  fillForm(config)
  renderMeta(config)
  await refreshConsent()
  try {
    chrome.runtime
      .sendMessage({ type: 'ensure-prefetch' })
      .then((response) => {
        if (response?.prefetch) renderPrefetchState(response.prefetch)
      })
      .catch(() => {})
  } catch {
  }
}

$('dev-mode').addEventListener('change', async (event) => {
  if (event.target.checked && !isLocalUrl($('embed').value)) {
    $('embed').value = 'http://localhost:8000/v1/embed'
  } else if (!event.target.checked && isLocalUrl($('embed').value)) {
    $('embed').value = DEFAULT_CONFIG.embedApiUrl
  }
  try {
    const config = await setConfig(readForm())
    fillForm(config)
    renderMeta(config)
    setStatus(
      config.devMode
        ? 'Dev mode enabled and saved. API auth is disabled.'
        : 'Dev mode disabled and saved. Sign in to use the protected OAuth webview.',
      'ok',
    )
  } catch (error) {
    setStatus(error.message, 'bad')
  }
})

$('transfer-consent').addEventListener('change', async (event) => {
  try {
    await chrome.runtime.sendMessage({ type: 'set-consent', value: event.target.checked })
  } catch (error) {
    $('transfer-consent-status').textContent = error?.message || String(error)
  } finally {
    await refreshConsent()
  }
})

$('save').addEventListener('click', async () => {
  try {
    const config = await setConfig(readForm())
    fillForm(config)
    renderMeta(config)
    await refreshConsent()
    setStatus('Saved.', 'ok')
  } catch (error) {
    setStatus(error.message, 'bad')
  }
})

$('reset').addEventListener('click', async () => {
  try {
    const config = await setConfig(DEFAULT_CONFIG)
    fillForm(config)
    renderMeta(config)
    await refreshConsent()
    setStatus('Defaults restored.', 'ok')
  } catch (error) {
    setStatus(error.message, 'bad')
  }
})

$('auth-connect').addEventListener('click', async (event) => {
  const button = event.currentTarget
  button.disabled = true
  $('auth-status').textContent = 'Opening the protected OAuth webview…'
  try {
    const result = await chrome.runtime.sendMessage({ type: 'connect' })
    $('auth-status').textContent = result?.session?.devMode
      ? 'Dev mode is enabled; no OAuth webview was needed.'
      : 'Signed in. Missing vectors will be fetched automatically.'
  } catch (error) {
    $('auth-status').textContent = error?.message || String(error)
  } finally {
    button.disabled = false
  }
})

$('copy-host').addEventListener('click', async () => {
  const host = $('allowlist-host').textContent
  try {
    await navigator.clipboard.writeText(host)
    setStatus(`Copied ${host}`, 'ok')
  } catch {
    setStatus('Could not use the clipboard; select the host manually.', 'bad')
  }
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'prefetch-progress') {
    renderPrefetchState(message)
  }
})

function renderPrefetchState(state) {
  const progress = $('prefetch-progress')
  const label = $('prefetch-status')
  if (!state || (!state.total && !state.waitingAuth)) {
    progress.classList.add('hidden')
    return
  }
  if (state.waitingAuth) {
    progress.classList.remove('hidden')
    progress.max = Math.max(1, state.total || 0)
    progress.value = 0
    label.textContent = `Sign in to fetch ${state.remaining || 0} missing vectors automatically.`
    return
  }
  if (state.complete) {
    progress.classList.add('hidden')
    label.textContent = 'All vectors are present.'
    return
  }
  progress.classList.remove('hidden')
  progress.max = Math.max(1, state.total)
  progress.value = Math.min(state.total, state.done || 0)
  label.textContent =
    `Auto-fetching vectors ${progress.value}/${state.total}` +
    (state.remaining ? ` · ${state.remaining} remaining` : '')
}

async function importEmbeddingFiles(files) {
  const jsonFiles = files.filter((file) => /\.json$/i.test(file.name))
  if (jsonFiles.length === 0) {
    $('embedding-import-status').textContent = 'No JSON files selected.'
    return
  }
  let total = 0
  let ignored = 0
  try {
    $('embedding-progress').classList.remove('hidden')
    $('embedding-progress').max = jsonFiles.length
    $('embedding-progress').value = 0
    for (let index = 0; index < jsonFiles.length; index += 1) {
      const file = jsonFiles[index]
      $('embedding-import-status').textContent = `Importing ${file.name}…`
      const text = await file.text()
      const response = await chrome.runtime.sendMessage({ type: 'import-embeddings', text })
      if (!response?.ok) throw new Error(response?.error?.message || 'Import failed')
      total += response.count
      ignored += response.ignored || 0
      $('embedding-progress').value = index + 1
      $('embedding-import-status').textContent =
        `Imported ${total} vectors from ${index + 1}/${jsonFiles.length} file(s)` +
        (ignored ? ` · ignored ${ignored}` : '') + '…'
    }
    $('embedding-import-status').textContent =
      `Imported ${total} vectors from ${jsonFiles.length} file(s)` +
      (ignored ? ` · ignored ${ignored} without a playlist track.` : '.')
    setTimeout(() => $('embedding-progress').classList.add('hidden'), 2500)
  } catch (error) {
    $('embedding-import-status').textContent = error.message
  }
}

$('embedding-files').addEventListener('change', async (event) => {
  const files = [...(event.target.files || [])]
  event.target.value = ''
  await importEmbeddingFiles(files)
})

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

$('export-vectors').addEventListener('click', async (event) => {
  const button = event.currentTarget
  button.disabled = true
  $('vector-transfer-status').textContent = 'Exporting…'
  try {
    const response = await chrome.runtime.sendMessage({ type: 'export-vectors' })
    if (!response?.ok) throw new Error(response?.error?.message || 'Export failed')
    downloadText(response.text, response.filename)
    $('vector-transfer-status').textContent = `Exported ${response.count} vectors.`
  } catch (error) {
    $('vector-transfer-status').textContent = error?.message || String(error)
  } finally {
    button.disabled = false
  }
})

$('import-vectors').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  $('vector-transfer-status').textContent = 'Importing…'
  try {
    const text = await file.text()
    const response = await chrome.runtime.sendMessage({ type: 'import-vectors', text })
    if (!response?.ok) throw new Error(response?.error?.message || 'Import failed')
    $('vector-transfer-status').textContent =
      `Imported ${response.count} vectors (${response.dim} dimensions).`
  } catch (error) {
    $('vector-transfer-status').textContent = error?.message || String(error)
  }
})

$('request-permissions').addEventListener('click', async () => {
  try {
    const config = readForm()
    const origins = new Set()
    for (const value of [config.apiBaseUrl, config.embedApiUrl, config.gatewayAuthorizeUrl]) {
      const url = new URL(value)
      origins.add(`${url.origin}/*`)
    }
    const granted = await chrome.permissions.request({ origins: [...origins] })
    setStatus(granted ? 'Host access granted.' : 'Host access was not granted.', granted ? 'ok' : 'bad')
  } catch (error) {
    setStatus(error.message, 'bad')
  }
})

load().catch((error) => setStatus(error.message, 'bad'))
