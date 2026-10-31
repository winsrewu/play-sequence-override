import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

import {
  buildInternalId,
  exportV2,
  parseAnyPlaylist,
  parseInternalId,
  parseLegacyPlaylist,
  parsePlaylist,
  playlistSummary,
  PlaylistError,
} from '../src/lib/playlist.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const catalogPath = path.join(root, 'server', 'data', 'music.v2.json')
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))

test('internal ids parse and build canonically', () => {
  assert.deepEqual(parseInternalId('BBV16y4y127Dz'), {
    provider: 'bilibili',
    videoId: 'BV16y4y127Dz',
    page: 1,
    value: 'BBV16y4y127Dz',
    id: 'BBV16y4y127Dz',
  })
  assert.equal(parseInternalId('BBV1Xx4y1277K_2').page, 2)
  assert.equal(buildInternalId('bilibili', 'BV16y4y127Dz', 3), 'BBV16y4y127Dz_3')
})

test('invalid internal ids are rejected', () => {
  for (const value of ['', 'BV16y4y127Dz', 'BBCV16y4y127Dz', 'BBV16y4y127D', 'BBV16y4y127Dz_0', 'CBV16y4y127Dz']) {
    assert.throws(() => parseInternalId(value), PlaylistError, value)
  }
})

test('the real v2 catalog parses', () => {
  const playlist = parsePlaylist(catalog)
  assert.equal(playlist.tracks.length, 2072)
  assert.equal(playlist.tracks[0].id, 'BBV16y4y127Dz')
  assert.equal(playlist.tracks[0].title, catalog.tracks[0].title)
  assert.equal(playlistSummary(playlist).multiPage, 302)
  assert.equal(playlist.tracks[0].author, undefined)
  assert.equal(playlist.tracks[0].tags, undefined)
  assert.equal(playlist.tracks[0].static_tags, undefined)
})

test('v2 export has the stable header and track fields', () => {
  const playlist = parsePlaylist(catalog)
  const document = exportV2(playlist, '2026-10-29T00:00:00Z')
  assert.equal(document.format, 'jawbts.music-playlist')
  assert.equal(document.version, 2)
  assert.equal(document.generated_at, '2026-10-29T00:00:00Z')
  assert.equal(document.tracks.length, 2072)
  assert.deepEqual(Object.keys(document.tracks[0]), [
    'id',
    'provider',
    'video_id',
    'page',
    'title',
  ])
  assert.deepEqual(exportV2(parsePlaylist(document), '2026-10-29T00:00:00Z'), document)
})

test('legacy shape is rejected, not silently accepted', () => {
  assert.throws(() => parsePlaylist({ async_time: 1, data: [] }), /unexpected playlist field/)
  assert.throws(() => parsePlaylist([{ inner_id: 'BBV16y4y127Dz' }]), /root must be a JSON object/)
})

test('duplicates and conflicting metadata are rejected', () => {
  const entry = catalog.tracks[0]
  assert.throws(() => parsePlaylist({ ...catalog, tracks: [entry, entry] }), /duplicate/)
  assert.throws(
    () => parsePlaylist({ ...catalog, tracks: [{ ...entry, video_id: 'BV1AA411p7zs' }] }),
    /conflicts/,
  )
})

test('unknown fields are rejected', () => {
  const entry = catalog.tracks[0]
  assert.throws(
    () => parsePlaylist({ ...catalog, tracks: [{ ...entry, author: 'x' }] }),
    /unexpected track field/,
  )
  assert.throws(
    () => parsePlaylist({ ...catalog, extra: true }),
    /unexpected playlist field/,
  )
})

test('unsupported formats are rejected', () => {
  assert.throws(() => parsePlaylist({ format: 'other', version: 2, tracks: [] }), /unsupported playlist format/)
  assert.throws(() => parsePlaylist({ format: 'jawbts.music-playlist', version: 3, tracks: [] }), /unsupported playlist version/)
})

test('legacy music.json converts and drops its extra metadata', () => {
  const legacy = {
    async_time: 123,
    data: [
      {
        inner_id: 'BBV16y4y127Dz',
        title: 'one',
        likes: 4,
        author: 'someone',
        tags: ['tag'],
        static_tags: ['static'],
        unknown: true,
      },
      { inner_id: 'BBV1Xx4y1277K_2', title: 'two' },
    ],
  }
  const playlist = parseLegacyPlaylist(legacy)
  assert.equal(playlist.format, 'jawbts.music-playlist')
  assert.equal(playlist.version, 2)
  assert.deepEqual(playlist.tracks, [
    { id: 'BBV16y4y127Dz', provider: 'bilibili', videoId: 'BV16y4y127Dz', video_id: 'BV16y4y127Dz', page: 1, title: 'one' },
    { id: 'BBV1Xx4y1277K_2', provider: 'bilibili', videoId: 'BV1Xx4y1277K', video_id: 'BV1Xx4y1277K', page: 2, title: 'two' },
  ])
})

test('legacy music.json rejects malformed entries', () => {
  assert.throws(() => parseLegacyPlaylist([]), /root must be a JSON object/)
  assert.throws(() => parseLegacyPlaylist({}), /must contain a "data" array/)
  assert.throws(() => parseLegacyPlaylist({ data: [null] }), /data\[0\] is not an object/)
  assert.throws(() => parseLegacyPlaylist({ data: [{}] }), /data\[0\] is missing inner_id/)
  assert.throws(() => parseLegacyPlaylist({ data: [{ inner_id: 'nope' }] }), /data\[0\]/)
  assert.throws(
    () =>
      parseLegacyPlaylist({
        data: [{ inner_id: 'BBV16y4y127Dz' }, { inner_id: 'BBV16y4y127Dz' }],
      }),
    /duplicate/,
  )
})

test('parseAnyPlaylist accepts v2 and legacy, rejects anything else', () => {
  assert.equal(parseAnyPlaylist(catalog).tracks.length, catalog.tracks.length)
  assert.equal(parseAnyPlaylist({ data: [{ inner_id: 'BBV16y4y127Dz' }] }).tracks.length, 1)
  assert.throws(() => parseAnyPlaylist({ hello: 'world' }), /expected a v2 playlist/)
  assert.throws(() => parseAnyPlaylist('nope'), /expected a v2 playlist/)
})

test('parsePlaylist stays strict about legacy files', () => {
  assert.throws(() => parsePlaylist({ data: [{ inner_id: 'BBV16y4y127Dz' }] }), /unexpected playlist field/)
})
