---
"phoebe-agent": minor
---

A config opens as a form. The config tab lists the settings a file can carry, one row each with its own Save: a text box, a number box, or a choice for the settings with a closed set of values. An unset row shows what applies without it, and every row names the `PHOEBE_*` variable that outranks the file. A value the file computes is shown as written and left alone. The file's text, and the form that names a path by hand, are the second view, behind a Form and File switch. A workspace's tenants each get the same pair. A config that will not parse opens on the file.

The companion reads the settings off the config's source, never by loading it, and hands them over beside the text as `configFields`.
