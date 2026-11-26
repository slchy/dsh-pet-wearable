export interface SecretFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

export declare function isForbiddenTrackedPath(relPath: string): string | null;

export declare function scanFileContent(relPath: string, content: string): SecretFinding[];

export declare function runCli(options?: { root?: string }): number;
