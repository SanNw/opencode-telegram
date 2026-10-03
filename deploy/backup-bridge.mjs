import { chmod, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../apps/bridge/package.json', import.meta.url))
const Database = require('better-sqlite3')

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
process.loadEnvFile(resolve(root, '.env'))
const source = resolve(root, process.env.BRIDGE_DATABASE_PATH ?? './data/bridge.sqlite')
const destination = resolve(root, process.argv[2] ?? `./data/backups/bridge-${new Date().toISOString().replaceAll(':', '-')}.sqlite`)
if (source === destination) throw new Error('Backup must not replace the live database')
await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
// Reserve a unique destination; never silently replace an older backup.
const { open } = await import('node:fs/promises')
const reservation = await open(destination, 'wx', 0o600)
await reservation.close()
const database = new Database(source, { readonly: true, fileMustExist: true })
try {
  await database.backup(destination)
  await chmod(destination, 0o600)
  const backup = new Database(destination, { readonly: true, fileMustExist: true })
  try {
    if (backup.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup integrity check failed')
    console.log(JSON.stringify({ backup: destination, integrity: 'ok' }))
  } finally { backup.close() }
} finally { database.close() }
