---
"phoebe-agent": patch
---

Crash reports no longer carry credentials. A failed engine `git` command quotes its URL, and that URL embeds `GH_TOKEN` as `x-access-token:<token>@github.com`. The crash reporter used to send that text to Sentry unchanged, and the `sentry` kind then filed it as a public GitHub issue. Now every string in a report has secret shapes removed (token prefixes, credentials in URLs, bearer headers, `KEY=value`), along with any secret value in the reporting process's env. The `sentry` kind strips the same shapes from the issue title, body and duplicate comment before filing, which covers reports from engines older than this fix. The boot log's error lines get the same treatment, and the log redactor now removes a URL's whole `user:password@` rather than only a learned value inside it.
