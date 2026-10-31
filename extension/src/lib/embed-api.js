// Embedding calls are serialised so a prefetch does not run concurrent CPU inferences.
import { getAccessToken, refreshSession } from './auth.js'
import { getConfig } from './storage.js'

const EMBED_TIMEOUT_MS = 180_000

export class EmbedApiError extends Error {
  constructor(code, message, status = 0) {
    super(message || 'Embedding request failed')
    this.name = 'EmbedApiError'
    this.code = code
    this.status = status
  }
}

let queue = Promise.resolve()

function enqueue(operation) {
  const run = queue.then(operation, operation)
  queue = run.catch(() => {})
  return run
}

async function requestEmbedding(internalId, token) {
  const config = await getConfig()
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  let response
  try {
    response = await fetch(config.embedApiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ internal_id: internalId }),
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new EmbedApiError('timeout', 'The embedding service did not respond in time.')
    }
    throw new EmbedApiError('network', 'Could not reach the embedding service.')
  }

  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (response.status === 401) {
    throw new EmbedApiError('token_expired', 'The access token was rejected.', 401)
  }
  if (!response.ok || !body) {
    const message = body?.error?.message || `Embedding service returned HTTP ${response.status}.`
    const code = body?.error?.code || 'http_error'
    throw new EmbedApiError(code, message, response.status)
  }
  if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
    throw new EmbedApiError('invalid_response', 'The embedding service returned no vector.')
  }
  const vector = Float32Array.from(body.embedding)
  if (Number(body.dim) && Number(body.dim) !== vector.length) {
    throw new EmbedApiError('invalid_response', 'The embedding dimension does not match.')
  }
  return { vector, dim: vector.length, model: body.model || null, internalId: body.internal_id }
}

export function embedTrack(internalId) {
  return enqueue(async () => {
    const config = await getConfig()
    if (config.devMode) {
      return requestEmbedding(internalId, null)
    }
    let token = await getAccessToken()
    try {
      return await requestEmbedding(internalId, token)
    } catch (error) {
      if (!(error instanceof EmbedApiError) || error.status !== 401) throw error
      await refreshSession()
      token = await getAccessToken()
      return requestEmbedding(internalId, token)
    }
  })
}
