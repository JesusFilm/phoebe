---
"phoebe-agent": patch
---

A stopped install's page no longer opens with a line saying nothing is running and config is the only tab with anything in it. The tabs that need a container are greyed and say so on hover, the start shortcut is on the rail, and the install tab is one click away; the sentence was noise on every stopped install.

A WSL install's install tab no longer carries a Docker section: the paragraph saying Docker is asked inside the distro through wsl.exe said nothing the rail and the verbs do not already say when it matters.

A workspace's config tab has a config space per tenant under the root's: each child's `phoebe.config.ts` as its folder holds it, with the same one-field edit form pointed at it. The desktop reads the children's configs beside the root's on every read, and a `config set` may name a child by its folder; a folder outside the install, or one with no config, is refused before anything is read.
