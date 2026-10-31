const canvas = document.getElementById('map')
const ctx = canvas.getContext('2d')
const tooltip = document.getElementById('tooltip')
const targetInput = document.getElementById('target')
const targetValue = document.getElementById('target-value')
const status = document.getElementById('status')
const error = document.getElementById('error')
const reloadExtension = document.getElementById('reload-extension')
const GRAPH_PROTOCOL = 2
const historyInput = document.getElementById('history-length')
const penaltyInput = document.getElementById('penalty-strength')
const curveInput = document.getElementById('curve')
const similarityCurveInput = document.getElementById('similarity-curve')
const forceSkipInput = document.getElementById('force-skip')
const historyValue = document.getElementById('history-value')
const modeButton = document.getElementById('mode')
const rankLegend = document.getElementById('rank-legend')
const decayPlot = document.getElementById('decay-plot')
const responsePlot = document.getElementById('response-plot')
const decayFormula = document.getElementById('decay-formula')
const responseFormula = document.getElementById('response-formula')
const penaltyValue = document.getElementById('penalty-value')
const curveValue = document.getElementById('curve-value')
const similarityValue = document.getElementById('similarity-value')
const forceValue = document.getElementById('force-value')

let projection = null
let points = []
let current = null
let requestId = 0
let timer = null
let viewMode = 'likelihood'
let lastProbabilities = null
let lastMax = 0
let lastRaw = {}

const COLORS = [
  [0, [70, 70, 80]],
  [0.35, [106, 76, 147]],
  [0.7, [255, 159, 28]],
  [1, [255, 61, 0]],
]

function colorFor(ratio) {
  const value = Math.min(1, Math.max(0, ratio))
  for (let i = 1; i < COLORS.length; i += 1) {
    const [stop, color] = COLORS[i]
    const [prevStop, prevColor] = COLORS[i - 1]
    if (value <= stop) {
      const t = (value - prevStop) / (stop - prevStop || 1)
      return `rgb(${Math.round(prevColor[0] + (color[0] - prevColor[0]) * t)}, ${Math.round(
        prevColor[1] + (color[1] - prevColor[1]) * t,
      )}, ${Math.round(prevColor[2] + (color[2] - prevColor[2]) * t)})`
    }
  }
  return 'rgb(255, 61, 0)'
}

function tuningValues() {
  return {
    historyLength: Number(historyInput.value),
    penaltyStrength: Number(penaltyInput.value),
    curve: Number(curveInput.value),
    simCurve: Number(similarityCurveInput.value),
    forceSkip: Number(forceSkipInput.value),
  }
}

function drawCurve(canvas, xs, ys, { xLabel, yLabel, xMax, color }) {
  const ctx = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
  const ink = dark ? '#d9d9d9' : '#454545'
  const muted = dark ? '#b8b8b8' : '#777'
  const grid = dark ? '#333' : '#e5e5e5'
  const left = 48
  const right = 14
  const top = 16
  const bottom = 34
  const plotW = width - left - right
  const plotH = height - top - bottom
  const maxY = 1.05
  const sx = (value) => left + (value / (xMax || 1)) * plotW
  const sy = (value) => top + (1 - value / maxY) * plotH

  ctx.clearRect(0, 0, width, height)
  ctx.font = '10px "Open Sans", "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif'
  ctx.textBaseline = 'middle'

  ctx.strokeStyle = grid
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i += 1) {
    const value = i / 4
    const y = sy(value)
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(width - right, y)
    ctx.stroke()
    ctx.fillStyle = muted
    ctx.textAlign = 'right'
    ctx.fillText(value.toFixed(2), left - 6, y)
  }

  const xTicks = [0, 0.5, 1]
  for (const tick of xTicks) {
    const x = sx((xMax || 1) * tick)
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, top + plotH)
    ctx.stroke()
    ctx.fillStyle = muted
    ctx.textAlign = tick === 0 ? 'left' : tick === 1 ? 'right' : 'center'
    const label = xMax <= 1 ? tick.toFixed(2) : String(Math.round((xMax || 0) * tick))
    ctx.fillText(label, x, height - 20)
  }

  ctx.strokeStyle = dark ? '#555' : '#bbb'
  ctx.beginPath()
  ctx.moveTo(left, top)
  ctx.lineTo(left, top + plotH)
  ctx.lineTo(width - right, top + plotH)
  ctx.stroke()

  ctx.fillStyle = muted
  ctx.textAlign = 'center'
  ctx.fillText(xLabel, left + plotW / 2, height - 5)
  ctx.save()
  ctx.translate(12, top + plotH / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText(yLabel, 0, 0)
  ctx.restore()

  ctx.strokeStyle = color
  ctx.lineWidth = 2.5
  ctx.beginPath()
  for (let i = 0; i < xs.length; i += 1) {
    const x = sx(xs[i])
    const y = sy(ys[i])
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

function updateCurvePlots() {
  const historyLength = Math.max(10, Math.min(400, Number(historyInput.value) || 400))
  const curve = Number(curveInput.value) || 0.5
  const simCurve = Number(similarityCurveInput.value) || 0.5
  const ages = Array.from({ length: historyLength }, (_, index) => index)
  const weights = ages.map((age) => Math.pow(1 - age / Math.max(historyLength - 1, 1), curve))
  drawCurve(decayPlot, ages, weights, {
    xLabel: 'Tracks ago',
    yLabel: 'Weight',
    xMax: Math.max(1, historyLength - 1),
    color: '#ff9f1c',
  })
  const similarities = Array.from({ length: 101 }, (_, index) => index / 100)
  const influence = similarities.map((similarity) => Math.pow(similarity, simCurve))
  drawCurve(responsePlot, similarities, influence, {
    xLabel: 'Normalized cosine similarity',
    yLabel: 'History influence',
    xMax: 1,
    color: '#4cc9f0',
  })
  decayFormula.textContent = `w(age) = (1 − age / (H − 1))^${curve.toFixed(2)}`
  responseFormula.textContent = `history influence = s^${simCurve.toFixed(2)}`
}

function renderTuning(tuning) {
  if (!tuning) return
  historyInput.value = String(tuning.historyLength ?? historyInput.value)
  penaltyInput.value = String(tuning.penaltyStrength ?? penaltyInput.value)
  curveInput.value = String(tuning.curve ?? curveInput.value)
  similarityCurveInput.value = String(tuning.simCurve ?? tuning.similarityCurve ?? similarityCurveInput.value)
  forceSkipInput.value = String(tuning.forceSkip ?? forceSkipInput.value)
  historyValue.textContent = historyInput.value
  penaltyValue.textContent = Number(penaltyInput.value).toFixed(1)
  curveValue.textContent = Number(curveInput.value).toFixed(2)
  similarityValue.textContent = Number(similarityCurveInput.value).toFixed(2)
  forceValue.textContent = forceSkipInput.value
  updateCurvePlots()
}

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response) throw new Error('The service worker did not respond.')
    if (response.ok === false) throw new Error(response.error?.message || 'Request failed')
    return response
  })
}

async function loadProbabilities(target) {
  const id = ++requestId
  status.textContent = 'Updating map…'
  try {
    const data = await send({ type: 'graph-data', targetSimilarity: Number(target), tuning: tuningValues() })
    if (id !== requestId) return
    current = data.current || null
    document.getElementById('next').disabled = !current
    renderTuning(data.tuning)
    const points = Array.isArray(data.points) ? data.points : []
    lastRaw = data.raw || {}
    projection = {
      ids: points.map((point) => point.id),
      x: points.map((point) => point.x),
      y: points.map((point) => point.y),
    }
    const max = Number(data.max) || 0
    const probabilities = data.probabilities || {}
    draw(probabilities, max, data.raw || {})
    status.textContent = current ? `Target ${Math.round(data.target)}%` : 'No current track detected.'
    error.classList.add('hidden')
  } catch (caught) {
    error.textContent = caught.message
    error.classList.remove('hidden')
    status.textContent = ''
    if (/older build|Unknown message/i.test(caught.message)) {
      reloadExtension.classList.remove('hidden')
    }
  }
}

function draw(probabilities, max, raw = lastRaw) {
  if (!projection) return
  lastProbabilities = probabilities
  lastMax = max
  lastRaw = raw || {}
  const width = canvas.width
  const height = canvas.height
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = dark ? '#000' : '#fff'
  ctx.fillRect(0, 0, width, height)

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < projection.ids.length; i += 1) {
    minX = Math.min(minX, projection.x[i])
    maxX = Math.max(maxX, projection.x[i])
    minY = Math.min(minY, projection.y[i])
    maxY = Math.max(maxY, projection.y[i])
  }
  const pad = 32
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  const sx = (width - pad * 2) / spanX
  const sy = (height - pad * 2) / spanY
  const scale = Math.min(sx, sy)
  const offsetX = (width - spanX * scale) / 2
  const offsetY = (height - spanY * scale) / 2

  const ranked = viewMode === 'candidates'
    ? Object.entries(probabilities)
        .filter(([, probability]) => Number(probability) > 0)
        .sort((a, b) => b[1] - a[1])
    : []
  const rankById = new Map(ranked.map(([id], index) => [id, index + 1]))
  const rawValues = Object.values(raw).map(Number).filter(Number.isFinite)
  const rawMin = rawValues.length ? Math.min(...rawValues) : 0
  const rawMax = rawValues.length ? Math.max(...rawValues) : 1
  const rawSpan = rawMax - rawMin || 1

  points = []
  for (let i = 0; i < projection.ids.length; i += 1) {
    const x = offsetX + (projection.x[i] - minX) * scale
    const y = height - (offsetY + (projection.y[i] - minY) * scale)
    const id = projection.ids[i]
    const probability = Number(probabilities[id]) || 0
    const ratio = max > 0 ? probability / max : 0
    const rank = rankById.get(id) || 0
    const rawValue = Number(raw[id] ?? 0)
    const rawRatio = (rawValue - rawMin) / rawSpan
    const radius = viewMode === 'candidates'
      ? rank >= 1 && rank <= 10 ? 8 : rank >= 11 && rank <= 20 ? 7 : rank >= 21 && rank <= 30 ? 6 : 0
      : viewMode === 'raw' ? 5 : 3.5 + 6 * ratio
    points.push({ id, x, y, ratio, rank, raw: rawValue })
    if (radius <= 0) continue
    ctx.beginPath()
    ctx.fillStyle = viewMode === 'candidates'
      ? rank <= 10 ? 'rgb(255, 59, 48)' : rank <= 20 ? 'rgb(255, 209, 102)' : 'rgb(46, 204, 113)'
      : colorFor(viewMode === 'raw' ? rawRatio : ratio)
    ctx.globalAlpha = viewMode === 'candidates' ? 1 : 0.88
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  if (viewMode === 'likelihood') {
    const legendX = width - 28
    const legendY = 46
    const legendH = 118
    const legendW = 9
    const gradient = ctx.createLinearGradient(0, legendY + legendH, 0, legendY)
    gradient.addColorStop(0, colorFor(0))
    gradient.addColorStop(0.35, colorFor(0.35))
    gradient.addColorStop(0.7, colorFor(0.7))
    gradient.addColorStop(1, colorFor(1))
    ctx.fillStyle = gradient
    ctx.fillRect(legendX, legendY, legendW, legendH)
    ctx.strokeStyle = dark ? '#555' : '#bbb'
    ctx.strokeRect(legendX, legendY, legendW, legendH)
    ctx.fillStyle = dark ? '#d9d9d9' : '#454545'
    ctx.font = '10px "Open Sans", "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText('1.00', legendX - 5, legendY)
    ctx.fillText('0.50', legendX - 5, legendY + legendH / 2)
    ctx.fillText('0.00', legendX - 5, legendY + legendH)
    ctx.save()
    ctx.translate(legendX + 16, legendY + legendH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.fillText('Likelihood', 0, 0)
    ctx.restore()
  }

  if (viewMode === 'raw') {
    const legendX = width - 28
    const legendY = 46
    const legendH = 118
    const legendW = 9
    const gradient = ctx.createLinearGradient(0, legendY + legendH, 0, legendY)
    gradient.addColorStop(0, colorFor(0))
    gradient.addColorStop(0.35, colorFor(0.35))
    gradient.addColorStop(0.7, colorFor(0.7))
    gradient.addColorStop(1, colorFor(1))
    ctx.fillStyle = gradient
    ctx.fillRect(legendX, legendY, legendW, legendH)
    ctx.strokeStyle = dark ? '#555' : '#bbb'
    ctx.strokeRect(legendX, legendY, legendW, legendH)
    ctx.fillStyle = dark ? '#d9d9d9' : '#454545'
    ctx.font = '10px "Open Sans", "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(rawMax.toFixed(2), legendX - 5, legendY)
    ctx.fillText(((rawMin + rawMax) / 2).toFixed(2), legendX - 5, legendY + legendH / 2)
    ctx.fillText(rawMin.toFixed(2), legendX - 5, legendY + legendH)
    ctx.save()
    ctx.translate(legendX + 16, legendY + legendH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.fillText('Raw cosine', 0, 0)
    ctx.restore()
  }

  if (current) {
    const active = points.find((point) => point.id === current)
    if (active) {
      ctx.beginPath()
      ctx.strokeStyle = '#ff4500'
      ctx.lineWidth = 2
      ctx.arc(active.x, active.y, 11, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = dark ? '#ff9f1c' : '#ff4500'
      ctx.font = '12px "Open Sans", "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif'
      ctx.fillText(current, Math.min(active.x + 10, width - 140), Math.max(active.y - 10, 14))
    }
  }
}

function nearestPoint(event) {
  const rect = canvas.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height
  let best = null
  let bestDistance = 10
  for (const point of points) {
    const distance = Math.hypot(point.x - x, point.y - y)
    if (distance < bestDistance) {
      best = point
      bestDistance = distance
    }
  }
  return best
}

canvas.addEventListener('mousemove', (event) => {
  const point = nearestPoint(event)
  if (!point) {
    tooltip.classList.add('hidden')
    return
  }
  tooltip.textContent = viewMode === 'candidates'
    ? `${point.id} · candidate rank ${point.rank}`
    : viewMode === 'raw'
      ? `${point.id} · raw cosine ${point.raw.toFixed(3)}`
      : `${point.id} · ${(point.ratio * 100).toFixed(0)}% of max`
  tooltip.style.left = `${event.clientX + 12}px`
  tooltip.style.top = `${event.clientY + 12}px`
  tooltip.classList.remove('hidden')
})
canvas.addEventListener('mouseleave', () => tooltip.classList.add('hidden'))
canvas.addEventListener('click', async (event) => {
  const point = nearestPoint(event)
  if (!point) return
  try {
    status.textContent = `Opening ${point.id}…`
    await send({ type: 'play-id', id: point.id })
    setTimeout(() => loadProbabilities(targetInput.value), 700)
  } catch (caught) {
    error.textContent = caught.message
    error.classList.remove('hidden')
  }
})

targetInput.addEventListener('input', () => {
  targetValue.textContent = `${targetInput.value}%`
  clearTimeout(timer)
  timer = setTimeout(() => loadProbabilities(targetInput.value), 120)
})
function scheduleTuning() {
  historyValue.textContent = historyInput.value
  penaltyValue.textContent = Number(penaltyInput.value).toFixed(1)
  curveValue.textContent = Number(curveInput.value).toFixed(2)
  similarityValue.textContent = Number(similarityCurveInput.value).toFixed(2)
  forceValue.textContent = forceSkipInput.value
  updateCurvePlots()
  clearTimeout(timer)
  timer = setTimeout(() => loadProbabilities(targetInput.value), 120)
}

for (const input of [historyInput, penaltyInput, curveInput, similarityCurveInput, forceSkipInput]) {
  input.addEventListener('input', scheduleTuning)
  input.addEventListener('change', () => {
    send({ type: 'save-tuning', tuning: tuningValues() }).catch((caught) => {
      error.textContent = caught.message
      error.classList.remove('hidden')
    })
  })
}

targetInput.addEventListener('change', () => {
  send({ type: 'set-target', value: Number(targetInput.value) }).catch((caught) => {
    error.textContent = caught.message
    error.classList.remove('hidden')
  })
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'data-changed') {
    loadProbabilities(targetInput.value)
  }
})

modeButton.addEventListener('click', () => {
  viewMode = viewMode === 'likelihood' ? 'candidates' : viewMode === 'candidates' ? 'raw' : 'likelihood'
  modeButton.textContent = viewMode === 'likelihood'
    ? 'Show top 30 ranks'
    : viewMode === 'candidates'
      ? 'Show raw similarity'
      : 'Show likelihood map'
  rankLegend.classList.toggle('hidden', viewMode !== 'candidates')
  if (lastProbabilities) draw(lastProbabilities, lastMax, lastRaw)
})

reloadExtension.addEventListener('click', () => {
  chrome.runtime.reload()
})

document.getElementById('next').addEventListener('click', async () => {
  try {
    await send({ type: 'next', targetSimilarity: Number(targetInput.value), tuning: tuningValues() })
    status.textContent = 'Next track selected.'
    setTimeout(() => loadProbabilities(targetInput.value), 700)
  } catch (caught) {
    error.textContent = caught.message
    error.classList.remove('hidden')
  }
})

async function init() {
  try {
    const info = await send({ type: 'status' })
    if (info.protocol !== GRAPH_PROTOCOL) {
      throw new Error(
        'The extension service worker is running an older build. Open edge://extensions, click Reload, then reopen this page.',
      )
    }
    targetInput.value = String(info.targetSimilarity)
    targetValue.textContent = `${info.targetSimilarity}%`
    renderTuning(info.config)
    await loadProbabilities(targetInput.value)
  } catch (caught) {
    error.textContent = caught.message
    error.classList.remove('hidden')
  }
}

updateCurvePlots()
init()
