import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAuthorizeUrl,
  consentCovers,
  DEFAULT_CONFIG,
  normalizeConfig,
  remoteOrigins,
} from '../src/lib/config.js'

test('defaults are normalized', () => {
  const config = normalizeConfig(DEFAULT_CONFIG)
  assert.equal(config.embedApiUrl, 'https://embed.jawbts.org/v1/embed')
  assert.equal(config.gatewayAuthorizeUrl, 'https://gateway.jawbts.org/authorize')
  assert.equal(config.scope, 'play_sequence_override')
  assert.equal(config.targetSimilarity, 75)
  assert.equal(config.historyLength, 400)
  assert.equal(config.penaltyStrength, 3)
  assert.equal(config.curve, 0.5)
  assert.equal(config.similarityCurve, 0.5)
  assert.equal(config.forceSkip, 1767)
  assert.equal(config.lyricsShare, 50)
  assert.equal(config.lyricsEnabled, true)
})

test('the lyrics mix switch defaults on and can be turned off', () => {
  assert.equal(normalizeConfig({ lyricsEnabled: false }).lyricsEnabled, false)
  assert.equal(normalizeConfig({}).lyricsEnabled, true)
})

test('lyrics share is clamped and reaches both pure modes', () => {
  assert.equal(normalizeConfig({ lyricsShare: 40 }).lyricsShare, 40)
  assert.equal(normalizeConfig({ lyricsShare: 120 }).lyricsShare, 100)
  assert.equal(normalizeConfig({ lyricsShare: -5 }).lyricsShare, 0)
})

test('the old instrumental-ratio setting migrates to a share', () => {
  assert.equal(normalizeConfig({ lyricsRatio: 0 }).lyricsShare, 100)
  assert.equal(normalizeConfig({ lyricsRatio: 1 }).lyricsShare, 50)
  assert.equal(normalizeConfig({ lyricsRatio: 1.5 }).lyricsShare, 40)
  assert.equal(normalizeConfig({ lyricsRatio: 4 }).lyricsShare, 20)
})

test('trailing slashes are removed and authorize path is appended once', () => {
  const config = normalizeConfig({
    gatewayAuthorizeUrl: 'https://example.com/authorize/',
    apiBaseUrl: 'https://api.example.com/',
    embedApiUrl: 'https://embed.example.com/v1/embed/',
  })
  assert.equal(config.apiBaseUrl, 'https://api.example.com')
  assert.equal(config.gatewayAuthorizeUrl, 'https://example.com/authorize')
  assert.equal(config.embedApiUrl, 'https://embed.example.com/v1/embed')
})

test('http is rejected except localhost', () => {
  assert.throws(() => normalizeConfig({ apiBaseUrl: 'http://example.com' }), /HTTPS/)
  const local = normalizeConfig({ apiBaseUrl: 'http://localhost:8000' })
  assert.equal(local.apiBaseUrl, 'http://localhost:8000')
})

test('authorize URL carries the OAuth parameters', () => {
  const url = new URL(buildAuthorizeUrl(normalizeConfig(DEFAULT_CONFIG), 'https://abc.chromiumapp.org/oauth', 'state-1'))
  assert.equal(url.searchParams.get('scope'), 'play_sequence_override')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://abc.chromiumapp.org/oauth')
  assert.equal(url.searchParams.get('state'), 'state-1')
  assert.equal(url.searchParams.get('response_mode'), 'fragment')
  assert.equal(url.searchParams.get('app_name'), 'Play Sequence Override')
})

test('invalid target is rejected', () => {
  assert.throws(() => normalizeConfig({ targetSimilarity: 101 }), /between 0 and 100/)
})

test('tuning values are range-checked', () => {
  assert.throws(() => normalizeConfig({ historyLength: 401 }), /historyLength/)
  assert.throws(() => normalizeConfig({ penaltyStrength: 21 }), /penaltyStrength/)
  assert.throws(() => normalizeConfig({ curve: 0.1 }), /curve/)
  assert.throws(() => normalizeConfig({ similarityCurve: 9 }), /similarityCurve/)
  assert.throws(() => normalizeConfig({ forceSkip: 1768 }), /forceSkip/)
})

test('dev mode requires a localhost embedding URL', () => {
  const local = normalizeConfig({
    devMode: true,
    embedApiUrl: 'http://localhost:8000/v1/embed',
  })
  assert.equal(local.devMode, true)
  assert.throws(
    () => normalizeConfig({ devMode: true, embedApiUrl: 'https://embed.jawbts.org/v1/embed' }),
    /localhost/,
  )
})

test('remote origins skip localhost and deduplicate', () => {
  const config = normalizeConfig(DEFAULT_CONFIG)
  assert.deepEqual(remoteOrigins(config), [
    'https://api.jawbts.org',
    'https://gateway.jawbts.org',
    'https://embed.jawbts.org',
  ])
  const local = normalizeConfig({
    apiBaseUrl: 'http://localhost:8000',
    gatewayAuthorizeUrl: 'http://127.0.0.1:9000/authorize',
    embedApiUrl: 'http://localhost:8000/v1/embed',
  })
  assert.deepEqual(remoteOrigins(local), [])
})

test('consent covers exactly the granted origins', () => {
  const config = normalizeConfig(DEFAULT_CONFIG)
  const origins = remoteOrigins(config)
  assert.equal(consentCovers({ granted: true, origins }, origins), true)
  assert.equal(consentCovers({ granted: true, origins: origins.slice(0, 2) }, origins), false)
  assert.equal(consentCovers({ granted: false, origins }, origins), false)
  assert.equal(consentCovers(null, origins), false)
  assert.equal(consentCovers({ granted: true, origins }, []), true)
})
