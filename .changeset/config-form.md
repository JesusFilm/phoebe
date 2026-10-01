---
"phoebe-agent": minor
---

A config opens as a form. The config tab lists the settings a file can carry, one row each with its own Save: a text box, a number box, or a choice for the settings with a closed set of values, drawn by the console so the list follows its theme rather than the OS. A text setting with values worth offering, the model, the effort, the default branch, opens a list of them and takes whatever is typed. Each row is named for a person, Repository rather than `repoSlug`, with the path beside it and a sentence on what the setting decides; an unset row shows what applies without it. A value the file computes is shown as written and left alone. The file's text, and the form that names a path by hand, are the second view, behind a Form and File switch. Which rows a form has depends on whose config it is. A workspace root has the deployment's few: the engine, the fleet, shown and locked with the reason, and reporting. Where the engine comes from is a choice, its repository and its ref are boxes that offer values and take any, and saving the ref runs `upgrade` on the engine, so the new ref's migrations run with the move. Each tenant has its own repository's settings, on a page of its own: the workspace's config tab lists its tenants, each row the way in, and every child on the rail carries a gear that goes to the same page. The page names the workspace it belongs to and has the way back. A solo install's one config has both, under a heading each. A config that will not parse opens on the file.

The companion reads the settings off the config's source, never by loading it, and hands them over beside the text as `configFields`.

A folder that is a workspace child, a tenant config and no deployment of its own, is no longer offered init over the top of it. Adding one opens its install tab on the offer to run it on its own too: `init --solo` into `.phoebe/` under the folder, the tenant's settings carried onto the new config, the tenant entry pointed at that folder for its `.env` and prompts, and a root `.env` copied down. The folder stays a tenant. Forget now asks first, on every install.

A form no longer goes stale after a save. A run that ends, and coming back to the window, both read the install again, so a row shows the value that landed and the next edit is checked against the file as it now is.

`config set` takes a list of closed leaves a caller on the same disk may write by exact path. The companion opens `engine.source` and `engine.repo` with it; `engine.ref` stays closed to `config set` on every arm.
