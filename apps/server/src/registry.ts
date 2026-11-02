// ConnectorRegistry — manages loaded connector manifests and decrypted credentials.
// In M1, manifests are loaded from YAML files at startup and from the database.
// Credentials are decrypted on-demand via the Vault.

import type { Capability } from '@webridge/core'
import { loadManifestFile } from '@webridge/connector-runtime'
import type { CompiledConnector } from '@webridge/connector-runtime'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Vault } from '@webridge/vault'

export interface ManifestEntry {
  compiled: CompiledConnector
  http?: {
    base: string
    headers?: Record<string, string>
    rate_limit?: { rpm: number }
    timeout_ms?: number
  }
  capabilityDefs: Record<string, {
    output?: Record<string, { from: string; transform?: string; unit?: string; scope?: string; sensitivity?: string }>
    success_when?: string
    auth_failed_when?: string
  }>
}

export class ConnectorRegistry {
  private manifests = new Map<string, ManifestEntry>()
  private credentials = new Map<string, Record<string, string>>()

  constructor(private vault: Vault) {}

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
    // Re-parse the raw YAML to extract http block and per-capability request details.
    // loadManifestFile returns compiled Capabilities but we also need raw request defs
    // for the HTTP dispatcher. For now store the compiled data with placeholder defs.
    // TODO M3: store full manifest raw alongside compiled for complete request dispatch.
    const entry: ManifestEntry = {
      compiled,
      capabilityDefs: {},
    }
    this.manifests.set(compiled.id, entry)
    return compiled
  }

  register(connectorId: string, compiled: CompiledConnector): void {
    this.manifests.set(connectorId, { compiled, capabilityDefs: {} })
  }

  getManifest(connectorId: string): ManifestEntry | undefined {
    return this.manifests.get(connectorId)
  }

  getCapability(connectorId: string, capabilityId: string): Capability | undefined {
    return this.manifests.get(connectorId)?.compiled.capabilities[capabilityId]
  }

  listCapabilities(connectorId: string): Capability[] {
    const entry = this.manifests.get(connectorId)
    if (!entry) return []
    return Object.values(entry.compiled.capabilities)
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
