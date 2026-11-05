import assert from 'node:assert/strict'
import test from 'node:test'
import {
  forgetTab,
  isVideoPageUrl,
  isVideoTabUrl,
  ownerTab,
  ownerTabId,
  registerTab,
} from '../src/lib/sequence.js'

const VIDEO = 'https://www.bilibili.com/video/BV1xx411c7mD'

function detect(tabs, tabId, id, at) {
  return registerTab(tabs, { tabId, id, url: VIDEO, title: `tab ${tabId}`, at })
}

test('a lone detected tab owns the sequence', () => {
  const tabs = detect({}, 7, 'BV1', 1000)
  assert.equal(ownerTabId(tabs), 7)
  assert.equal(ownerTab(tabs).id, 'BV1')
})

test('the first detected tab keeps ownership when a second appears', () => {
  let tabs = detect({}, 7, 'BV1', 1000)
  tabs = detect(tabs, 9, 'BV2', 2000)
  assert.equal(ownerTabId(tabs), 7)
  assert.equal(ownerTab(tabs).id, 'BV1')
})

test('re-detection keeps the original detection time', () => {
  let tabs = detect({}, 7, 'BV1', 1000)
  tabs = detect(tabs, 7, 'BV3', 5000)
  tabs = detect(tabs, 9, 'BV2', 6000)
  assert.equal(tabs[7].detectedAt, 1000)
  assert.equal(tabs[7].id, 'BV3')
  assert.equal(ownerTabId(tabs), 7)
})

test('closing the owner elects the next surviving tab', () => {
  let tabs = detect({}, 7, 'BV1', 1000)
  tabs = detect(tabs, 9, 'BV2', 2000)
  tabs = detect(tabs, 4, 'BV3', 3000)
  tabs = forgetTab(tabs, 7)
  assert.equal(ownerTabId(tabs), 9)
  assert.equal(ownerTab(tabs).id, 'BV2')
  tabs = forgetTab(tabs, 9)
  assert.equal(ownerTabId(tabs), 4)
})

test('closing a non-owner leaves the owner in place', () => {
  let tabs = detect({}, 7, 'BV1', 1000)
  tabs = detect(tabs, 9, 'BV2', 2000)
  tabs = forgetTab(tabs, 9)
  assert.equal(ownerTabId(tabs), 7)
})

test('forgetting an unknown tab is a no-op', () => {
  const tabs = detect({}, 7, 'BV1', 1000)
  assert.equal(forgetTab(tabs, 99), tabs)
})

test('equal detection times break on the lower tab id', () => {
  let tabs = detect({}, 9, 'BV1', 1000)
  tabs = detect(tabs, 4, 'BV2', 1000)
  assert.equal(ownerTabId(tabs), 4)
})

test('an empty registry has no owner', () => {
  assert.equal(ownerTabId({}), null)
  assert.equal(ownerTab({}), null)
  assert.equal(ownerTabId(forgetTab(detect({}, 7, 'BV1', 1000), 7)), null)
})

test('only video page urls count as detected tabs', () => {
  assert.equal(isVideoTabUrl(VIDEO), true)
  assert.equal(isVideoTabUrl(`${VIDEO}?p=2`), true)
  assert.equal(isVideoTabUrl('https://www.bilibili.com/'), false)
  assert.equal(isVideoTabUrl('https://www.bilibili.com/video'), false)
  assert.equal(isVideoTabUrl('https://example.com/video/BV1'), false)
  assert.equal(isVideoTabUrl(null), false)
})

test('bvid query pages count as video tabs but not as soft-navigation pages', () => {
  const festival = 'https://www.bilibili.com/festival/genshin2024?bvid=BV1HB421674n'
  assert.equal(isVideoTabUrl(festival), true)
  assert.equal(isVideoPageUrl(festival), false)
  assert.equal(isVideoTabUrl(`${festival}&p=3`), true)
  assert.equal(isVideoTabUrl('https://www.bilibili.com/festival/genshin2024'), false)
  assert.equal(isVideoTabUrl('https://www.bilibili.com/blackboard/x?bvid=BV1HB421674n'), true)
  assert.equal(isVideoTabUrl('https://www.bilibili.com/blackboard/x?bvid=BV1'), false)
  assert.equal(isVideoTabUrl('https://evil.com/festival?bvid=BV1HB421674n'), false)
  assert.equal(isVideoPageUrl('https://www.bilibili.com/video/BV1HB421674n?p=2'), true)
  assert.equal(isVideoPageUrl('https://www.bilibili.com/video/BV1'), false)
})
