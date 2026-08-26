---
"phoebe-agent": minor
---

Upgrade TypeScript from 5.x to 7.0.2, the stable native Go compiler. The typecheck CI gate now runs the Go-based `tsc`, which is ~10× faster than the old compiler. No source changes were needed — `erasableSyntaxOnly`, which the codebase already enforced, is exactly what TypeScript 7 assumes. `vite-plus` is bumped to `0.3.0` alongside it, as that release adds TypeScript 7 to the peer-dependency range.
