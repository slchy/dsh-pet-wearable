export interface ReleaseTag {
  readonly tag: string;
  readonly version: string;
  readonly prerelease: boolean;
  readonly distTag: 'latest' | 'next';
}

export interface VersionConsistencyOk {
  readonly ok: true;
  readonly version: string;
  readonly prerelease: boolean;
  readonly distTag: 'latest' | 'next';
}

export interface VersionConsistencyError {
  readonly ok: false;
  readonly error: string;
}

export declare function isValidSemver(version: string): boolean;

export declare function isPrerelease(version: string): boolean;

export declare function parseReleaseTag(tag: string): ReleaseTag;

export declare function verifyVersionConsistency(input: {
  tag?: string;
  rootVersion: string;
  webVersion: string;
}): VersionConsistencyOk | VersionConsistencyError;

export declare function bumpPackageVersions(
  repoDir: string,
  nextVersion: string,
  options?: { dryRun?: boolean },
): { version: string; changed: string[] };
