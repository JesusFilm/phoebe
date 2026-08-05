import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
};

export default config;
