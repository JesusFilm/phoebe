---
"phoebe-agent": minor
---

A config opens as a form. The config tab lists the settings a file can carry, one row each with its own Save: a text box, a number box, or a choice for the settings with a closed set of values. An unset row shows what applies without it, and every row names the `PHOEBE_*` variable that outranks the file. A value the file computes is shown as written and left alone. The file's text, and the form that names a path by hand, are the second view, behind a Form and File switch. Which rows a form has depends on whose config it is. A workspace root has the deployment's few: the engine and the fleet, shown and locked with the reason, and reporting, which it can change. Each tenant has its own repository's settings, on a page of its own: the workspace's config tab lists its tenants, each row the way in, and every child on the rail carries a gear that goes to the same page. The page names the workspace it belongs to and has the way back. A solo install's one config has both, under a heading each. A config that will not parse opens on the file.

The companion reads the settings off the config's source, never by loading it, and hands them over beside the text as `configFields`.
