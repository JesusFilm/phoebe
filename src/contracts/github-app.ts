// A GitHub App created from the setup steps, through GitHub's manifest flow.
//
// The App arm (docs/github-app-mode.md) replaces a hand-minted token per
// tenant with one App whose installation tokens the bootstrapper mints. The
// manifest flow is GitHub's way of registering an App without filling the
// form by hand: the companion posts the name and the five permissions, GitHub
// shows one confirm page, and the companion receives the App's id and private
// key straight back. That key goes into the deployment `.env` and nowhere
// else; this type names the App and never carries the key.

/** What the operator asks for: the App's name and whose it will be. */
export type GithubAppRequest = {
  /** The user or organisation that will own the App, which is the repositories' owner. */
  owner: string;
  /** GitHub App names are unique across GitHub, so this is the operator's to pick. */
  name: string;
};

/** The App, once GitHub has it. */
export type GithubAppCreated = {
  /** The numeric id, as `GH_APP_ID` now holds it. */
  id: string;
  /** The slug GitHub gave the name. */
  slug: string;
  name: string;
  owner: string;
  /** The App's page on GitHub. */
  htmlUrl: string;
  /** Where the operator installs it on the repositories Phoebe serves. */
  installUrl: string;
  /** The deployment `.env` the id and key were written into. */
  envFile: string;
};
