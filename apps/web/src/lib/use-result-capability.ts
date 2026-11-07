import { useQuery } from '@tanstack/react-query'
import { api, type Capability, type Envelope } from './api'

export type ResultCapability = Pick<Capability, 'id' | 'output' | 'presentation'>

/** Presentation metadata comes from the capability catalogue. Fetching it
 * never invokes a platform capability, and a catalogue failure cannot hide an
 * already-authorized result. Known detail/query views pass their metadata. */
export function useResultCapability(envelope: Envelope, provided?: ResultCapability, showData = true): ResultCapability | undefined {
  const known = provided?.id === envelope.source.capability_id ? provided : undefined
  const enabled = showData && !known && envelope.outcome !== 'error' && envelope.data !== null && envelope.data !== undefined
  const connections = useQuery({
    queryKey: ['connections'], queryFn: api.listConnections, enabled,
    staleTime: 30_000, refetchOnWindowFocus: false,
  })
  const connection = connections.data?.connections.find(entry => entry.id === envelope.source.connection_id)
  const capabilities = useQuery({
    queryKey: ['capabilities', connection?.connector_id, connection?.id, connection?.config],
    queryFn: () => api.listCapabilities(connection!.connector_id, connection!.id),
    enabled: enabled && Boolean(connection), staleTime: 30_000, refetchOnWindowFocus: false,
  })
  return known ?? capabilities.data?.capabilities.find(entry => entry.id === envelope.source.capability_id)
}
