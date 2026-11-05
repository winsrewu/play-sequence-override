import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateEta } from '../src/lib/eta.js'

const START = 1_000_000

test('projects from the processed rate', () => {
  assert.equal(estimateEta(10, 90, START, START + 50_000), 450)
  assert.equal(estimateEta(1, 1, START, START + 1_000), 1)
})

test('cannot estimate without progress, remaining work or a start', () => {
  assert.equal(estimateEta(0, 100, START, START + 10_000), null)
  assert.equal(estimateEta(10, 0, START, START + 10_000), null)
  assert.equal(estimateEta(10, 90, 0, START), null)
  assert.equal(estimateEta(10, 90, START, START), null)
  assert.equal(estimateEta(10, 90, START, START - 1), null)
})
