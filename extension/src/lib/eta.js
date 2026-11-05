// Seconds remaining from the observed rate since the run started.
export function estimateEta(processed, remaining, startedAt, now = Date.now()) {
  const count = Number(processed) || 0
  const left = Number(remaining) || 0
  const started = Number(startedAt) || 0
  if (count <= 0 || left <= 0 || started <= 0) return null
  const elapsed = (now - started) / 1000
  if (!(elapsed > 0)) return null
  return Math.max(1, Math.ceil((left / count) * elapsed))
}
