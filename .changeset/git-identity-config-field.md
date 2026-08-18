---
"phoebe-agent": minor
---

New bootstrapper-only config field `gitIdentity` (#199): a repo declares how its
commits are attributed — `gitIdentity: { name, email }` in `phoebe.config.ts` —
instead of every deployment that adopts it restating the four `GIT_AUTHOR_*` /
`GIT_COMMITTER_*` vars in a `.env`. A name and an email are not secrets and are
repo-scoped, which is exactly the class of fact `phoebe.config.ts` is for.

**The precedence ladder, decided here** (the objection #161 raised when it
declined the field). Later wins: the supervisor's deployment-global `GIT_*` <
the `app` arm's bot fallback < `gitIdentity` < the tenant's own `.env`. The
config field outranks anything said deployment-wide and is outranked by anything
said about that tenant specifically, per variable. Nothing moves for existing
deployments: a `.env` that sets an identity today still wins, and a repo that
declares nothing gets a byte-for-byte unchanged child env. In solo there is no
deployment-global rung — the container env _is_ the single tenant's env-file, so
it wins and the field fills the gaps; where it does, boot logs a line naming the
vars it overrode, so a declaration cannot go quietly inert.

Both halves are required — #161 established the email must be exact for
GitHub's commit→account linkage, so a name-only field would look like it worked
and attribute nothing — and the pair sets all four vars; author and committer
are not separately expressible. A malformed value fails the tenant
(skip-and-warn in a fleet, a hard boot error in solo) rather than silently
falling back to the deployment's identity.

Read by the bootstrapper only, like `engine` / `workspace` / `configDir`:
`resolveConfig` drops it and the engine sees only the env vars the supervisor
sets from it. Editing the field relaunches that tenant's child with the new
identity at the next work-unit boundary, no container restart.
