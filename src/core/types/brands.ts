// Nominal / branded primitive types for the Career Agent core domain.
//
// TypeScript is structurally typed, so a plain `string` used as an id is freely
// interchangeable with any other `string`. The brand below attaches a phantom,
// erasable tag so that e.g. a `StarId` cannot be passed where a `BulletId` (or a
// raw string) is expected, without any runtime cost. The brand symbol never
// exists at runtime — it is a compile-time-only marker.

declare const brand: unique symbol;

/**
 * Attach a compile-time-only nominal tag `B` to an underlying primitive `T`.
 * Values still behave like `T` at runtime; the tag exists only for the checker.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

// --- Stable identifier brands (task 1.2) ---------------------------------
// These are the four ID brands the task requires to be non-interchangeable
// with plain strings or with each other.

/** `STAR-NN` talking-point identifier — never reused/renumbered (R23.2). */
export type StarId = Brand<string, 'StarId'>;

/** `BULLET-NN` accomplishment identifier — never reused (R18.4). */
export type BulletId = Brand<string, 'BulletId'>;

/** Skill-map entry identifier (R14.1, R18.3). */
export type SkillId = Brand<string, 'SkillId'>;

/** `Q-NN` interview-question identifier — stable per-role (R22.2, R22.3). */
export type QuestionId = Brand<string, 'QuestionId'>;

/** URL-safe, deterministic role identifier (R20.2, R21). */
export type RoleSlug = Brand<string, 'RoleSlug'>;

// --- Supporting branded aliases referenced by the domain shapes ----------
// The design's type shapes reference these auxiliary identifiers/scalars.
// They are branded too so they participate in the same nominal-safety scheme.

/** Identifier of an ingested source document (R12.1, R38.1). */
export type DocId = Brand<string, 'DocId'>;

/** Identifier of a raw extracted item before promotion to a typed record. */
export type ItemId = Brand<string, 'ItemId'>;

/** A skill term as phrased by the user/source — preserved verbatim (R17.3). */
export type SkillTerm = Brand<string, 'SkillTerm'>;

/** A path inside the Memory Store tree (used by the healing report, R36.3). */
export type MemoryPath = Brand<string, 'MemoryPath'>;

/**
 * Identifier of a single Sensitive Detection within a staged file (R57.2). It is
 * stable for a given file content so that a persisted per-detection send choice
 * can be reapplied when the same file is re-staged (R57.9).
 */
export type DetectionId = Brand<string, 'DetectionId'>;

/** Identifier of a staged file the user makes a send-control decision for (R57.1). */
export type FileId = Brand<string, 'FileId'>;

/**
 * A stable fingerprint of a staged file's identity + content (R57.9). Used as the
 * key of the browser-local SendControlStore so a confirmed send choice is reapplied
 * when the same file is re-staged. It records identity only — never the file content
 * or any detected secret value.
 */
export type FileFingerprint = Brand<string, 'FileFingerprint'>;

/** An ISO-8601 date/time string (e.g. `2024-05-01` or full timestamp). */
export type ISODate = Brand<string, 'ISODate'>;

// --- Constructors --------------------------------------------------------
// Tiny helpers to mint branded values from raw strings at trust boundaries
// (parsers, registries). They are identity functions at runtime.

export const asStarId = (s: string): StarId => s as StarId;
export const asBulletId = (s: string): BulletId => s as BulletId;
export const asSkillId = (s: string): SkillId => s as SkillId;
export const asQuestionId = (s: string): QuestionId => s as QuestionId;
export const asRoleSlug = (s: string): RoleSlug => s as RoleSlug;
export const asDocId = (s: string): DocId => s as DocId;
export const asItemId = (s: string): ItemId => s as ItemId;
export const asSkillTerm = (s: string): SkillTerm => s as SkillTerm;
export const asMemoryPath = (s: string): MemoryPath => s as MemoryPath;
export const asISODate = (s: string): ISODate => s as ISODate;
export const asDetectionId = (s: string): DetectionId => s as DetectionId;
export const asFileId = (s: string): FileId => s as FileId;
export const asFileFingerprint = (s: string): FileFingerprint => s as FileFingerprint;
