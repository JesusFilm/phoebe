---
name: youtube-compliance
description: >-
  Enforce YouTube API Terms of Service and Developer Policy compliance when writing or
  reviewing code that calls, stores, or displays YouTube Data API v3 or YouTube
  Analytics/Reporting data. Use when reviewing a diff or PR, or when adding/changing code
  that touches YouTube API calls, OAuth scopes, quota usage, caching or storage of YouTube
  data, token/secret handling, attribution/branding, or analytics queries. Trigger phrases:
  "YouTube compliance", "YouTube API review", "check the ToS", "is this allowed by YouTube
  policy", "review for policy".
---

# YouTube API compliance

This monorepo contains **TypeScript / Node** apps that integrate with YouTube via the
**YouTube Data API v3** and the **YouTube Analytics & Reporting APIs**. Every change must
comply with the agreements Google requires of all YouTube API clients. Treat these as
**hard requirements, not suggestions**:

- YouTube API Services — Terms of Service: https://developers.google.com/youtube/terms/api-services-terms-of-service
- YouTube API Services — Developer Policies: https://developers.google.com/youtube/terms/developer-policies
- Required Minimum Functionality (RMF): https://developers.google.com/youtube/terms/required-minimum-functionality
- Google API Services User Data Policy: https://developers.google.com/terms/api-services-user-data-policy
- YouTube brand resources: https://www.youtube.com/howyoutubeworks/resources/brand-resources/

## How to apply this skill

When writing or reviewing code, in addition to normal correctness, security, and quality:

1. **Flag anything that could violate the YouTube API ToS or Developer Policies**, naming the
   specific rule it touches: data storage/refresh, deletion-on-revoke, attribution and
   branding, quota efficiency, ad-targeting prohibition, scraping/circumvention, user-data
   privacy, or credential handling.
2. Be **concrete and actionable**: cite the file/line, explain the policy in one sentence, and
   suggest a compliant alternative.
3. When a change **stores, caches, or transmits** YouTube API Data or end-user data, scrutinize
   it against the data-handling rules even if the diff is functionally correct.
4. When compliance **cannot be determined** from the change (retention configured elsewhere,
   OAuth scope not visible, etc.), say so and ask for the missing context rather than assuming
   the change is compliant.
5. Distinguish **blocking** violations (committing secrets, no deletion path for revoked users,
   using API data for ad targeting) from **non-blocking** improvements (quota efficiency,
   attribution polish) so the author can prioritize.

This skill is an **assistant, not a gate** — it does not replace human review or legal/compliance
sign-off.

## Detailed rules

The full, path-specific rules are version-controlled in `.github/instructions/` (the same files
GitHub Copilot code review reads). Read the file(s) relevant to the change before reviewing.
**Paths are relative to the repository root:**

- [.github/instructions/youtube-api-core.instructions.md](../../../.github/instructions/youtube-api-core.instructions.md)
  — cross-cutting ToS rules: no scraping/circumvention, playback via the official player,
  attribution & branding, prohibited uses of API data, minimum OAuth scopes, credentials & secrets.
- [.github/instructions/youtube-data-storage-privacy.instructions.md](../../../.github/instructions/youtube-data-storage-privacy.instructions.md)
  — storage/refresh (30-day rule), data minimization, encryption at rest, mandatory deletion on
  revoke/upstream-delete, end-user privacy & limited use, children's data.
- [.github/instructions/youtube-data-api-quota.instructions.md](../../../.github/instructions/youtube-data-api-quota.instructions.md)
  — Data API v3 quota efficiency (avoid `search.list`, trim `part`/`fields`, paginate
  deliberately, cache/batch) and resilience (backoff + jitter, no tight polling).
- [.github/instructions/youtube-analytics-reporting.instructions.md](../../../.github/instructions/youtube-analytics-reporting.instructions.md)
  — Analytics/Reporting: data isolation (`ids=channel==MINE`), permitted use, accurate display,
  handling withheld/sparse metrics, Reporting API retention/dedup.
