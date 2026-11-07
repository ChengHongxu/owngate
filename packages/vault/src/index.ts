export { Vault, vaultContext, isEncryptedBlob, isLegacyBlob } from './vault.js';
export type { EncryptedBlob, VaultContext } from './vault.js';
export { discoverEncryptedRecords, migrateEncryptedRecords, rekeyEncryptedRecords } from './maintenance.js';
export type { VaultDatabase, EncryptedRecord, VaultMaintenanceOptions, VaultMaintenanceResult } from './maintenance.js';
export { redact, SecretRedactor } from './redact.js';
export type { RedactionContext, SensitivityLevel } from './redact.js';
