import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

import { dataDir } from './data-dir.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const model = JSON.parse(readFileSync(path.join(dataDir, 'projection.json'), 'utf8'))
const index = JSON.parse(readFileSync(path.join(dataDir, 'embeddings-index.json'), 'utf8'))
const buffer = readFileSync(path.join(dataDir, 'embeddings.bin'))
const data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)

function normalize(vector) {
  const copy = new Float32Array(vector)
  let norm = 0
  for (const value of copy) norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 1e-12) for (let i = 0; i < copy.length; i += 1) copy[i] /= norm
  return copy
}

const training = index.ids.map((_id, i) => normalize(data.subarray(i * 960, (i + 1) * 960)))

function dot(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

function project(vector) {
  const k = new Float64Array(training.length)
  let total = 0
  for (let i = 0; i < training.length; i += 1) {
    k[i] = dot(vector, training[i])
    total += k[i]
  }
  const mean = total / training.length
  let x = 0
  let y = 0
  for (let i = 0; i < training.length; i += 1) {
    const centered = k[i] - model.k_fit_rows[i] - mean + model.k_fit_all
    x += centered * model.scaled_alphas[i][0]
    y += centered * model.scaled_alphas[i][1]
  }
  return { x, y }
}

test('projection model reproduces the fitted coordinates', () => {
  let worst = 0
  for (let i = 0; i < 20; i += 1) {
    const point = project(training[i])
    worst = Math.max(worst, Math.abs(point.x - model.x[i]), Math.abs(point.y - model.y[i]))
  }
  assert.ok(worst < 1e-5, `max coordinate error ${worst}`)
})

test('out-of-sample projection is finite and consistent', () => {
  const vector = new Float32Array(960)
  for (let i = 0; i < 960; i += 1) {
    vector[i] = training[0][i] * 0.9 + training[1][i] * 0.1
  }
  const point = project(normalize(vector))
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
  assert.ok(Math.abs(point.x) < 10 && Math.abs(point.y) < 10)
})
