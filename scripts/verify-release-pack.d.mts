export interface TarballValidation {
  readonly ok: boolean;
  readonly missing: string[];
  readonly forbidden: string[];
}

export declare function validateWebTarballEntries(entries: readonly string[]): TarballValidation;

export declare function validateServerTarballEntries(entries: readonly string[]): TarballValidation;

export declare function formatSha256Sums(
  items: ReadonlyArray<{ file: string; sha256: string }>,
): string;
