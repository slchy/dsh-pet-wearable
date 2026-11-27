export declare const SERVER_BUNDLE_ALLOWLIST: {
  readonly dirs: readonly string[];
  readonly files: readonly string[];
};

export declare function isForbiddenBundleEntry(relPath: string): string | null;

export declare function collectServerBundleFiles(repoDir: string): string[];

export declare function createServerBundle(
  repoDir: string,
  outFile: string,
): { outFile: string; files: string[]; bytes: number; sha256: string };
