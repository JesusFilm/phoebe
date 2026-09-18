// Runtime surface of `phoebe-agent/contracts` — the `import` condition of the
// subpath export. Most of contracts is type declarations, which leave nothing
// behind at runtime; what lands here is the part a consumer actually calls.
//
// Plain JS, and every runtime value it re-exports lives in a plain-JS sibling,
// because Node 24 will not type-strip a `.ts` file under a `node_modules`
// segment and the installed package lives exactly there. The types come from the
// JSDoc in those siblings, read through index.ts (the `types` condition), so the
// implementation is written once rather than mirrored per condition.
export { openSecret, sealSecret } from "./secret-envelope.mjs";
