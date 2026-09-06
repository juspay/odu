/**
 * The build's own version, read from the manifest that declares it.
 *
 * One module rather than a literal at each use, because the number is a
 * PROVENANCE claim now: a catalog record carries it so a reader of a run that
 * was written months ago can tell which odu wrote it. A hard-coded string is a
 * claim that goes stale silently, which is the one failure mode a provenance
 * field cannot survive.
 *
 * The import is resolved at build time (`resolveJsonModule`), and `package.json`
 * is inside the Nix fileset the derivation copies — so the packaged binary
 * reads the same number the repo declares, with no build step to keep in step.
 */

import manifest from "../../package.json";

export const ODU_VERSION: string = manifest.version;
