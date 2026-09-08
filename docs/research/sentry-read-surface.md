# The Sentry read a poll loop needs

Research for [#470](https://github.com/JesusFilm/phoebe/issues/470) on the Sentry work-kind map
([#469](https://github.com/JesusFilm/phoebe/issues/469)), read 2026-09-05. Sources are Sentry's
own API reference at `docs.sentry.io`, Sentry's published OpenAPI document
([`getsentry/sentry-api-schema`](https://github.com/getsentry/sentry-api-schema) at
`043e7fd`), and the `getsentry/sentry` source at `a7b4a8a` where the docs stop short. GlitchTip
facts come from its live OpenAPI document and its backend source; Bugsink facts come from its
own API guide and generated reference. Every claim cites the thing that owns it.

The map wants a kind that polls a project for unresolved errors, triages each one against the
tenant's repo, and files a GitHub issue. This note answers what the poll loop can actually ask
for, what it costs, and whether one adapter covers all three collectors.

## The short answers

- **Three calls do the whole loop, and the fourth is optional.** List unresolved groups, fetch
  the latest event for each new one, file the GitHub issue, then link it back. The group detail
  call in the middle is skippable, because the event carries the release.
- **`event:read` on a user auth token is the whole read side.** Sentry's scope table is
  coarse: `event:read` "Grants GET access to issues and events"
  ([Permissions & Scopes](https://docs.sentry.io/api/permissions/)), and there is no narrower
  project-only read for issues. Linking a GitHub issue back needs `event:write`.
- **Rate limits are nowhere near binding.** Sentry publishes no numbers, but the source does:
  20 requests per second per organization on the org issues list, 15 per second on event
  details. A poll loop running once a cycle uses a rounding error of that.
- **GlitchTip is a genuine drop-in for reading. Bugsink is not.** GlitchTip serves the same
  paths, the same field names, and the same camelCased stack frames, deliberately. Bugsink
  ships its own `/api/canonical/0/` with different field names for the same concepts, so it
  needs a second adapter. That is a smaller cost than it sounds, and Bugsink hands you a
  Markdown stacktrace for free, which is arguably better input for a triage agent than JSON.

## (a) The unresolved groups of one project

Two endpoints can do it, and the org-scoped one is better.

```
GET /api/0/organizations/{org}/issues/?project={project_id}&query=is:unresolved&statsPeriod=24h&limit=100
GET /api/0/projects/{org}/{project}/issues/?query=is:unresolved&statsPeriod=24h&limit=100
```

([List an Organization's Issues](https://docs.sentry.io/api/events/list-an-organizations-issues/),
[List a Project's Issues](https://docs.sentry.io/api/events/list-a-projects-issues/))

Both default `query` to `is:unresolved` and cap `limit` at 100. Prefer the org-scoped one for
three reasons. Its `statsPeriod` takes any number plus `d`/`h`/`m`/`s`/`w`, where the
project endpoint accepts only `"24h"`, `""` or `"14d"`. It carries `start`/`end`,
`environment`, `expand` and `collapse`. And its rate limit is four times as generous (see
below). The `project` parameter takes an array, so one call can watch several projects, or
`-1` for every project the token can reach.

Of the five fields the ticket asks for, four come back on the list:

| Field                    | Present on the list?       |
| ------------------------ | -------------------------- |
| `count`                  | yes (string, total events) |
| `firstSeen` / `lastSeen` | yes (ISO-8601)             |
| `level`                  | yes                        |
| `culprit`                | yes                        |
| release                  | **no**                     |

Verified against the response schemas in the published OpenAPI document for both endpoints.
`firstRelease` and `lastRelease` exist only on the issue detail response, and no `expand`
value adds them to the list. So a release-aware poll loop pays one extra call per group, or
reads the release off the latest event instead, which is what I would do.

Two more list fields matter to this map even though the ticket did not ask for them.
`annotations` is a list of `{displayName, url}` and it is where an external issue link shows
up, on the plain list call with no `expand`
(`src/sentry/api/serializers/models/group.py` at `a7b4a8a`, `GroupSerializerBase` merges
`_resolve_external_issue_annotations` and `_resolve_integration_annotations` into every
serialized group). That is the cheap watermark read described in (d). `metadata` carries the
exception type and value, which is the human-readable half of the title.

Filtering happens in `query`, using Sentry's issue search grammar
([Issue Properties](https://docs.sentry.io/concepts/search/searchable-properties/issues/)):
`is:` takes `unresolved`, `resolved`, `archived`, `assigned`, `unassigned`, `for_review`,
`linked`, `unlinked`; `level:`, `firstSeen`, `lastSeen`, `timesSeen` and `release:` are all
searchable; relative times are `age:-24h` (newer than 24 hours) and `age:+12h` (older than
12 hours), with `m`/`h`/`d`/`w` suffixes. `is:unresolved is:unlinked timesSeen:>10` is a
noise floor and a watermark expressed server-side in one string, which is worth knowing when
[#471](https://github.com/JesusFilm/phoebe/issues/471) picks up the noise-floor question.
Note that `is:unlinked` is about integration links, not the Sentry App external issues of
(d), so the two ways of recording a GitHub issue are not interchangeable for filtering.

Pagination is a `Link` header, not a body field:
`<URL>; rel="[previous|next]"; results="[true|false]"; cursor="[value]"`
([Pagination](https://docs.sentry.io/api/pagination/)). Follow `rel="next"` until
`results="false"`. Cursors come back even when there are no results, which the docs
explicitly call out as a polling affordance.

## (b) One group's detail

```
GET /api/0/organizations/{org}/issues/{issue_id}/
```

([Retrieve an Issue](https://docs.sentry.io/api/events/retrieve-an-issue/))

The interesting delta over the list is `firstRelease`, `lastRelease`, `tags`, `participants`,
`activity`, `seenBy` and `userReportCount`. Everything else the list already gave you.

If the only reason to call this is the release, skip it. The latest event response in (c)
carries a `release` object and the full `tags` array, which covers the same ground in a call
you were already making.

## (c) The latest event, with frames and source context

```
GET /api/0/organizations/{org}/issues/{issue_id}/events/latest/
```

([Retrieve an Issue Event](https://docs.sentry.io/api/events/retrieve-an-issue-event/)) The
`event_id` path segment takes a real id or one of the literals `latest`, `oldest`,
`recommended`.

The response has an `entries` array. The exception entry is
`{"type": "exception", "data": {"values": [{"stacktrace": {"frames": [...]}}]}}`, and each
frame carries `function`, `filename`, `absPath`, `module`, `package`, `lineNo`, `colNo`,
`inApp`, `vars`, `platform`, plus source context as `context`. That last one is the shape
worth pinning down, because it is not the shape the SDK sends. Where ingest uses
`pre_context`, `context_line` and `post_context`, the read API folds all three into one array
of `[lineNumber, sourceText]` pairs:

```json
"context": [
  [69, "    // NOTE: If you are a Sentry user, and you are seeing this stack frame, it"],
  [70, "    //       is expected behavior and NOT indicative of a bug"],
  [71, "    return fn.apply(this, wrappedArguments);"],
  [72, "    // tslint:enable:no-unsafe-any"]
]
```

That is lifted from the response example in the published OpenAPI document for this endpoint.
Snake case survives nowhere in the read frames: `lineno` becomes `lineNo`, `abs_path` becomes
`absPath`, `in_app` becomes `inApp`.

Top-level the event also gives `release`, `dist`, `tags`, `contexts`, `packages`, `sdk`,
`culprit`, `platform`, `dateCreated`, `nextEventID` and `previousEventID`.

One parameter is worth the map's attention. `llmFormat` takes `json`, `markdown` or `xml`,
and the schema describes it as adding "a `formatted` field to the response with the event
rendered as the requested format for LLM consumption". Sentry built a prompt-shaped
rendering of the event and it is one query parameter away. For a kind whose whole job is
handing a crash to a triage agent, `llmFormat=markdown` is likely better than reassembling
frames ourselves. It is not on the docs page, only in the published OpenAPI document, so
treat it as real but unadvertised and confirm the output on a live project before depending
on it.

## (d) Recording on the Sentry side that a GitHub issue exists

Three options exist. One is right for this kind.

**The Sentry App external issue. Use this one.**

```
POST /api/0/sentry-app-installations/{uuid}/external-issues/
{"issueId": 1, "webUrl": "https://github.com/org/repo/issues/12", "project": "org/repo", "identifier": "12"}
```

([Create or update an External Issue](https://docs.sentry.io/api/integration/create-or-update-an-external-issue/))
Scope is `event:write`, per the published schema and per
`SentryAppInstallationExternalIssuePermission` in
`src/sentry/sentry_apps/api/bases/sentryapps.py` at `a7b4a8a`. `uuid` is the installation id
of an internal integration, and the request must be made as that app's own token: the
permission class checks `request.user.id == installation.sentry_app.proxy_user_id`.

Three properties make this the right choice. It is idempotent by construction, because
`PlatformExternalIssue` is `unique_together` on `(group, service_type)`
(`src/sentry/sentry_apps/models/platformexternalissue.py`), which is why the endpoint is
named "create **or update**". It reads back for free in `annotations` on the list call from
(a), so the fetch walk can drop already-filed groups without a second request per group. And
it works from a machine token with no human user attached, which the other two do not.

Read it back explicitly if you want to:

```
GET /api/0/organizations/{org}/issues/{issue_id}/external-issues/
```

which returns `{id, issueId, serviceType, displayName, webUrl}` per link. Or add
`expand=sentryAppIssues` (or `expand=integrationIssues`) to the list call.

**The GitHub integration link. Documented, but it wants a human.**

```
PUT /api/0/organizations/{org}/issues/{issue_id}/integrations/{integration_id}/
{"externalIssue": "org/repo#12"}
```

Scope `event:write` or `event:admin`. It is published, and it is the same thing the "Link
issue" button in the Sentry UI calls, so the link renders natively. But
`GroupIntegrationDetailsEndpoint.put` returns 400 unless `request.user.is_authenticated`, and
400 again unless the org has the issue-basic integration feature
(`src/sentry/issues/endpoints/group_integration_details.py` at `a7b4a8a`). It also needs the
numeric `integration_id`, which is another lookup. Fine for a human clicking a button, extra
moving parts for a poll loop.

**A comment on the issue. Do not.** `/api/0/issues/{id}/comments/` exists in the URL map and
GlitchTip implements it, but it is absent from Sentry's published OpenAPI document, and
`GroupNotesEndpoint.post` raises `PermissionDenied("Key doesn't have permission to create
Note")` when `request.user` is not an authenticated user. A machine token cannot leave a
comment.

**Tags are not an option at all.** `PUT` on an issue accepts `status`, `statusDetails`,
`substatus`, `assignedTo`, `hasSeen`, `isBookmarked`, `isSubscribed`, `isPublic`, `inbox`,
`priority` and the various ignore fields
([Update an Issue](https://docs.sentry.io/api/events/update-an-issue/)). Nothing arbitrary.
Tags come off events at ingest and are not writable on a group.

## Auth and scopes

The read-mostly kind wants **one user auth token with `event:read`**, plus `event:write` if it
files external issue links.

Sentry's scope vocabulary is `org:*`, `project:*`, `team:*`, `member:*` and `event:*`
([Permissions & Scopes](https://docs.sentry.io/api/permissions/)). The three that matter:

- `event:read` grants GET access to issues and events.
- `event:write` grants PUT access for updating issues, and is what the external issue POST
  checks.
- `event:admin` grants DELETE. The kind never needs it.

The published OpenAPI document confirms this end to end: the list, detail and event endpoints
all declare `auth_token: [event:admin, event:read, event:write]`, and the external issue POST
declares `event:write` alone. Notably `project:read` appears nowhere in that set. There is no
way to scope a token to one project through scopes; project scoping is a parameter on the
request, not a property of the credential.

On token type, Sentry's own guidance and its mechanics point different ways.
[Create an auth token](https://docs.sentry.io/api/guides/create-auth-token/) says Sentry
"recommends using organizational auth tokens whenever possible, as they aren't linked to
specific user accounts", and the [auth page](https://docs.sentry.io/api/auth/) notes that
"some API endpoints require an authentication token that's associated with your user account,
rather than an authentication token from an internal integration". Neither page maps token
types to endpoints. What the source settles is narrower and more useful: the external issue
POST requires the request to arrive as the Sentry App's proxy user, so an internal
integration token is not merely acceptable there, it is the only thing that works. For
reading, a user auth token is the simplest thing that will work today.

I would recommend the map treat this as one decision with two credentials only if (d) lands
on the Sentry App route. If the kind settles for the HTML marker on the GitHub side that
[#469](https://github.com/JesusFilm/phoebe/issues/469) already decided on, one `event:read`
token is the entire requirement, and the Sentry side stays read-only. Given the map already
chose "house watermark, no database", the external issue link is a nice-to-have that buys a
server-side `is:unlinked` filter and a link in the Sentry UI, at the cost of a second
credential and a Sentry App to install.

All tokens go over `Authorization: Bearer {TOKEN}`.

## Rate limits

The docs page is honest and unhelpful:
["Each endpoint has its own maximum number of requests and window size"](https://docs.sentry.io/api/ratelimits/),
with no table. It does document the headers on every response, which is the part an adapter
should actually use:

```
X-Sentry-Rate-Limit-Limit
X-Sentry-Rate-Limit-Remaining
X-Sentry-Rate-Limit-Reset             (UTC epoch seconds when the next window opens)
X-Sentry-Rate-Limit-ConcurrentLimit
X-Sentry-Rate-Limit-ConcurrentRemaining
```

The numbers are in the source. At `a7b4a8a`, each endpoint declares `enforce_rate_limit` and a
`RateLimitConfig`:

| Endpoint                                     | IP   | User | Organization |
| -------------------------------------------- | ---- | ---- | ------------ |
| `organization_group_index` (org issues list) | 10/s | 10/s | 20/s         |
| `project_group_index` (project issues list)  | 5/s  | 5/s  | 5/s          |
| `group_event_details` (the latest event)     | 15/s | 15/s | 15/s         |

That four-to-one gap between the org and project list endpoints is the strongest argument for
picking the org-scoped one, on top of its better parameters.

Two caveats. Self-hosted Sentry ships with `SENTRY_RATELIMITER_ENABLED = False` and
`SENTRY_RATELIMITER_DEFAULT = 999` in `src/sentry/conf/server.py`, so these per-endpoint
overrides only bite where the limiter is switched on, which on `sentry.io` it is. And
sentry.io runs closed-source code on top of this repo, so treat the table as the floor of what
is enforced, not a contract. Read the headers.

For scale: one list call plus one event call per new group, once per engine cycle, against a
20/s ceiling. Even a hundred fresh groups in a cycle is seven seconds of unbatched requests.
Rate limits are not a design constraint for this kind. Pagination is, if a project has
thousands of unresolved groups, which is what `statsPeriod` and a `timesSeen:` floor are for.

## GlitchTip: yes, one implementation covers it

GlitchTip serves the Sentry paths, on purpose. From its live OpenAPI document at
`https://app.glitchtip.com/api/openapi.json` (read 2026-09-05), all four reads exist under the
same paths:

```
GET /api/0/projects/{organization_slug}/{project_slug}/issues/
GET /api/0/organizations/{organization_slug}/issues/
GET /api/0/organizations/{organization_slug}/issues/{issue_id}/
GET /api/0/organizations/{organization_slug}/issues/{issue_id}/events/latest/
```

Auth is `TokenAuth`, HTTP bearer, same header. Its `IssueSchema` carries `id`, `count`,
`level`, `culprit`, `firstSeen`, `lastSeen`, `metadata`, `permalink`, `userCount`, `title`,
`shortId`, and, unlike Sentry, `firstRelease` and `lastRelease` on the list. Its
`IssueEventDetailSchema` carries `entries`, `tags`, `contexts`, `culprit`, `metadata`,
`nextEventID`, `previousEventID`.

The frames match too, and not by accident. `apps/issue_events/utils.py` on `master` renames
`in_app` to `inApp`, `abs_path` to `absPath`, `colno` to `colNo`, `lineno` to `lineNo`, and
folds `pre_context`/`context_line`/`post_context` into the same `[[lineNo, text]]` `context`
array Sentry produces. A parser written against Sentry's frames reads GlitchTip's frames
unchanged.

Four divergences an adapter has to know about:

- **No `statsPeriod`.** GlitchTip takes `start` and `end` as ISO-8601 datetimes. Compute the
  window yourself.
- **Different `sort` vocabulary.** GlitchTip's enum is `last_seen`, `first_seen`, `count`,
  `priority` and their `-` prefixed forms, defaulting to `-last_seen`. Sentry's is `date`,
  `new`, `trends`, `freq`, `user`, `inbox`, `recommended`. No overlap in spelling.
- **No `expand` or `collapse`.** Nothing to do, since the list already carries the release.
- **`query` is a plain optional string with no documented grammar.** GlitchTip's own
  [MCP docs](https://glitchtip.com/documentation/mcp/) tell you to "Use `query='is:unresolved'`
  for active issues", so at least that filter works. How much more of Sentry's grammar it
  parses, I did not verify. Do not assume `timesSeen:>10` or `is:unlinked` land.

For (d) there is nothing. GlitchTip has no `external-issues` path and no
`sentry-app-installations` at all. It does implement
`POST /api/0/organizations/{org}/issues/{issue_id}/comments/`, which is the one write that
exists on both GlitchTip and Sentry by path but not by permission, since Sentry rejects it
from a machine token. Which is another reason the map's HTML-marker watermark on the GitHub
side is the portable answer and the Sentry external issue link is a Sentry-only bonus.

GlitchTip publishes no rate limits I could find, and its API token scopes are an integer
bitfield rather than named strings. Neither matters much: token creation is a one-off human
action.

## Bugsink: no, it needs its own adapter

Bugsink is Sentry-SDK compatible on the ingest side and deliberately not Sentry compatible on
the read side. Its 2.0 API guide states the design goal plainly: "prefer clarity over
Sentry-compatibility", with "a flat layout (`/api/canonical/0/*`) to stay stable even if
relationships change" ([Bugsink 2.0: an API and minor breaking changes](https://www.bugsink.com/blog/bugsink-2.0-api/)).

From the generated reference at
[bugsink.com/docs/api-documentation](https://www.bugsink.com/docs/api-documentation/), the
reads are:

```
GET /api/canonical/0/issues/?project=<project-id>
GET /api/canonical/0/issues/{id}/
GET /api/canonical/0/events/?issue=<issue-id>
GET /api/canonical/0/events/{id}/
GET /api/canonical/0/events/{id}/stacktrace/
```

Auth is `Authorization: Bearer $BUGSINK_TOKEN` with a token an admin creates. List endpoints
use cursor pagination and you follow the `next` and `previous` URLs rather than building
cursors ([API guide](https://www.bugsink.com/docs/api/)).

Every field is named differently for the same concept. The issue object is `id`,
`friendly_id`, `project`, `digest_order`, `last_seen`, `first_seen`, `digested_event_count`,
`stored_event_count`, `calculated_type`, `calculated_value`, `transaction`, `is_resolved`,
`is_resolved_unconditionally`, `is_resolved_by_next_release`, `is_muted`. So `count` is
`digested_event_count`, `culprit` is `transaction`, and the title splits into
`calculated_type` plus `calculated_value`. There is no `level` and no release on the issue at
all, which matters for a noise floor keyed on severity. There is no
"latest event for an issue" endpoint either; list `/events/?issue=<id>` and take the newest.
Nothing anywhere records an external issue link, so (d) is a plain no.

The compensation is real, though. Bugsink returns `stacktrace_md` on the event, and honours
`Accept: text/markdown` to render "stacktrace, source context and local variables as
Markdown". Its docs warn that "the Markdown is a presentation format: it may change between
Bugsink versions and should not be parsed as a stable interface", which is exactly right for
our use, because we are not parsing it, we are pasting it into a prompt. For a triage agent,
a rendered stacktrace beats a frames array we would have to render ourselves.

## What this means for the adapter

One implementation covers Sentry and GlitchTip. Call it the Sentry-protocol adapter, give it
a base URL, an org slug, a project slug and a bearer token, and hand it a small policy object
for the four divergences above (window as `statsPeriod` or `start`/`end`, sort vocabulary,
whether `expand` exists, whether the release comes on the list). That is a handful of
branches, not a second code path.

Bugsink is a second adapter behind the same internal shape. Given that the map already chose
Sentry SaaS first and treats self-hosting as an open option, I would not build it now. The
thing worth doing now is naming the internal shape so both fit: id, title, culprit, level,
count, firstSeen, lastSeen, release, permalink, and a rendered stacktrace string. Both
collectors can fill that. Neither's native field names should leak past the adapter, because
if they do, the Bugsink port turns into a rewrite of the triage prompt rather than one new
file.

The other conclusion I would carry to
[#471](https://github.com/JesusFilm/phoebe/issues/471): the release for a new group is best
read off the latest event, not the group detail. It saves a call per group, it is the release
the crash actually happened on rather than a first/last pair, and it is the one field that
Sentry, GlitchTip and Bugsink disagree about most on the group object.

## What I could not verify

- Whether `llmFormat=markdown` output is good enough to feed a triage agent directly. It is in
  the published OpenAPI document and absent from the docs pages. Confirm on a live project.
- Whether GlitchTip's `query` parameter parses more than `is:unresolved`. Its OpenAPI schema
  types it as a bare optional string with no description, and I did not find the parser in the
  source tree.
- Whether sentry.io enforces the per-endpoint limits in the OSS repo unchanged. The
  closed-source layer could differ. Reading the response headers makes this moot.
- Sentry's concurrent request limits. The headers exist, the numbers are not in the OSS
  settings I read.
