// Console line grammar: `name [subcommand] [args...] [--flag[=value]]`.
export class CommandError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CommandError'
  }
}

export function tokenizeCommand(line) {
  const tokens = []
  let current = ''
  let quote = null
  let started = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === '\\' && index + 1 < line.length) {
        current += line[index + 1]
        index += 1
        started = true
        continue
      }
      if (char === quote) {
        quote = null
        continue
      }
      current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    if (char === '\\' && index + 1 < line.length) {
      current += line[index + 1]
      index += 1
      started = true
      continue
    }
    current += char
    started = true
  }
  if (quote) throw new CommandError('unterminated quote')
  if (started) tokens.push(current)
  return tokens
}

export function parseCommand(line) {
  const tokens = tokenizeCommand(String(line ?? ''))
  if (tokens.length === 0) return null
  const name = tokens[0].toLowerCase()
  const args = []
  const flags = {}
  let afterFlags = false
  for (const token of tokens.slice(1)) {
    if (afterFlags) {
      args.push(token)
      continue
    }
    if (token === '--') {
      afterFlags = true
      continue
    }
    if (token.startsWith('--') && token.length > 2) {
      const equals = token.indexOf('=')
      const key = equals === -1 ? token.slice(2) : token.slice(2, equals)
      flags[key] = equals === -1 ? true : token.slice(equals + 1)
      continue
    }
    args.push(token)
  }
  return { name, args, flags }
}
