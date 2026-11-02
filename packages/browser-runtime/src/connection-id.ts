// Connection ids arrive over RPC and become a profile directory name, an Xvfb
// key and the egress-proxy username. Every entry point checks them against one
// whitelist so `../x`, `a/b` or an empty string never reach a path join.
//
// The server mints ids as randomBytes(8).toString('hex') (apps/server admin
// routes); this pattern covers that and leaves room for UUIDs and slugs.

export const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export class InvalidConnectionIdError extends Error {
  constructor() {
    // Never echo the value: it is attacker-controlled and may be long.
    super('connection_id must match /^[A-Za-z0-9_-]{1,64}$/')
    this.name = 'InvalidConnectionIdError'
  }
}

export function isValidConnectionId(value: unknown): value is string {
  return typeof value === 'string' && CONNECTION_ID_RE.test(value)
}

export function assertConnectionId(value: unknown): asserts value is string {
  if (!isValidConnectionId(value)) throw new InvalidConnectionIdError()
}
