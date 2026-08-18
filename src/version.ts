import { version as commandCodeVersion } from "command-code/package.json";

/**
 * Sent as `x-command-code-version`. The gateway accepts what it is given; this
 * is the CLI build whose wire contract the adapter was derived from and is
 * checked against, so it is also the honest answer to "which client shape is
 * this". Only the version string is bundled — the CLI itself is never
 * imported, executed, or shipped into the Worker.
 */
export const COMMAND_CODE_VERSION: string = commandCodeVersion;

/** This Worker's own version, reported by the health endpoint. */
export const WORKER_VERSION = "2.0.0";
