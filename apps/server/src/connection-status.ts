import type { Capability, Connection, ConnectionHealth, SupportState } from '@owngate/core';
import type { ConnectorRegistry } from './registry.js';

type Registry = Pick<ConnectorRegistry, 'getManifest' | 'listCapabilities'>;

/** Static implementation support and account-specific observations have
 * different meanings. A failure needs an actual observation timestamp. */
export function effectiveCapabilityState(capability: Capability, observed?: SupportState): SupportState {
  if (capability.kind !== 'query' || capability.effect !== 'read' || capability.support.status === 'disabled') return { status: 'disabled' };
  if (capability.support.status === 'unsupported') return capability.support;
  const implemented = ['supported', 'partial', 'unverified'].includes(capability.support.status);
  if (!observed) return implemented ? { status: 'unverified' } : capability.support;
  if (implemented && ['needs_adapter', 'needs_auth'].includes(observed.status) && !Number.isFinite(Date.parse(observed.probed_at ?? ''))) {
    return { status: 'unverified' };
  }
  return observed;
}

/** Keep the persisted execution state and all administrator views on the same
 * vocabulary. Stale keys from removed capabilities do not remain authoritative. */
export function normalizeCapabilityStates(connection: Connection, registry: Registry): Record<string, SupportState> {
  return Object.fromEntries(registry.listCapabilities(connection.connector_id, connection).map(capability =>
    [capability.id, effectiveCapabilityState(capability, connection.capability_states[capability.id])]));
}

/** A connection summary describes observed queries, rather than every stored
 * override (which may belong to another role or a removed capability). */
export function summarizeConnectionHealth(
  connection: Pick<Connection, 'paused' | 'capability_states'>,
  capabilities: Capability[],
  authenticationCapability?: string,
): ConnectionHealth {
  if (connection.paused) return { status: 'paused' };
  const queries = capabilities.filter(capability => capability.kind === 'query' && capability.effect === 'read');
  if (queries.length === 0) return { status: 'unverified' };
  const states = queries.map(capability => ({ id: capability.id,
    state: effectiveCapabilityState(capability, connection.capability_states[capability.id]) }));
  const active = states.filter(({ state }) => state.status !== 'disabled');
  if (active.length === 0) return { status: 'disabled' };

  const auth = active.find(({ id }) => id === authenticationCapability);
  if (auth?.state.status === 'needs_auth') return { status: 'needs_auth', reason: '认证检查未通过，请检查登录或凭据' };

  const counts = new Map<string, number>();
  for (const { state } of active) counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
  const count = (status: string) => counts.get(status) ?? 0;
  const labels: Array<[string, string]> = [
    ['supported', '可用'], ['partial', '部分可用'], ['unverified', '待验证'],
    ['needs_auth', '需要认证'], ['needs_plan', '受套餐限制'], ['needs_adapter', '适配异常'],
    ['unavailable', '暂不可用'], ['unsupported', '不支持'],
  ];
  const reason = labels.filter(([status]) => count(status) > 0).map(([status, label]) => `${count(status)} 项${label}`).join(' · ');
  const usable = count('supported') + count('partial');
  const problems = count('partial') + count('needs_auth') + count('needs_plan') + count('needs_adapter') + count('unavailable');
  if (usable > 0) return { status: problems > 0 ? 'partial' : 'healthy', reason };
  if (count('unverified') === active.length) return { status: 'unverified', reason };
  if (count('unsupported') === active.length) return { status: 'unsupported', reason };
  // Without a dedicated check, only an entirely auth-blocked connection can
  // be summarized as needing authentication. One endpoint is not the account.
  if (!authenticationCapability && count('needs_auth') === active.length) return { status: 'needs_auth', reason };
  if (count('needs_adapter') > 0 && count('needs_adapter') === problems) return { status: 'needs_adapter', reason };
  if (count('needs_plan') > 0 && count('needs_plan') === problems) return { status: 'needs_plan', reason };
  if (problems > 0) return { status: 'unavailable', reason };
  return { status: 'unverified', reason };
}

export function connectionHealth(connection: Connection, registry: Registry): ConnectionHealth {
  const manifest = registry.getManifest(connection.connector_id)?.compiled;
  return summarizeConnectionHealth(connection, registry.listCapabilities(connection.connector_id, connection),
    manifest?.verification?.auth ?? manifest?.login?.whoami);
}

export function connectionView(connection: Connection, registry: Registry): Connection & { health: ConnectionHealth } {
  return { ...connection, capability_states: normalizeCapabilityStates(connection, registry), health: connectionHealth(connection, registry) };
}
