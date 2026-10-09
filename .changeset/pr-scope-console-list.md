---
"phoebe-agent": minor
---

`phoebe config set` and the config-edit contract now carry a list of strings beside the literals, so a `prScope` of branch prefixes can be set without opening the file: `phoebe config set prScope '["renovate/"]'`, or the companion's config form, where the pull-request-scope select has a third item called **prefixes**. Picking it reveals a box that takes the prefixes comma-separated, open on your own `branchPrefix` so the value `"phoebe"` stands for is there to edit; entries are trimmed, blanks dropped, and an empty box saves `[]`. A config that already holds a list opens on that item with the box filled. A list holding anything but strings is refused naming the element. The form learns which fields take a list from the settings catalogue, so nothing in it names `prScope`.
