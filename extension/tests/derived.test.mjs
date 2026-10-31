import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DERIVED_VERSION,
  computeProjectionModel,
  computeStyleModel,
  projectPoint,
  shouldReuseDerived,
} from '../src/lib/derived.js'

const DIM = 4

function cluster(center, count, offset = 0) {
  const vectors = new Map()
  for (let index = 0; index < count; index += 1) {
    const vector = Float32Array.from(center, (value, i) => value + ((index + i) % 3) * 0.05)
    vectors.set(`B${String(offset + index).padStart(4, '0')}`, vector)
  }
  return vectors
}

function twoClusters() {
  return new Map([...cluster([1, 0, 0, 0], 8), ...cluster([0, 1, 0, 0], 8, 100)])
}

test('style clusters separate the two groups', () => {
  const model = computeStyleModel(twoClusters(), { clusters: 2 })
  assert.equal(model.clusters, 2)
  assert.equal(model.labels.length, 16)
  const first = new Set(model.labels.slice(0, 8))
  const second = new Set(model.labels.slice(8))
  assert.equal(first.size, 1)
  assert.equal(second.size, 1)
  assert.notEqual([...first][0], [...second][0])
  for (const centroid of model.centroids) {
    const norm = Math.hypot(...centroid)
    assert.ok(Math.abs(norm - 1) < 1e-6)
  }
})

test('style derivation is deterministic and sorts ids', () => {
  const model = computeStyleModel(twoClusters(), { clusters: 2 })
  const again = computeStyleModel(twoClusters(), { clusters: 2 })
  assert.deepEqual(model.labels, again.labels)
  assert.deepEqual(model.ids, [...model.ids].sort())
})

test('style derivation caps clusters and handles degenerate input', () => {
  const single = computeStyleModel(new Map([['B1', Float32Array.from([1, 0, 0, 0])]]))
  assert.equal(single.clusters, 1)
  assert.deepEqual(single.labels, [0])
  assert.equal(computeStyleModel(new Map()), null)
  const mixed = new Map(twoClusters())
  mixed.set('bad', Float32Array.from([1, 0]))
  assert.equal(computeStyleModel(mixed), null)
})

test('projection keeps unit orthogonal components and matches stored points', () => {
  const model = computeProjectionModel(twoClusters())
  const [first, second] = model.components
  assert.ok(Math.abs(Math.hypot(...first) - 1) < 1e-6)
  assert.ok(Math.abs(Math.hypot(...second) - 1) < 1e-6)
  let dot = 0
  for (let i = 0; i < DIM; i += 1) dot += first[i] * second[i]
  assert.ok(Math.abs(dot) < 1e-6)

  const id = model.ids[3]
  const raw = twoClusters().get(id)
  const norm = Math.hypot(...raw)
  const normalized = Array.from(raw, (value) => value / norm)
  const projected = projectPoint(model, normalized)
  assert.ok(Math.abs(projected.x - model.x[3]) < 1e-6)
  assert.ok(Math.abs(projected.y - model.y[3]) < 1e-6)
})

test('projection separates the two clusters on its first axis', () => {
  const model = computeProjectionModel(twoClusters())
  const spread = (values) => Math.max(...values) - Math.min(...values)
  const left = model.x.slice(0, 8)
  const right = model.x.slice(8)
  const between = Math.abs(left[0] - right[0])
  assert.ok(between > spread(left))
  assert.equal(computeProjectionModel(new Map()), null)
})

test('derived models are reused while vectors grow and rebuilt after a reset', () => {
  const record = { version: DERIVED_VERSION, dim: 960, count: 100 }
  assert.equal(shouldReuseDerived(record, 100, 960), true)
  assert.equal(shouldReuseDerived(record, 199, 960), true)
  assert.equal(shouldReuseDerived(record, 200, 960), false)
  assert.equal(shouldReuseDerived(record, 99, 960), false)
  assert.equal(shouldReuseDerived(record, 100, 900), false)
  assert.equal(shouldReuseDerived({ ...record, version: 999 }, 100, 960), false)
  assert.equal(shouldReuseDerived(null, 100, 960), false)
  assert.equal(shouldReuseDerived({ version: DERIVED_VERSION, dim: 960, count: 0 }, 7, 960), true)
  assert.equal(shouldReuseDerived({ version: DERIVED_VERSION, dim: 960, count: 0 }, 8, 960), false)
})
