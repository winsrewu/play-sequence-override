import assert from 'node:assert/strict'
import test from 'node:test'

import { CommandError, parseCommand, tokenizeCommand } from '../src/lib/command-parse.js'

test('commands split into name, args and flags', () => {
  const parsed = parseCommand('import favorites 123456 --show-removed')
  assert.deepEqual(parsed, {
    name: 'import',
    args: ['favorites', '123456'],
    flags: { 'show-removed': true },
  })
  assert.deepEqual(parseCommand('merge --page=2'), {
    name: 'merge',
    args: [],
    flags: { page: '2' },
  })
})

test('quotes and escapes keep spaces and dashes', () => {
  assert.deepEqual(tokenizeCommand('remove "BBV1 -- weird" \'x y\''), ['remove', 'BBV1 -- weird', 'x y'])
  assert.deepEqual(tokenizeCommand('search a\\ b'), ['search', 'a b'])
})

test('flags after -- are arguments', () => {
  const parsed = parseCommand('remove -- --not-a-flag')
  assert.deepEqual(parsed.args, ['--not-a-flag'])
  assert.deepEqual(parsed.flags, {})
})

test('malformed lines are rejected', () => {
  assert.equal(parseCommand('   '), null)
  assert.throws(() => parseCommand('remove "open'), CommandError)
})
