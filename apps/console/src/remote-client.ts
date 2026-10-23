// The **remote client** — the one seam between a remote route's pages and the
// deployment API (map #690; the relay's `relay-client.ts` narrowed to one
// deployment per client).
//
// Every write a remote page makes goes through here and nothing calls the
// bridge's `request` anywhere else. Main adds the bearer; this adds the
// paths, the bodies and the reading of what came back. A 403 is turned into
// the one sentence the page shows beside a disabled control, and a 401 is left
// to the supervisor, which has already marked the record blocked by the time
// a page sees it.

import { REMOTE_ROUTES } from "phoebe-agent/contracts";
import type {
  ConfigEditValue,
  DesktopBridge,
  DoctorRunResponse,
  EditReceipt,
  RemoteResponse,
  SessionRow,
} from "phoebe-agent/contracts";
import { NEEDS_OPERATE } from "./remote-routes.ts";

/** What `/api/secrets` answered. */
export type RemoteSecretReceipt = {
  outcome: "written" | "refused";
  tenant: string;
  key: string;
  editId?: string;
  detail: string;
};

/** A request the deployment turned down, with its status and what it said. */
export class RemoteRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(messageFor(status, body));
    this.name = "RemoteRequestError";
    this.status = status;
    this.body = body;
  }
}

function messageFor(status: number, body: unknown): string {
  if (status === 403) return NEEDS_OPERATE;
  if (status === 401) return "the session no longer works here — pair again";
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? `${status} ${error}` : `the deployment answered ${status}`;
}

export type RemoteClient = {
  /** Set one field of the root config. The receipt is the deployment's own; a refusal is still an answer. */
  configSet: (edit: {
    path: string;
    value: ConfigEditValue;
    fingerprint: string;
  }) => Promise<EditReceipt>;
  /** Ask the deployment to run doctor. What it finds arrives as the next report. */
  doctorRun: () => Promise<DoctorRunResponse>;
  /** Set or clear one tenant secret. The value goes in the body and nowhere else. */
  secretSet: (input: {
    tenant: string;
    key: string;
    value: string | null;
  }) => Promise<RemoteSecretReceipt>;
  /** Every session the deployment holds, and which is this one. */
  sessions: () => Promise<{ sessions: SessionRow[]; self: string }>;
};

export function createRemoteClient(bridge: DesktopBridge, deploymentId: string): RemoteClient {
  const send = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<RemoteResponse> => {
    const response = await bridge.remotes.request(deploymentId, {
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
    if (response.status >= 400) throw new RemoteRequestError(response.status, response.body);
    return response;
  };

  return {
    async configSet(edit) {
      const response = await send("POST", REMOTE_ROUTES.configSet, {
        id: editId(),
        path: edit.path,
        value: edit.value,
        fingerprint: edit.fingerprint,
      });
      return (response.body as { receipt: EditReceipt }).receipt;
    },
    async doctorRun() {
      const response = await send("POST", REMOTE_ROUTES.doctorRun, {});
      return response.body as DoctorRunResponse;
    },
    async secretSet(input) {
      const response = await send("POST", REMOTE_ROUTES.secrets, input);
      return response.body as RemoteSecretReceipt;
    },
    async sessions() {
      const response = await send("GET", REMOTE_ROUTES.sessions);
      return response.body as { sessions: SessionRow[]; self: string };
    },
  };
}

/** A fresh edit id: the same id twice is the same edit, so each press is its own. */
function editId(): string {
  return `edit_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The one line a thrown request reads as. */
export function requestTrouble(error: unknown): string {
  if (error instanceof RemoteRequestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
