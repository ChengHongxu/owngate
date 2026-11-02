// Manifest loader — design doc §4.1.1
// Parses a YAML connector manifest, validates it, and compiles it into
// Capability objects ready for the runtime.

import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { isKnownTransform } from './transforms.js'
import type { Capability, JSONSchema, Transport } from '@webridge/core'

// ── Public types ───────────────────────────────────────────────────────────

export interface CompiledConnector {
  id: string
  version: string
  title: string
  transport: Transport
  capabilities: Record<string, Capability>
}

// ── Internal manifest types ────────────────────────────────────────────────

type AccessKind = 'official_api' | 'private_api' | 'browser'

type SensitivityKind = 'pii' | 'financial' | 'content'

interface OutputFieldDef {
  from: string
  transform?: string
  unit?: string
  scope?: string
  sensitivity?: SensitivityKind
}

interface CapabilityDef {
  id: string
  kind: 'query' | 'action'
  effect: string
  approval?: string
  cache: { ttl: number } | null
  title: string
  description: string
  request: { method: string; path: string }
  success_when?: string
  auth_failed_when?: string
  output?: Record<string, OutputFieldDef>
}

interface ManifestRaw {
  connector: string
  version: string
  title: string
  access: AccessKind
  config?: Record<string, unknown>
  auth?: { type: string; fields?: Record<string, unknown> }
  http?: {
    base: string
    headers?: Record<string, string>
    rate_limit?: { rpm: number }
    timeout_ms?: number
  }
  capabilities: CapabilityDef[]
}

// ── Validation helpers ─────────────────────────────────────────────────────

const ACCESS_KINDS: ReadonlySet<string> = new Set(['official_api', 'private_api', 'browser'])
const EFFECT_VALUES: ReadonlySet<string> = new Set(['read', 'write', 'destructive', 'external_send', 'financial'])
const KIND_VALUES: ReadonlySet<string> = new Set(['query', 'action'])
const SENSITIVITY_VALUES: ReadonlySet<string> = new Set(['pii', 'financial', 'content'])

function requireString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${ctx}: "${key}" must be a non-empty string, got ${JSON.stringify(v)}`)
  }
  return v
}
