// Bilibili watcher. Site auto-next is disabled; real ends enter the sequence and soft navigation uses RELOAD_VIDEO.
(() => {
  const SCRIPT_VERSION = 5
  if (Number(window.__jawbtsPlaySequenceVersion) >= SCRIPT_VERSION) return
  window.__jawbtsPlaySequenceVersion = SCRIPT_VERSION
  window.__jawbtsPlaySequenceLoaded = true

  const VIDEO_RE = /^\/video\/(BV[0-9A-Za-z]{10})/
  let lastReported = null
  let navigationTimer = null
  let lastEndedKey = null
  let endedCheckTimer = null

  const MAIN_PLAYER_SELECTORS = [
    '#bilibili-player',
    '.bpx-player-container',
    '.bpx-player-video-wrap',
    '.bilibili-player-video',
    '.bilibili-player',
  ].join(',')

  function parseId(url = location.href) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    const match = VIDEO_RE.exec(parsed.pathname)
    // Festival and other player pages put the bvid in the query string.
    const bvid = match ? match[1] : parsed.searchParams.get('bvid') || ''
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null
    const page = Math.max(1, Number(parsed.searchParams.get('p') || '1') || 1)
    return {
      id: `B${bvid}${page > 1 ? `_${page}` : ''}`,
      bvid,
      page,
      path: Boolean(match),
      url: parsed.toString(),
    }
  }

  function report(force = false) {
    const current = parseId()
    if (!current) return
    // A query-string bvid only counts once the page actually hosts a player.
    if (!current.path && !document.querySelector('video')) return
    if (!force && current.id === lastReported) return
    lastReported = current.id
    try {
      chrome.runtime
        .sendMessage({
          type: 'track-started',
          id: current.id,
          url: current.url,
          title: document.title,
          page: current.page,
        })
        .catch(() => {})
    } catch {
    }
  }

  function visibleVideo(video) {
    if (!video || video.tagName !== 'VIDEO' || !video.isConnected) return false
    const rect = video.getBoundingClientRect()
    return rect.width >= 240 && rect.height >= 120
  }

  function isMainVideo(video) {
    if (!video || video.tagName !== 'VIDEO' || !video.isConnected) return false
    if (video.closest(MAIN_PLAYER_SELECTORS)) return true
    if (!visibleVideo(video)) return false
    let largest = null
    let largestArea = 0
    for (const candidate of document.querySelectorAll('video')) {
      if (!visibleVideo(candidate)) continue
      const rect = candidate.getBoundingClientRect()
      const area = rect.width * rect.height
      if (area > largestArea) {
        largestArea = area
        largest = candidate
      }
    }
    return largest === video
  }

  function ensurePlaying() {
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      const video = [...document.querySelectorAll('video')].find(isMainVideo)
      if (video && !video.paused) {
        clearInterval(timer)
        return
      }
      if (video && video.readyState >= 2 && video.paused && video.ended === false) {
        video.play().then(() => clearInterval(timer)).catch(() => {
        })
      }
      if (attempts >= 24) clearInterval(timer)
    }, 250)
  }

  function hardNavigate(url) {
    try {
      sessionStorage.setItem('jawbts-autoplay', '1')
    } catch {
    }
    if (location.href === url) location.reload()
    else location.assign(url)
  }

  function navigateTo(url, soft) {
    const target = parseId(url)
    if (!target) {
      hardNavigate(url)
      return
    }
    if (target.id === parseId()?.id) return

    // Soft navigation only works on the video page's own SPA route.
    if (!soft || !VIDEO_RE.test(location.pathname)) {
      hardNavigate(target.url)
      return
    }

    const beforeTitle = document.title
    const beforeVideo = [...document.querySelectorAll('video')].find(isMainVideo)
    const beforeSrc = beforeVideo?.currentSrc || ''
    try {
      history.pushState({ ...(history.state || {}), jawbts: true }, '', target.url)
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
    } catch {
      hardNavigate(target.url)
      return
    }

    if (navigationTimer) clearTimeout(navigationTimer)
    navigationTimer = setTimeout(() => {
      const currentVideo = [...document.querySelectorAll('video')].find(isMainVideo)
      const mediaChanged = Boolean(beforeSrc) && currentVideo?.currentSrc !== beforeSrc
      const titleChanged = document.title !== beforeTitle
      if (parseId()?.id === target.id && (titleChanged || mediaChanged)) {
        lastReported = null
        report(true)
        ensurePlaying()
        try {
          chrome.runtime.sendMessage({ type: 'soft-nav-finished' }).catch(() => {})
        } catch {
        }
        return
      }
      hardNavigate(target.url)
    }, 5000)
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'navigate') {
      navigateTo(message.url, Boolean(message.soft))
      sendResponse({ ok: true })
      return false
    }
    if (message?.type === 'page') {
      sendResponse({ ok: true, current: parseId() })
      return false
    }
    return false
  })

  document.addEventListener(
    'playing',
    (event) => {
      if (event.target?.tagName === 'VIDEO') lastEndedKey = null
    },
    true,
  )

  function singleLoopEnabled(video) {
    if (video?.loop) return true
    try {
      const profile = JSON.parse(localStorage.getItem('bpx_player_profile') || '{}')
      return Boolean(profile?.media?.loop)
    } catch {
      return false
    }
  }

  function sendEnd(id, url, duration, position, loopOverride = false) {
    try {
      chrome.runtime
        .sendMessage({
          type: 'track-ended',
          id,
          url,
          duration,
          position,
          ended: true,
          loopOverride,
        })
        .catch(() => {})
    } catch {
    }
  }

  // Accept main clips >=2s; single loop is overridden without changing Bilibili's setting.
  function scheduleEnd(video, allowPausedEnd = false) {
    if (!isMainVideo(video)) return
    const current = parseId()
    if (!current) return
    const duration = Number(video.duration)
    const position = Number(video.currentTime)
    if (!Number.isFinite(duration) || duration < 2) return
    const endedEvent = Boolean(video.ended)
    const looping = singleLoopEnabled(video)
    const nearEnd = Number.isFinite(position) && position >= duration - 0.5
    if (!endedEvent && (!Number.isFinite(position) || position < duration - 2)) return
    const stoppedAtEnd =
      endedEvent ||
      (allowPausedEnd && Number.isFinite(position) && position >= duration - 0.35) ||
      (looping && nearEnd)
    if (!stoppedAtEnd) return
    const key = `${current.id}|${video.currentSrc}|${Math.round(duration)}`
    if (lastEndedKey === key) return
    lastEndedKey = key
    const endedId = current.id
    const endedUrl = current.url
    if (endedCheckTimer) clearTimeout(endedCheckTimer)
    endedCheckTimer = setTimeout(() => {
      const sameUrl = parseId()?.id === endedId
      const looping = singleLoopEnabled(video)
      let finalDuration = duration
      let finalPosition = position
      let finalEnded = Boolean(video.ended)
      if (sameUrl && looping && nearEnd) {
        sendEnd(endedId, endedUrl, duration, duration, true)
        return
      }
      if (sameUrl) {
        if (!video.isConnected) return
        finalDuration = Number(video.duration)
        finalPosition = Number(video.currentTime)
        finalEnded = Boolean(video.ended)
        if (!Number.isFinite(finalDuration) || finalDuration < 10) return
        if (!finalEnded && (!Number.isFinite(finalPosition) || finalPosition < finalDuration - 2)) return
        const stillStopped =
          finalEnded ||
          (video.paused && Number.isFinite(finalPosition) && finalPosition >= finalDuration - 0.35)
        if (!stillStopped) {
          lastEndedKey = null
          return
        }
      }
      sendEnd(endedId, endedUrl, finalDuration, finalPosition, false)
    }, 250)
  }

  document.addEventListener(
    'ended',
    (event) => scheduleEnd(event.target),
    true,
  )
  document.addEventListener(
    'pause',
    (event) => {
      if (event.target?.tagName === 'VIDEO' && event.target.ended) {
        scheduleEnd(event.target)
      }
    },
    true,
  )
  document.addEventListener(
    'timeupdate',
    (event) => {
      if (event.target?.tagName === 'VIDEO') {
        scheduleEnd(event.target, true)
      }
    },
    true,
  )

  function checkMainEnd() {
    const video = [...document.querySelectorAll('video')].find(isMainVideo)
    if (video) scheduleEnd(video, true)
  }

  window.addEventListener('popstate', () => report())
  window.addEventListener('hashchange', () => report())
  setInterval(() => {
    report()
    checkMainEnd()
  }, 1000)

  try {
    if (sessionStorage.getItem('jawbts-autoplay') === '1') {
      sessionStorage.removeItem('jawbts-autoplay')
      ensurePlaying()
    }
  } catch {
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => report(true), { once: true })
  } else {
    report(true)
  }
})()
