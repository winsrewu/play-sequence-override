import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const local = path.resolve(here, '..', 'data')
const built = path.resolve(here, '..', '..', 'build', 'extension', 'data')

export const dataDir = existsSync(path.join(local, 'music.v2.json')) ? local : built
