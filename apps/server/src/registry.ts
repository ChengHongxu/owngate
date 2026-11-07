// ConnectorRegistry manages loaded connector manifests and credentials supplied by the server.

import { isCapabilityRoleAllowed, type Capability, type Connection } from '@owngate/core'
import { loadManifestFile } from '@owngate/connector-runtime'
import type { CompiledConnector, LoginConfig, OutputFieldDef } from '@owngate/connector-runtime'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface ManifestEntry {
  compiled: CompiledConnector
  http?: {
    base: string
    headers?: Record<string, string>
    rate_limit?: { rpm: number }
    timeout_ms?: number
  }
  capabilityDefs: Record<string, {
    request?: { method: string; path: string; query?: Record<string, string>; readonly_paths?: string[] }
    output?: Record<string, OutputFieldDef>
    success_when?: string
    auth_failed_when?: string
  }>
  /** Manifest `login:` block (§4.4.3); absent for connectors without remote login. */
  login?: LoginConfig
}

export class ConnectorRegistry {
  private manifests = new Map<string, ManifestEntry>()
  private credentials = new Map<string, Record<string, string>>()

  /**
   * Load all YAML manifests from the connectors directory.
   * Scans `<connectorsDir>/<id>/manifest.yaml`.
   */
  loadDirectory(connectorsDir: string): void {
    if (!existsSync(connectorsDir)) return
    for (const entry of readdirSync(connectorsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(connectorsDir, entry.name, 'manifest.yaml')
      if (!existsSync(manifestPath)) continue
      try {
        this.loadFile(manifestPath)
      } catch (e) {
        console.error(`[registry] Failed to load ${manifestPath}:`, (e as Error).message)
      }
    }
  }

  loadFile(path: string): CompiledConnector {
    const compiled = loadManifestFile(path)
    // Loader now returns full manifest data (http, config, auth, capabilityDefs)
    const entry: ManifestEntry = {
      compiled,
      ...(compiled.http ? { http: compiled.http } : {}),
      capabilityDefs: compiled.capabilityDefs ?? {},
      ...(compiled.login !== undefined ? { login: compiled.login } : {}),
    }
    this.manifests.set(compiled.id, entry)
    return compiled
  }

  register(connectorId: string, compiled: CompiledConnector): void {
    this.manifests.set(connectorId, {
      compiled,
      ...(compiled.http !== undefined ? { http: compiled.http } : {}),
      capabilityDefs: compiled.capabilityDefs ?? {},
      ...(compiled.login !== undefined ? { login: compiled.login } : {}),
    })
  }

  getManifest(connectorId: string): ManifestEntry | undefined {
    return this.manifests.get(connectorId)
  }

  listManifests(): ManifestEntry[] {
    return [...this.manifests.values()];
  }

  /** Login settings (URL, success condition, whoami) declared by the connector's manifest. */
  getLogin(connectorId: string): LoginConfig | undefined {
    return this.manifests.get(connectorId)?.login
  }

  getCapability(connectorId: string, capabilityId: string, connection?: Connection): Capability | undefined {
    const capability = this.manifests.get(connectorId)?.compiled.capabilities[capabilityId]
    return capability && (!connection || isCapabilityRoleAllowed(connection, capability)) ? capability : undefined
  }

  listCapabilities(connectorId: string, connection?: Connection): Capability[] {
    const entry = this.manifests.get(connectorId)
    if (!entry) return []
    return Object.values(entry.compiled.capabilities).filter((capability) => !connection || isCapabilityRoleAllowed(connection, capability))
  }

  /** Store decrypted credentials for a connection (from vault, loaded on demand). */
  setCredentials(connectionId: string, creds: Record<string, string>): void {
    this.credentials.set(connectionId, creds)
  }

  getCredentials(connectionId: string): Record<string, string> | undefined {
    return this.credentials.get(connectionId)
  }

  clearCredentials(connectionId: string): void {
    this.credentials.delete(connectionId)
  }
}
