// Hand-written declarations for the plain-JS gate script, so `test/clean-clone.spec.ts` can
// import its pure parsing/env helpers directly (fast, no subprocess) instead of re-implementing
// their logic in the test. TS does not check a `.mjs` file's body without `allowJs`, so nothing
// here is verified against the implementation automatically; keep the two in sync by hand.

export declare class UsageError extends Error {}

export interface ReadmeClaim {
  readonly setupCommands: readonly string[];
  readonly finalArgv: readonly string[];
  readonly transcript: string;
  readonly expectedBytes: number;
  readonly expectedStdoutPrefix: string;
  readonly expectedHash: string;
}

export declare function parseReadme(readmeText: string): ReadmeClaim;

export declare function isolatedEnv(source?: Record<string, string | undefined>): Record<string, string | undefined>;

export interface CleanCloneReport {
  readonly ok: boolean;
  readonly command: string;
  readonly transcript: string;
  readonly clonedHead: string;
  readonly expected: { readonly bytes: number; readonly hash: string };
  readonly actual: { readonly bytes: number; readonly hash: string | null };
  readonly mismatches: readonly string[];
}

export declare function runCleanCloneCheck(): CleanCloneReport;
