// Packaging the companion (#525 §1, §2).
//
// Three platforms, one config, and CI runs it once per runner after
// `changeset publish` has pushed the `phoebe-agent@x.y.z` tag: mac arm64 as a
// dmg and a zip, win x64 as an NSIS installer, linux x64 as an AppImage. What
// each runner builds is its own platform, which is why nothing here names a
// `--mac`/`--win`/`--linux` flag; the three target blocks say what that
// platform produces.
//
// **Everything ships unsigned this effort** (#525 §2). No `cscLink`, no
// notarisation, no certificate in a secret: obtaining an Apple Developer ID and
// a Windows certificate for JesusFilm is a task of its own, and until it lands
// the macOS build carries the Gatekeeper workaround in its docs and the
// companion's updater stays off on that platform (src/updates.ts).
//
// A JavaScript config rather than YAML for one reason: the apps carry no version
// of their own (#521 §4). The root package's version is read here and injected
// into the packaged `package.json`, so `app.getVersion()`, the artifact names and
// the update metadata all say the same `x.y.z` the npm release and the git tag do.

const { readFileSync } = require("node:fs");
const path = require("node:path");

const { version } = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);

module.exports = {
  appId: "org.jesusfilm.phoebe",
  productName: "Phoebe",
  extraMetadata: { version },

  // Not `dist/`: that is where Vite writes main and preload, and electron-builder
  // would empty it out from under them.
  directories: { output: "release" },

  // The app is the two built entry points and the manifest that names them.
  // Production dependencies come along on their own — `electron-updater` is the
  // only one, and it has to be a real file on disk rather than a bundled copy
  // (vite.config.ts says why).
  files: ["dist/**", "package.json"],

  // What main looks for beside the executable rather than inside the asar:
  // the console bundle it loads over the `phoebe://` scheme (main.ts's
  // `consoleBundleDir`), and the engine resources `init` writes into a folder
  // (verb-dispatch.ts's `packageRoot`). Both are directories the app reads at
  // run time and neither is JavaScript, so neither belongs in the bundle.
  extraResources: [
    { from: "../../console", to: "console" },
    { from: "../../templates", to: "phoebe-agent/templates" },
    { from: "../../prompts", to: "phoebe-agent/prompts" },
  ],

  // The feed a build carries with it, and the one the companion overrides at
  // check time when it is following a relay (src/update-feed.ts). `generic`
  // against GitHub's own redirect to the newest stable release, because the
  // `github` provider reads a tag as a version and this repo's tags are
  // `phoebe-agent@x.y.z`. Declaring a provider at all is also what makes
  // electron-builder write the `latest*.yml` the updater reads.
  publish: {
    provider: "generic",
    url: "https://github.com/JesusFilm/phoebe/releases/latest/download",
  },

  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    category: "public.app-category.developer-tools",
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  linux: {
    target: [{ target: "AppImage", arch: ["x64"] }],
    category: "Development",
    // Named, because the default is derived from the package name and AppImage
    // refuses an executable called `@phoebedesktop` outright.
    executableName: "phoebe",
  },
};
