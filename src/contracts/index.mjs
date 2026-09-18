// Runtime surface of `phoebe-agent/contracts` — the `import` condition of the
// subpath export. It is empty, and honestly so: contracts is type declarations
// today, and types leave nothing behind at runtime. The entry exists anyway so
// that a bundler resolving the subpath finds a module rather than an error.
//
// When a pure runtime value does land here (the envelope's WebCrypto encrypt is
// the one in sight), it is written twice: typed in index.ts for the type
// condition, and in plain JS here for Node, which will not type-strip a `.ts`
// file out of node_modules. Same reason bootstrap/index.mjs exists.
export {};
