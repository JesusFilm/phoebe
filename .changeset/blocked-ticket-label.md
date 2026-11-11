---
"phoebe-agent": patch
---

An `issues` or `research` run that stops because a person has to act no longer gets re-run until quarantine. Before, the stranded-unit sweep saw a claim with no PR, dropped the claim, and the ticket went back in the queue. It took two more full agent runs and a quarantine comment blaming an "unproductive" unit before anyone looked at the question the first run had asked.

The shipped prompts now have the agent end that comment with a `<!-- phoebe-blocked -->` line. When the sweep finds the line in one of Phoebe's own comments, it swaps `processingLabel` for a new `phoebe:blocked` label, creating the label if the repo doesn't have it yet. It posts a comment saying how to hand the ticket back and counts no unproductive run. Selection skips the label, and the idle line counts these tickets as `waiting on a human`. Remove the label to put the ticket back in the queue. Runs the agent expects a retry to fix, like a flaky test or a service that is down, leave the line out and are handled as before.

If you vendor the `issues` or `research` prompt, copy in the new "blocked for any other reason" rule. Without it your agent never writes the line, and those runs behave the way they did before. A custom issue kind that wants the same handling has to skip `phoebe:blocked` in its own `select`.
