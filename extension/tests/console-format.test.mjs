import assert from 'node:assert/strict'
import test from 'node:test'

import { multiPageVideos, trackText } from '../src/lib/console-format.js'

const P1 = { id: 'BBV1Pt411Y717', video_id: 'BV1Pt411Y717', page: 1, title: '博士角色歌PV' }
const P2 = { id: 'BBV1Pt411Y717_2', video_id: 'BV1Pt411Y717', page: 2, title: '第二曲' }

test('single-part tracks stay unlabelled', () => {
  assert.equal(trackText(P1), 'BBV1Pt411Y717  博士角色歌PV')
})

test('the first part of a multi-part video gets its P label', () => {
  assert.equal(trackText(P1, { multi: true }), 'BBV1Pt411Y717  博士角色歌PV · P1')
  assert.equal(trackText(P2), 'BBV1Pt411Y717_2  第二曲 · P2')
})

test('titles that already carry the P name are not duplicated', () => {
  const named = { ...P1, title: 'Song · P1 Intro' }
  assert.equal(trackText(named, { multi: true }), 'BBV1Pt411Y717  Song · P1 Intro')
})

test('a P1-looking title that is not ours is still labelled', () => {
  const natural = { ...P1, title: 'P1 is not a label here' }
  assert.equal(trackText(natural, { multi: true }), 'BBV1Pt411Y717  P1 is not a label here · P1')
})

test('multiPageVideos groups by video, not by id suffix', () => {
  const single = { id: 'BBV1', video_id: 'BV1', page: 1 }
  const other = { id: 'BBV2', video_id: 'BV2', page: 1 }
  assert.deepEqual([...multiPageVideos([P1, P2, other])], ['BV1Pt411Y717'])
  assert.deepEqual([...multiPageVideos([P1, other])], [])
})
