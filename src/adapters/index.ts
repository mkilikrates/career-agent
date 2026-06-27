// Adapters barrel — the swappable boundaries between @core and the outside
// world (storage, providers, PII screening, crypto key vault).
//
// PLACEHOLDER interfaces only at this stage. @core depends on these contracts,
// never on a concrete provider/storage/network client.

export type {
  StorageAdapter,
  StorageTier,
  MemoryPath,
  MemoryDir,
} from './storage';

export type {
  ProviderManager,
  LlmProvider,
  SttProvider,
  ProviderDescriptor,
  ProviderId,
  ProviderResponse,
  RedactedPayload,
  ValidationResult,
  ChatRequest,
  ChatResponse,
  AudioBlob,
  AudioFormat,
  Transcript,
  Locale,
  Markdown,
} from './provider';

export type { PiiScanner, Detection, DetectionCategory } from './pii';
export { DefaultPiiScanner, createPiiScanner } from './pii';

// --- Granular Ingestion Send-Control store (browser-local, R57.9) ----------

export type { SendControlStore } from './send-control-store';
export {
  computeFileFingerprint,
  getAllDecisions,
  getDecision,
  setDecision,
  removeDecision,
  clearDecisions,
} from './send-control-store';

// --- Crypto key vault ------------------------------------------------------

export type { KeyVault, KeyVaultStorage, WebCryptoKeyVaultOptions } from './vault';
export {
  WebCryptoKeyVault,
  InMemoryKeyVaultStorage,
  KeyNotFoundError,
  KeyVaultUnavailableError,
  CorruptKeyEntryError,
} from './vault';

// --- Provider_Manager (pluggable BYOK) -------------------------------------

export {
  DefaultProviderManager,
  defaultProviderPlugins,
  OPENAI_PROVIDER_ID,
  ANTHROPIC_PROVIDER_ID,
  LOCAL_PROVIDER_ID,
  UnknownProviderError,
  ProviderCapabilityError,
  NoProviderKeyError,
} from './provider-manager';
export type {
  ProviderPlugin,
  ProviderManagerOptions,
  DefaultProviderClients,
} from './provider-manager';
// --- Storage tiers ---------------------------------------------------------

// Tier 1: File System Access (real files in a user-chosen folder).
export { FileSystemAccessStorage } from './storage-fs-access';
export {
  FileSystemAccessUnavailableError,
  MemoryRootNotSelectedError,
  FolderAccessLostError,
} from './storage-fs-access';
export type {
  FileSystemAccessStorageOptions,
  FsDirectoryHandle,
  FsFileHandle,
  ShowDirectoryPicker,
  FsPermissionState,
} from './storage-fs-access';

// Tier 2: degraded fallback (OPFS/IndexedDB) with export/import for portability.
export { FallbackStorageAdapter, DEGRADED_TIER_NOTICE } from './storage-fallback';
export type { FallbackStorageAdapterOptions } from './storage-fallback';

export {
  OpfsIdbPersistence,
  InMemoryPersistence,
  createFallbackPersistence,
} from './fallback-persistence';
export type { FallbackPersistence } from './fallback-persistence';

export {
  exportTreeToZip,
  importZipToTree,
  MalformedArchiveError,
  ZIP_MIME_TYPE,
} from './memory-store-zip';
