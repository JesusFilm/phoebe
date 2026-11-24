// PROTOTYPE — throwaway, map #914 ticket #919. Not production code.
//
// A fake desktop bridge so the real console (rail, install page, tabs) runs in
// a plain browser with one running install and a two-pipeline report.

import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts";
import type { DesktopBridge } from "phoebe-agent/contracts";
import { bridge, cell, child, directory, install, report, tenant } from "../test-fixture.ts";

const iso = (secondsAgo: number): string => new Date(Date.now() - secondsAgo * 1000).toISOString();

export function prototypeBridge(): DesktopBridge {
  const facts = install({ addedAt: iso(86_400 * 20) });
  const theTenant = tenant({ id: "/etc/phoebe", slug: "JesusFilm/youtube-studio" });
  const body = report({
    bootstrapper: {
      engineRef: "v0.13.0",
      engineSha: "dd6f67d",
      quarantinedSha: null,
      crashLoop: { lastGoodSha: "dd6f67d", failingSha: null, failureCount: 0 },
      reconcile: { phase: "idle", since: iso(3600) },
      children: [
        child({ id: "/etc/phoebe#work", since: iso(3 * 3600), lastPassAt: iso(60) }),
        child({ id: "/etc/phoebe#intake", since: iso(3 * 3600), lastPassAt: iso(60) }),
      ],
      slots: { capacity: 2, inUse: 1, waiting: 0, overGranted: 0, floorBudget: 0 },
      updatedAt: iso(20),
    },
    fleet: {
      tenants: [theTenant],
      cells: [
        cell({ id: "/etc/phoebe#work", tenant: theTenant, pipeline: "work", concurrency: 2 }),
        cell({
          id: "/etc/phoebe#intake",
          tenant: theTenant,
          pipeline: "intake",
          state: "idle",
          concurrency: 1,
        }),
      ],
      updatedAt: iso(20),
    },
    updatedAt: iso(20),
  });
  return bridge({
    installs: [facts],
    reports: [
      {
        type: "report",
        install: facts.dir,
        at: iso(2),
        facts,
        directory: directory(),
        report: { schema: DEPLOYMENT_SCHEMA, receivedAt: iso(2), report: body },
      },
    ],
    logs: ["[youtube-studio:JesusFilm/youtube-studio:work] PROTOTYPE: fake console lines"],
  });
}
