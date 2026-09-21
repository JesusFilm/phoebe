// Runtime surface of `phoebe-agent/contracts` — the `import` condition of the
// subpath export. Almost everything here is types, and types leave nothing
// behind at runtime; what is left is the handful of pure constants a reader
// needs to *check* something, written twice by hand.
//
// Twice, because Node will not type-strip a `.ts` file out of node_modules: an
// installed consumer's `import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts"`
// resolves to this file and never to index.ts. The type condition points at the
// `.ts`, so a type-checker reads the documented declaration and a runtime reads
// this. src/contracts/deployment.test.ts holds the two copies to the same value;
// bootstrap/index.mjs exists for the same reason.

/** The `schema` integer `state/deployment.json` carries — see deployment.ts. */
export const DEPLOYMENT_SCHEMA = 1;

/** The effective config's own shape version — see effective-config.ts. */
export const EFFECTIVE_CONFIG_VERSION = 1;
