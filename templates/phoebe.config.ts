// Phoebe consumer config — scaffolded by `phoebe init`.
//
// Only these five fields are required. Everything else has a shipped default
// (see the `PhoebeUserConfig` type). Add overrides here only when you need
// them; `phoebe-agent` upgrades pick up new defaults automatically.

import { defineConfig } from "{{CLI_BIN}}";

export default defineConfig({
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  installCommand: "{{INSTALL_COMMAND}}",
  checkCommand: "npm run check",
  testCommand: "npm test",
});
