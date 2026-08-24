---
"phoebe-agent": patch
---

Credential lease requests now time out after 60 seconds. A supervisor that connects but never responds no longer stalls its tenant indefinitely — the affected cycle is skipped and normal polling resumes.
