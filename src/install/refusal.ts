/**
 * The installer's refusal type, in the house style of `ContinuityRefusal`.
 *
 * Install refusals are values, not exceptions to swallow: CONCEPT §11.1 requires that a config
 * conflict leaves the user's file untouched and tells them the exact next step, and ADR 005
 * rejects every "repair the config so the install can proceed" alternative.
 */
export class InstallRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstallRefusal";
    this.code = code;
  }
}