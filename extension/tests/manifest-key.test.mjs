import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(path.join(here, '..', 'manifest.json'), 'utf8'))

test('the manifest key keeps the store id', () => {
  assert.equal(typeof manifest.key, 'string')
  const der = Buffer.from(manifest.key, 'base64')
  const digest = createHash('sha256').update(der).digest().subarray(0, 16)
  let id = ''
  for (const byte of digest) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  assert.equal(id, 'oacjdflkiecoclphcfdopfoingkhbomm')
})
