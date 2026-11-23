---
"phoebe-agent": minor
---

`dependency-security` now closes an open routed issue it no longer plans. Before, such an issue kept the routing label and its slot in `prConcurrentLimit`, and the `dependencies` kind could still claim it with nothing to do. The scan rewrites the body to list no rows, comments with the reason for each package, and closes it. The emptied body vetoes nothing, so a row that needs a fix again is filed as a new issue.

This happens when the fix landed outside the issue's own PR, when every advisory is under `minSeverity` after you raised it, and when only a transitive package with no fix released is left. Those three wait for a second scan in a row to agree, and only count on a scan where every source finished and answered in full. An issue with a run or a PR in flight is left alone, and so is one without the routing label.

If you raise `minSeverity`, or took the `dev: "critical"` default, expect open issues that fall under it to close within two scans.

Switching to `transitive: "individual"` with a bundle issue open no longer strands it. The next scan closes the bundle and files its rows per package.
