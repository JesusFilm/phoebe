# Bounded unit history on the data volume

#73 made the container log-stateless. Every line goes to tagged stdout for the host
to collect, and nothing about a work unit survives on disk beyond the `status.json`
snapshot and markers on GitHub. Step 1 of the self-improving factory map (#914)
needs per-unit history and cost that outlive the stdout stream, because the console,
the observer kind and the replay benchmark all read it. So each pipeline now keeps a
unit history: one structured unit record per settled or abandoned work unit,
appended to `state/<pipeline>/units.jsonl`.

The history is bounded by size, not by count or age. Once the file passes 1 MiB the
writer renames it over `units.1.jsonl` and starts a new one, so a pipeline holds at
most about 2 MiB. Every field in a record is bounded too: failure text is cut to 500
characters, tool counts stop at 32 names, and no raw provider payload or transcript
is kept. These are records, not logs, and #73 stands for logs.

## Considered options

- **One file per tenant.** A tenant runs one engine process per pipeline, so a
  tenant file has several writers and needs a lock. The pipeline directory already
  has exactly one writer and is what the stale-state sweep reclaims. The cost is
  that renaming a pipeline starts an empty history, which is what "a rename is a
  delete plus a create" already says.
- **An entry cap.** It needs a count on every append or a rewrite to trim. A size
  cap holds the disk bound however large records get.
- **A time window.** A busy pipeline's file would have no upper size.
- **A model price table inside Phoebe.** Records store only the token and cost
  fields each CLI emits, with `null` where it emits none. Claude's cost is a
  list-price estimate under a subscription, so each agent run records a cost basis
  taken from the credential Phoebe handed it. Phoebe never prices tokens itself.

## Consequences

- Each line carries its own schema version, `v`. `phoebe boot` relaunches the
  engine at a new ref against the same state directory, so one rotated file can
  hold two versions. Readers skip versions they do not know.
- A process that dies mid-unit writes nothing for that unit. Its successor writes
  an `abandoned` record at boot from the snapshot, which therefore carries the
  provider, model and effort of each unit in flight.
- Writing a record can fail without failing the unit, the same as the snapshot
  writer.
