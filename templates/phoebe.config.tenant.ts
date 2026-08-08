// Per-tenant Phoebe config — scaffolded by `phoebe add-repo` or `phoebe init --tenant`.
//
// One tenant of a multi-tenant deployment. The shared engine source and
// fleet-global knobs live in the deployment-root phoebe.config.ts, not here.
// The written repoSlug is authoritative for workspace discovery (#85).
import type { PhoebeUserConfig } from {{CLI_BIN}};

const config: PhoebeUserConfig = {
  repoSlug: {{REPO_SLUG}},
  repoUrl: {{REPO_URL}},
  installCommand: {{INSTALL_COMMAND}},
  checkCommand: {{CHECK_COMMAND}},
  testCommand: {{TEST_COMMAND}},
};

export default config;
