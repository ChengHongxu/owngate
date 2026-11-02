// Secret lookup: NAME for local development, NAME_FILE for a mounted Docker
// secret (/run/secrets/...). Empty values count as unset, so a blank line in
// .env cannot silently become an empty HMAC key.

import { readFileSync } from 'node:fs'

export function readSecret(name: string): string | undefined {
  const direct = process.env[name]
  if (direct !== undefined && direct !== '') return direct
  const file = process.env[`${name}_FILE`]
  if (file === undefined || file === '') return undefined
  // A configured but unreadable file is a deployment error: let it throw.
  const value = readFileSync(file, 'utf8').trim()
  return value === '' ? undefined : value
}
