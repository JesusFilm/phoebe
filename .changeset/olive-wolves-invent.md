---
"phoebe-agent": minor
---

The bootstrapper now keeps a deployment report: one fixed-size file on the data
volume, `state/deployment.json`, saying what the whole deployment is doing right
now. It carries the deployment's identity, the running engine SHA with the
crash-loop record and reconcile state, each supervised child's liveness and last
exit, the slot cap, and one entry per (tenant × pipeline) cell with that
pipeline's raw `status.json` and its derived state. The type lives in
`phoebe-agent/contracts`; the file is replaced atomically and rewritten only when
something in it moves.

Supervised engines report each completed loop pass and each `status.json` write
over the IPC channel they already had. That pass clock widens `wedged?`: as well
as a unit past its run budget plus a poll interval, a pipeline is wedged when it
has completed no pass in three poll intervals while not waiting for a slot — the
case an idle-looking engine with a stopped loop used to hide in. Derivation
happens once, in the deployment, so a reader of the file renders it and computes
nothing. No on-disk logs are added.
