import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

test('extension pages load no remote scripts, styles or fonts', () => {
  for (const file of readdirSync(path.join(root, 'src')).filter((name) => name.endsWith('.html'))) {
    const html = readFileSync(path.join(root, 'src', file), 'utf8')
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i, `${file} loads a remote script`)
    assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i, `${file} loads a remote stylesheet/font`)
    assert.doesNotMatch(html, /@import\s+url\(["']?https?:/i, `${file} imports remote CSS`)
  }
})

test('extension CSP only allows packaged scripts', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(
    manifest.content_security_policy?.extension_pages,
    "script-src 'self'; object-src 'self';",
  )
})
