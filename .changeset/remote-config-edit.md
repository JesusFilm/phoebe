---
"phoebe-agent": minor
---

Remote config edit from the console (#547).

An operator changes one field on the config tab, and the patch travels to the
deployment, becomes one changed literal in its `phoebe.config.ts`, and comes back
as a receipt that ends at `written` or `refused`. It is the same `phoebe config
set` code a shell run uses, invoked from a message instead of from argv, so there
is one writer and one reconcile path.

- **Edit is offered only where it would be taken.** A leaf `config set` accepts
  carries an Edit button; every other leaf carries the sentence saying why not,
  with the exact manual edit and the `phoebe config set` line under it. The closed
  set moved into `phoebe-agent/contracts` as `CLOSED_EDIT_BLOCKS`, so the console
  and the deployment read one table rather than two that can drift.
- **In a workspace only the root config is editable.** Every tenant row in the
  config section now names the file it was read from, and a tenant's own config
  gets the command for that checkout rather than a form the deployment would
  refuse.
- **The patch carries the fingerprint the page loaded.** A file that moved in
  between is refused `stale` with both hashes, never merged.
- **The relay stamps the author.** `by` on the edit is the signed-in Google
  address, written by the relay and ignored from the body, so nobody can sign
  somebody else's name to a ledger entry. Beyond that the relay is a courier: it
  carries the receipt back without reading a field of it.
- **Every refusal is actionable, including undelivered.** A refusal shows the
  deployment's own instruction; the relay's `undelivered` — a deployment that is
  not connected — shows the manual edit the console composed itself. Nothing is
  queued and nothing is replayed; the operator re-issues, and the edit id makes
  that free.
- **After `written`, the page follows the report.** The reconcile the write set
  going shows as `reconciling (config)` and then as idle with `lastEditId` naming
  the edit, and the leaf turns `file` at its new value. That is the proof it took
  — nothing is applied except through the file.
- The deployment report now ships the edit ledger's live entries as `edits`, so a
  console can say "edits not yet in a commit" without reading the deployment's
  git.
- New: `POST /api/deployments/config-set` on the relay, with
  `RelayConfigSetRequest` and `RelayConfigSetAnswer` in
  `phoebe-agent/contracts`.
