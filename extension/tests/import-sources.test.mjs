import assert from 'node:assert/strict'
import test from 'node:test'

import { dedupeTracks, normalizeImportTarget, resolveImportTracks } from '../src/lib/import-sources.js'

test('targets are extracted from ids and URLs', () => {
  assert.deepEqual(normalizeImportTarget('video', 'BV1HB421674n'), { kind: 'video', bvid: 'BV1HB421674n' })
  assert.deepEqual(
    normalizeImportTarget('video', 'https://www.bilibili.com/festival/genshin2024?bvid=BV1HB421674n'),
    { kind: 'video', bvid: 'BV1HB421674n' },
  )
  assert.deepEqual(
    normalizeImportTarget('collection', 'https://space.bilibili.com/1/channel/collectiondetail?sid=456'),
    { kind: 'collection', id: '456' },
  )
  assert.deepEqual(normalizeImportTarget('favorites', 'https://space.bilibili.com/1/favlist?fid=789'), {
    kind: 'favorites',
    id: '789',
  })
  assert.throws(() => normalizeImportTarget('video', 'nope'), /BV id/)
  assert.throws(() => normalizeImportTarget('series', 'abc'), /numeric series id/)
  assert.throws(() => normalizeImportTarget('weird', '1'), /unknown source/)
})

test('duplicate ids collapse', () => {
  const tracks = [
    { id: 'A' },
    { id: 'A' },
    { id: 'B' },
  ]
  assert.deepEqual(dedupeTracks(tracks).map((track) => track.id), ['A', 'B'])
})

test('a single video resolves its pages', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: {
        bvid: 'BV1HB421674n',
        title: 'Song',
        pages: [{ part: 'Intro' }, { part: 'Outro' }],
      },
    }),
  })
  const tracks = await resolveImportTracks('video', 'BV1HB421674n', { fetchImpl })
  assert.deepEqual(tracks.map((track) => track.id), ['BBV1HB421674n', 'BBV1HB421674n_2'])
  assert.deepEqual(tracks.map((track) => track.title), ['Song · P1 Intro', 'Song · P2 Outro'])
})

test('bilibili errors surface', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ code: -404, message: '啥都木有' }) })
  await assert.rejects(resolveImportTracks('video', 'BV1HB421674n', { fetchImpl }), /啥都木有/)
})
