---
"phoebe-agent": patch
---

One docs home for the console and the companion (#562).

`docs/console.md` covers the companion, what each of the console's pages shows,
alerting, and the part that stays at a shell on purpose. `operating.md`,
`configuration.md` and `trust.md` point at it rather than growing a second copy.

- Every noun the console introduced to `CONTEXT.md` carries an avoid-list.
- The findings behind the design land under `docs/research/`: how T3 Code
  packages its clients, and what youtube-studio's app guidelines require.
- The doctor report has one contract file rather than two copies of the same
  type.
