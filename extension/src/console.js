const $ = (id) => document.getElementById(id)

const log = $('log')
const input = $('command')
const previewPane = $('preview')

const PREVIEWABLE = new Set([
  'import',
  'merge',
  'remove',
  'restore',
  'forget',
  'stage',
  'remove-unavailable',
])

const history = []
let historyIndex = -1
let previewState = null
let previewToken = 0
let previewTimer = null
let running = false
const listingViews = new Set()

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function button(label, className = '') {
  const node = element('button', className, label)
  node.type = 'button'
  return node
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message)
  } catch (error) {
    return { ok: false, error: { message: error?.message || String(error) } }
  }
}

// Follow the newest output only while the transcript is at the bottom; once the
// user scrolls up, new lines never move the view.
let followOutput = true
let scrollFrame = 0

function distanceToBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight
}

function updateFollow() {
  followOutput = distanceToBottom() <= 24
}

function setStatus(text) {
  const status = $('status')
  $('status-text').textContent = text || ''
  status.classList.toggle('hidden', !text)
}

function scrollToBottom() {
  log.scrollTop = log.scrollHeight
}

function followBottom() {
  if (!followOutput) return
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    if (!followOutput) return
    scrollToBottom()
  })
}

function appendLine(kind, text) {
  log.append(element('div', `line ${kind}`, text))
  followBottom()
}

function appendLines(lines) {
  for (const line of lines) appendLine('output', line)
}

function itemText(item) {
  const span = element('span', 'item-text')
  const text = `${item.text}${item.extra || ''}`
  if (item.url && item.id && text.includes(item.id)) {
    const index = text.indexOf(item.id)
    span.append(document.createTextNode(text.slice(0, index)))
    const link = document.createElement('a')
    link.href = item.url
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = item.id
    span.append(link, document.createTextNode(text.slice(index + item.id.length)))
  } else {
    span.textContent = text
  }
  return span
}

function renderItem(item, onAction) {
  const row = element('li')
  row.append(itemText(item))
  if (Array.isArray(item.actions) && item.actions.length > 0) {
    const actions = element('span', 'item-actions')
    for (const action of item.actions) {
      const run = button(action.label, 'small')
      run.addEventListener('click', () => onAction(action.command))
      actions.append(run)
    }
    row.append(actions)
  }
  return row
}

const ROW_HEIGHT = 24

function autoListingSize() {
  return Math.max(5, Math.min(30, Math.floor((log.clientHeight - 150) / ROW_HEIGHT)))
}

function autoPreviewSize() {
  return Math.max(3, Math.min(24, Math.floor((window.innerHeight * 0.4) / ROW_HEIGHT)))
}

function pageLabel(state, visible, size = state.pageSize) {
  const pages = Math.max(1, Math.ceil(visible.length / size))
  state.page = Math.min(Math.max(1, state.page), pages)
  return { pages, page: state.page }
}

function appendListing(listing) {
  const section = element('section', 'listing')
  const head = element(
    'div',
    'listing-title',
    `${listing.title} · ${listing.total} item${listing.total === 1 ? '' : 's'}`,
  )
  const list = element('ol', 'items')
  const toolbar = element('div', 'toolbar')
  const label = element('span', 'page')
  const prev = button('← Prev')
  const next = button('Next →')
  const first = button('First')
  const last = button('Last')
  const all = button('Show all')
  const search = document.createElement('input')
  search.type = 'search'
  search.placeholder = 'Search'
  search.setAttribute('aria-label', 'Search listing')
  const find = button('Find')
  const clear = button('Clear')
  const size = document.createElement('select')
  size.setAttribute('aria-label', 'Page size')
  const autoOption = document.createElement('option')
  autoOption.value = 'auto'
  size.append(autoOption)
  for (const value of [10, 25, 50, 100]) {
    const option = document.createElement('option')
    option.value = String(value)
    option.textContent = `${value}/page`
    size.append(option)
  }
  const close = button('Close')
  toolbar.append(label, prev, next, first, last, all, search, find, clear, size, close)
  section.append(head, list, toolbar)
  log.append(section)
  followBottom()

  const state = {
    items: listing.items || [],
    filter: '',
    page: 1,
    pageSize: 'auto',
    showAll: false,
    fit: autoListingSize(),
  }
  const visible = () =>
    state.filter
      ? state.items.filter((item) => item.text.toLowerCase().includes(state.filter))
      : state.items

  function resolvedSize(items) {
    if (state.showAll) return Math.max(items.length, 1)
    if (state.pageSize === 'auto') return state.fit
    return Number(state.pageSize) || 50
  }

  function currentSlice() {
    const items = visible()
    const sizeValue = resolvedSize(items)
    const paged = pageLabel(state, items, sizeValue)
    const start = (paged.page - 1) * sizeValue
    return { items, sizeValue, paged, slice: items.slice(start, start + sizeValue) }
  }

  function paint() {
    const { items, sizeValue, paged, slice } = currentSlice()
    list.replaceChildren(...slice.map((item) => renderItem(item, submitLine)))
    label.textContent = `Page ${paged.page} of ${paged.pages} · ${items.length} item${items.length === 1 ? '' : 's'}`
    prev.disabled = paged.page <= 1
    first.disabled = paged.page <= 1
    next.disabled = paged.page >= paged.pages
    last.disabled = paged.page >= paged.pages
    all.disabled = state.showAll || items.length <= sizeValue
    autoOption.textContent = `Auto (${state.fit})`
    size.value = state.pageSize
    followBottom()
  }

  // Measure real row/toolbar heights instead of assuming, so an auto page
  // never exceeds the transcript viewport.
  function measure() {
    if (state.showAll || state.pageSize !== 'auto') return
    const rows = list.children
    if (rows.length === 0) return
    const heights = [...rows].map((row) => row.getBoundingClientRect().height)
    const rowHeight = Math.max(ROW_HEIGHT, ...heights)
    const chrome = head.offsetHeight + toolbar.offsetHeight + 24
    const available = log.clientHeight - chrome
    if (available <= 0) return
    // The tallest visible row plus a small margin: pages that fit without scrolling.
    const fit = Math.max(3, Math.min(30, Math.floor(available / (rowHeight * 1.05))))
    if (fit !== state.fit) {
      state.fit = fit
      paint()
    }
  }

  // A track can be P1 of a multi-part video whose P2 is not in the library.
  // Ask Bilibili for the page list of the visible P1 rows and show "P1 <name>".
  async function enrich(slice) {
    const pending = slice
      .filter(
        (item) =>
          item.videoId &&
          (Number(item.page) || 1) === 1 &&
          !item.enrichTried &&
          !/ · P1\s+\S/.test(item.text),
      )
      .slice(0, 30)
    if (pending.length === 0) return
    for (const item of pending) item.enrichTried = true
    const ids = [...new Set(pending.map((item) => item.videoId))]
    const response = await send({ type: 'part-info', ids })
    if (!response?.ok || !response.info) return
    let changed = false
    for (const item of pending) {
      const info = response.info[item.videoId]
      if (!info || info.count <= 1) continue
      const part = String(info.parts?.[0] || '').trim()
      item.text = item.text.replace(/ · P\d+$/, '')
      item.extra = part ? ` · P1 ${part}` : ' · P1'
      changed = true
    }
    if (changed) paint()
  }

  function render() {
    paint()
    measure()
    void enrich(currentSlice().slice)
  }

  prev.addEventListener('click', () => {
    state.page -= 1
    render()
  })
  next.addEventListener('click', () => {
    state.page += 1
    render()
  })
  first.addEventListener('click', () => {
    state.page = 1
    render()
  })
  last.addEventListener('click', () => {
    state.page = 10 ** 9
    render()
  })
  all.addEventListener('click', () => {
    state.showAll = true
    state.page = 1
    render()
  })
  find.addEventListener('click', () => {
    state.filter = search.value.trim().toLowerCase()
    state.page = 1
    render()
  })
  clear.addEventListener('click', () => {
    search.value = ''
    state.filter = ''
    state.page = 1
    render()
  })
  size.addEventListener('change', () => {
    state.showAll = false
    state.pageSize = size.value
    state.page = 1
    render()
  })
  close.addEventListener('click', () => section.classList.add('closed'))
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      find.click()
    }
  })

  listingViews.add({ refresh: render })
  render()
}

function renderPreview() {
  if (!previewState) return
  const { items } = previewState
  const visible = previewState.filter
    ? items.filter((item) => item.text.toLowerCase().includes(previewState.filter))
    : items
  const paged = pageLabel(previewState, visible)
  const start = (paged.page - 1) * previewState.pageSize
  $('preview-items').replaceChildren(
    ...visible.slice(start, start + previewState.pageSize).map((item) => renderItem(item, submitLine)),
  )
  $('preview-page').textContent = `Page ${paged.page} of ${paged.pages} · ${visible.length} item${visible.length === 1 ? '' : 's'}`
  $('preview-prev').disabled = paged.page <= 1
  $('preview-next').disabled = paged.page >= paged.pages
}

function showPreview(preview) {
  previewState = {
    items: Array.isArray(preview.items) ? preview.items : [],
    filter: '',
    page: 1,
    pageSize: autoPreviewSize(),
  }
  $('preview-title').textContent = preview.title || ''
  $('preview-summary').textContent = preview.summary || ''
  $('preview-search').value = ''
  previewPane.classList.remove('hidden')
  renderPreview()
  followBottom()
}

function showPreviewError(message) {
  previewState = null
  $('preview-title').textContent = 'preview'
  $('preview-summary').textContent = message
  $('preview-items').replaceChildren()
  $('preview-page').textContent = ''
  previewPane.classList.remove('hidden')
}

function hidePreview() {
  previewState = null
  previewPane.classList.add('hidden')
  followBottom()
}

async function refreshHeader() {
  const response = await send({ type: 'console-header' })
  if (response?.ok && response.header) {
    const { catalog, staged, removed } = response.header
    $('counts').textContent = `catalog ${catalog} · staged ${staged} · removed ${removed}`
  }
}

async function submitLine(line, { echo = true } = {}) {
  if (running) return
  const text = String(line || '').trim()
  if (!text) return
  if (text.toLowerCase() === 'clear') {
    log.replaceChildren()
    hidePreview()
    return
  }
  // The preview is informational only: drop any pending/visible one and run.
  previewToken += 1
  clearTimeout(previewTimer)
  if (echo) {
    history.unshift(text)
    if (history.length > 100) history.pop()
    historyIndex = -1
    appendLine('echo', `$ ${text}`)
  }
  hidePreview()
  running = true
  $('run').disabled = true
  setStatus('running…')
  try {
    const response = await send({ type: 'console-run', line: text })
    if (!response || response.ok === false) {
      appendLine('error', response?.error?.message || 'command failed')
    } else if (response.listing) {
      appendListing(response.listing)
    } else if (Array.isArray(response.lines)) {
      appendLines(response.lines)
    }
    await refreshHeader()
  } finally {
    running = false
    $('run').disabled = false
    setStatus('')
  }
}

async function runPreview() {
  if (running) return
  const line = input.value.trim()
  const token = ++previewToken
  if (!line) {
    hidePreview()
    setStatus('')
    return
  }
  const name = (line.split(/\s+/)[0] || '').toLowerCase()
  if (!PREVIEWABLE.has(name)) {
    hidePreview()
    setStatus('')
    return
  }
  setStatus('previewing…')
  const response = await send({ type: 'console-preview', line })
  if (token !== previewToken) return
  if (!running) setStatus('')
  if (response?.ok && response.preview) {
    showPreview(response.preview)
  } else if (response && response.ok === false) {
    showPreviewError(response.error?.message || 'invalid command')
  } else {
    hidePreview()
  }
}

function schedulePreview() {
  if (running) return
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => void runPreview(), 350)
}

$('prompt').addEventListener('submit', (event) => {
  event.preventDefault()
  if (running) return
  const line = input.value
  input.value = ''
  void submitLine(line)
})

input.addEventListener('input', () => {
  schedulePreview()
  followBottom()
})
input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowUp' && history.length > 0) {
    event.preventDefault()
    historyIndex = Math.min(historyIndex + 1, history.length - 1)
    input.value = history[historyIndex] || ''
    schedulePreview()
  } else if (event.key === 'ArrowDown' && history.length > 0) {
    event.preventDefault()
    historyIndex = Math.max(historyIndex - 1, -1)
    input.value = historyIndex === -1 ? '' : history[historyIndex] || ''
    schedulePreview()
  } else if (event.key === 'Escape') {
    hidePreview()
  }
})

$('preview-prev').addEventListener('click', () => {
  if (!previewState) return
  previewState.page -= 1
  renderPreview()
})
$('preview-next').addEventListener('click', () => {
  if (!previewState) return
  previewState.page += 1
  renderPreview()
})
$('preview-find').addEventListener('click', () => {
  if (!previewState) return
  previewState.filter = $('preview-search').value.trim().toLowerCase()
  previewState.page = 1
  renderPreview()
})
$('preview-clear').addEventListener('click', () => {
  if (!previewState) return
  $('preview-search').value = ''
  previewState.filter = ''
  previewState.page = 1
  renderPreview()
})
$('preview-search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    $('preview-find').click()
  }
})
$('preview-cancel').addEventListener('click', hidePreview)
let resizeTimer = null
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    for (const view of listingViews) view.refresh()
    if (previewState) {
      previewState.pageSize = autoPreviewSize()
      renderPreview()
    }
  }, 150)
})

log.addEventListener('scroll', updateFollow, { passive: true })
updateFollow()

appendLine('muted', 'Jawbts console — type help for commands')
appendLine('muted', 'Mutating commands preview first; use the buttons to page, search and apply.')
void refreshHeader()
input.focus()
