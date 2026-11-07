import type { QueryClient } from '@tanstack/react-query'

/** A connection change affects both its detail and the overview summary. */
export function invalidateConnectionStatus(client: QueryClient): Promise<unknown[]> {
  return Promise.all([
    client.invalidateQueries({ queryKey: ['connections'] }),
    client.invalidateQueries({ queryKey: ['overview'] }),
  ])
}
