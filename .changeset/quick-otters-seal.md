---
"phoebe-agent": minor
---

Add the secret envelope to `phoebe-agent/contracts`: `sealSecret` and
`openSecret`, ECIES assembled from WebCrypto primitives alone — an ephemeral
X25519 key agreed with the deployment's box key, HKDF-SHA256, AES-256-GCM. The
additional authenticated data binds `keyFingerprint ‖ tenant ‖ key ‖ editId`, so
change any one of the four and the envelope will not open: it cannot be replayed
at another deployment, tenant, key name or edit. The wire form is
`{ v, epk, iv, ct }` in base64url, which a relay can store and forward without
being able to read any of it.

This is the subpath's first runtime value, so it lives in a plain-JS sibling that
both conditions of the export map re-export. Node will not type-strip a `.ts`
file under `node_modules`, and the JSDoc on that sibling is what makes the
re-export a typed one, so the crypto is written once rather than per condition.
The purity guard now walks the `.mjs` files as well as the `.ts` ones, since
those are the files a consumer's bundle actually executes. The package still
declares no runtime dependency.
