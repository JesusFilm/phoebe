// Where an install's deployment files are: at the folder's root, or one level
// down in `.phoebe/`.
//
// A repository can be two things at once. Its root `phoebe.config.ts` is the
// tenant entry a workspace one directory up discovers, and `.phoebe/` beside it
// is a whole standalone deployment — config, `.env`, `container/` — that runs
// the repo solo (`configDir` in docs/configuration.md; this repo's own
// `.phoebe/` is one). Read as a folder, such a repo looked like a workspace
// child with nothing to drive, and the companion said so. The deployment was
// there the whole time, one folder down.
//
// So the install is the folder the operator picked, and its deployment root is
// whichever of the two carries `container/compose.yml`: the root first, because
// a stock `phoebe init` puts it there, and `.phoebe/` when the root has none.
// Everything Compose-shaped — the compose file, the `.env`, the Dockerfile pin,
// the config the container mounts — is read from the root this names. `init`
// is the one verb that keeps the folder itself: it scaffolds a deployment where
// there is none.

import { existsSync } from "node:fs";
import path from "node:path";
import { COMPOSE_REL_PATH } from "../../../src/deployment-compose.ts";

/** The subfolder a repo keeps its standalone deployment in. */
export const NESTED_DEPLOYMENT_DIR = ".phoebe";

export type DeploymentDir = {
  /** The directory the deployment's files are read from. */
  dir: string;
  /** `.phoebe` when the deployment is nested there, null when it is the root. */
  nested: string | null;
};

/** The deployment root for an install at `installDir`. */
export function deploymentDirOf(
  installDir: string,
  exists: (file: string) => boolean = existsSync,
): DeploymentDir {
  if (exists(path.join(installDir, COMPOSE_REL_PATH))) return { dir: installDir, nested: null };
  const nested = path.join(installDir, NESTED_DEPLOYMENT_DIR);
  if (exists(path.join(nested, COMPOSE_REL_PATH))) {
    return { dir: nested, nested: NESTED_DEPLOYMENT_DIR };
  }
  return { dir: installDir, nested: null };
}
