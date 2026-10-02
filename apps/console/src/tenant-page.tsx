// One tenant's config, on a page of its own.
//
// A workspace root's config and a tenant's are different files saying different
// things: the root names the engine and the fleet, a tenant says what one
// repository's work looks like. So a tenant is not a section of the workspace's
// config tab. It is somewhere to go, from the gear on its row in the rail or
// from the list on the workspace's config tab, and the way back is on the page.
//
// The edits are `config set` runs on the workspace's install with the tenant
// named, so the run, its refusal and its receipt are the install's.

import { ArrowLeft, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type {
  DesktopBridge,
  LocalInstall,
  LocalReportEvent,
  RepairOutcome,
  TenantEnvFacts,
} from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import { ConfigSpace } from "./config-form.tsx";
import { HarnessSection } from "./harness-section.tsx";
import { ConfigEditForm } from "./install-page.tsx";
import { tenantConfigs, tenantEnv } from "./local-install.ts";
import { receiptOfRun, refusalText, useInstallRun } from "./verb-run.ts";

export function TenantPage({
  install,
  tenant,
  bridge,
  report,
  onWorkspace,
}: {
  /** The workspace the tenant is a child of. */
  install: LocalInstall;
  /** The tenant's folder. */
  tenant: string;
  bridge: DesktopBridge;
  /** The last read main emitted for the workspace, or null before the first. */
  report: LocalReportEvent | null;
  /** Back to the workspace's own config. */
  onWorkspace: () => void;
}) {
  const { run, running, trouble, start, rebuild } = useInstallRun(bridge, install.dir);
  const found = tenantConfigs(report).find((candidate) => candidate.dir === tenant) ?? null;
  const child = install.workspace?.children.find((candidate) => candidate.dir === tenant);
  const label = found?.label ?? child?.slug ?? child?.name ?? tenant;

  return (
    <main className="main tenant-page">
      <div className="page-body">
        <div className="install-title">
          <h1>{label}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="tenant-back"
            title={`The config of ${install.name}`}
            onClick={onWorkspace}
          >
            <ArrowLeft aria-hidden="true" />
            {install.name}
          </Button>
        </div>
        <p className="muted">
          A tenant of <strong>{install.name}</strong>. Its config says what this repository&apos;s
          work looks like; the workspace&apos;s says which engine runs and where the fleet is.
        </p>
        <EnvAccess
          install={install}
          tenant={tenant}
          bridge={bridge}
          env={tenantEnv(report, tenant)}
        />
        <section>
          <h2>Config</h2>
          {found === null ? (
            <p className="muted">
              {/* A child the workspace lists is one whose read has not landed yet. */}
              {report === null || child !== undefined
                ? "Reading the config…"
                : "This workspace has no such tenant."}
            </p>
          ) : found.config.kind === "absent" ? (
            <p className="muted">
              No <code>phoebe.config.ts</code> at <span className="mono">{found.config.path}</span>.
            </p>
          ) : (
            <>
              <ConfigSpace
                install={install}
                config={found.config}
                running={running}
                receipt={receiptOfRun(run, found.config.path)}
                onStart={start}
                tenant={tenant}
                label={label}
                file={
                  <ConfigEditForm
                    install={install}
                    config={found.config}
                    running={running}
                    receipt={receiptOfRun(run, found.config.path)}
                    onStart={start}
                    tenant={tenant}
                  />
                }
              />
            </>
          )}
          {trouble === null ? null : <p className="refusal">{trouble}</p>}
        </section>
        <HarnessSection
          install={install}
          bridge={bridge}
          event={report}
          tenant={tenant}
          busy={running}
          onRebuild={() => rebuild(install.state === "running")}
        />
      </div>
    </main>
  );
}

/**
 * The warning a tenant's page opens on when the container cannot read its
 * `.env`, and the button that puts it right.
 *
 * The tenant itself never says this. It starts with no credentials and reports
 * a missing GitHub token or App key, which sends an operator to check a token
 * that is fine. So the page says the cause, where the operator is already
 * looking, and offers the one change that fixes it. What main did is kept on
 * screen after the read that follows it has cleared the warning: the fix is a
 * change to who may open a secrets file, and that should not vanish unsaid.
 */
function EnvAccess({
  install,
  tenant,
  bridge,
  env,
}: {
  install: LocalInstall;
  tenant: string;
  bridge: DesktopBridge;
  env: TenantEnvFacts | null;
}) {
  const [fixing, setFixing] = useState(false);
  const [outcome, setOutcome] = useState<RepairOutcome | null>(null);
  const fix = () => {
    setFixing(true);
    bridge.installs
      .repair(install.dir, { kind: "env-access", tenant })
      .then(setOutcome, (error: unknown) =>
        setOutcome({ fixed: false, detail: refusalText(error) }),
      )
      .finally(() => setFixing(false));
  };

  if (outcome?.fixed === true) {
    return (
      <p className="receipt written" role="status">
        {outcome.detail}
        {install.state === "running"
          ? ` Restart ${install.name} for the tenant to start with it.`
          : null}
      </p>
    );
  }
  if (env?.access !== "unreadable") return null;
  return (
    <section className="fixable" aria-label="The container cannot read this tenant's .env">
      <h2>
        <TriangleAlert size={15} aria-hidden="true" />
        The container cannot read this tenant&apos;s .env
      </h2>
      <p>
        The workspace&apos;s container runs as its own unprivileged user, and{" "}
        <span className="mono">{env.path}</span> is readable by its owner alone. The tenant starts
        with none of what is in it, and reports that as a missing GitHub token or App key.
      </p>
      <Button size="sm" disabled={fixing} onClick={fix}>
        {fixing ? "Fixing…" : "Let the container read it"}
      </Button>
      <p className="muted">
        Gives that one user read access to the file. Nobody else gains anything, and the file is not
        otherwise changed.
      </p>
      {outcome === null ? null : <p className="refusal">{outcome.detail}</p>}
    </section>
  );
}
