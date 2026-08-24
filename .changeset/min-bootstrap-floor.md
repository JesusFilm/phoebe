---
"phoebe-agent": minor
---

Engines can now declare a minimum bootstrapper version via `phoebe.minBootstrap` in their `package.json`. Boot reads the field after checkout and throws immediately if the running launcher falls below the floor, naming both versions and the steps to fix it. Engines whose `package.json` is absent, unparseable, or missing the field keep working with any launcher.
