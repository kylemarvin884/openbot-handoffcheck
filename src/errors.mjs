export const EXIT = Object.freeze({ OK: 0, STALE: 1, USAGE: 2 });

export class HandoffcheckError extends Error {
  constructor(message, { code = "E_INTERNAL", exitCode = EXIT.STALE } = {}) {
    super(message);
    this.name = "HandoffcheckError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Bad arguments: exit 2. */
export const usageError = (message) =>
  new HandoffcheckError(message, { code: "E_USAGE", exitCode: EXIT.USAGE });

/** Bad handoff format (missing section, wrong column, bad line number): exit 2.
 *  Re-running with the same file fails the same way until the file is fixed. */
export const schemaError = (message) =>
  new HandoffcheckError(message, { code: "E_SCHEMA", exitCode: EXIT.USAGE });

/** File could not be read or written: exit 1. */
export const ioError = (message) =>
  new HandoffcheckError(message, { code: "E_IO", exitCode: EXIT.STALE });

/** Not usable as a repository (no git, not a work tree): exit 2. */
export const repoError = (message) =>
  new HandoffcheckError(message, { code: "E_NOREPO", exitCode: EXIT.USAGE });
