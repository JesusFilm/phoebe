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

import { ArrowLeft } from "lucide-react";
import type { DesktopBridge, LocalInstall, LocalReportEvent } from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import { ConfigSpace } from "./config-form.tsx";
import { ConfigEditForm } from "./install-page.tsx";
import { tenantConfigs } from "./local-install.ts";
import { receiptOfRun, useInstallRun } from "./verb-run.ts";

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
  const { run, running, trouble, start } = useInstallRun(bridge, install.dir);
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
      </div>
    </main>
  );
}
