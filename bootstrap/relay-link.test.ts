// The deployment's side of the handshake, driven through a fake socket: what it
// sends when, what it does with each refusal, how long it waits before dialling
// again, what the report says while it is doing it, and what it answers when a
// console asks it to run doctor.
//
// Nothing here opens a real connection. The socket seam is one function, so the
// test is the far side of it — which is also how the close codes get exercised,
// since half of them are refusals a healthy relay never sends. The two timers
// are a seam too, and they are named, so a test can fire the silence watchdog
// without guessing which pending timer it is.

import { describe, expect, test } from "vite-plus/test";
import {
  RELAY_CLOSE,
  RELAY_DARK_AFTER_MS,
  RELAY_DOCTOR_RUN,
  RELAY_MESSAGES,
  RELAY_PROTOCOL,
} from "../src/contracts/relay-protocol.ts";
import { verifyHelloSignature } from "../src/ed25519.ts";
import type { ConfigEdit, EditReceipt } from "../src/contracts/config-edit.ts";
import type { DeploymentReport } from "../src/contracts/deployment.ts";
import type { RelayStatus } from "./deployment-state.ts";
import { generateDeploymentKey, type DeploymentKey } from "./relay-key.ts";
import {
  connectRelay,
  parseConfigSet,
  PROTOCOL_RETRY_MS,
  RECONNECT_CAP_MS,
  RECONNECT_FIRST_MS,
  reconnectDelayMs,
  type DoctorRunAnswer,
  type InboundRequest,
  type RelaySocketHandlers,
  type RelayTimer,
  type RequestAnswer,
} from "./relay-link.ts";

const NONCE = Buffer.from("nonce-from-the-relay").toString("base64url");

/** One dial, as the link drove it. */
type Dialled = {
  url: string;
  handlers: RelaySocketHandlers;
  sent: string[];
  closed: boolean;
};

/** One timer the link is waiting on. Removed from the list when it is cleared. */
type Timer = { ms: number; kind: RelayTimer; fire: () => void };

type Harness = {
  dials: Dialled[];
  statuses: RelayStatus[];
  saved: DeploymentKey[];
  forgotten: true[];
  /** Every timer still pending, in the order they were set. */
  timers: Timer[];
  logs: string[];
  warnings: string[];
  /** Answer the newest dial with a challenge, as a relay does on open. */
  challenge: (protocol?: number) => void;
  /** Send one frame from the relay to the newest dial. */
  deliver: (frame: unknown) => void;
  /** Close the newest dial. */
  close: (code: number, reason?: string) => void;
  /** The pending retry, and the pending silence watchdog. */
  retry: () => Timer | undefined;
  watchdog: () => Timer | undefined;
  /** Run the pending retry. */
  elapse: () => void;
  /** Let the silence watchdog fire: a minute with nothing inbound. */
  goQuiet: () => void;
  last: () => RelayStatus;
  hello: () => Record<string, unknown>;
  /** Every report frame the newest dial has sent, oldest first. */
  reports: () => Array<Record<string, unknown>>;
  /** Every receipt the newest dial has written, oldest first (#546). */
  receipts: () => Array<Record<string, unknown>>;
  /** Who this link was asked to run doctor for, in order. */
  asked: string[];
  /** The report the model would hand over next. */
  setReport: (report: DeploymentReport | null) => void;
  /** The model wrote a report: the cue boot gives the link. */
  push: () => void;
  /** Every request the answerer was handed. */
  requests: InboundRequest[];
  stop: () => void;
};

function harness(
  overrides: {
    key?: DeploymentKey | null;
    pairingToken?: string;
    protocol?: number;
    report?: DeploymentReport | null;
    /** The pen behind the link, or absent for a link built without one. */
    onConfigSet?: (edit: ConfigEdit) => Promise<EditReceipt>;
    /** Omitted on purpose by the test for a link with no doctor behind it. */
    doctorRun?: (by: string) => DoctorRunAnswer;
    /** Absent means the link is built with no answerer at all. */
    answer?: (request: InboundRequest) => Promise<RequestAnswer>;
  } = {},
): Harness {
  const dials: Dialled[] = [];
  const statuses: RelayStatus[] = [];
  const saved: DeploymentKey[] = [];
  const forgotten: true[] = [];
  const timers: Timer[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  let clock = 1_000_000;
  let report: DeploymentReport | null = overrides.report ?? null;
  const asked: string[] = [];
  const requests: InboundRequest[] = [];

  const drop = (timer: Timer): void => {
    const at = timers.indexOf(timer);
    if (at >= 0) timers.splice(at, 1);
  };

  const link = connectRelay({
    url: "wss://relay.example.com/deployments",
    name: "acme/widget",
    key: overrides.key === undefined ? null : overrides.key,
    ...(overrides.pairingToken !== undefined ? { pairingToken: overrides.pairingToken } : {}),
    ...(overrides.protocol !== undefined ? { protocol: overrides.protocol } : {}),
    mintKey: generateDeploymentKey,
    saveKey: (key) => {
      saved.push(key);
    },
    forgetKey: () => {
      forgotten.push(true);
    },
    onStatus: (status) => statuses.push(status),
    ...(overrides.answer === undefined
      ? {}
      : {
          onRequest: (request: InboundRequest) => {
            requests.push(request);
            return overrides.answer!(request);
          },
        }),
    report: () => report,
    ...(overrides.onConfigSet !== undefined ? { onConfigSet: overrides.onConfigSet } : {}),
    ...(overrides.doctorRun !== undefined
      ? {
          onDoctorRun: (by: string) => {
            asked.push(by);
            return overrides.doctorRun!(by);
          },
        }
      : {}),
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    open: (url, handlers) => {
      const dial: Dialled = { url, handlers, sent: [], closed: false };
      dials.push(dial);
      return {
        send: (data) => dial.sent.push(data),
        close: () => {
          dial.closed = true;
        },
      };
    },
    now: () => clock,
    setTimer: (fire, ms, kind) => {
      const timer: Timer = { ms, kind, fire };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => drop(handle as Timer),
    random: () => 0.5,
  });

  const newest = (): Dialled => dials[dials.length - 1]!;
  const pending = (kind: RelayTimer): Timer | undefined => timers.find((t) => t.kind === kind);
  const run = (kind: RelayTimer): void => {
    const timer = pending(kind)!;
    drop(timer);
    clock += timer.ms;
    timer.fire();
  };

  return {
    dials,
    statuses,
    saved,
    forgotten,
    timers,
    logs,
    warnings,
    challenge: (protocol = RELAY_PROTOCOL) => {
      newest().handlers.onOpen();
      newest().handlers.onMessage(
        JSON.stringify({ type: RELAY_MESSAGES.challenge, nonce: NONCE, protocol }),
      );
    },
    deliver: (frame) => {
      newest().handlers.onMessage(typeof frame === "string" ? frame : JSON.stringify(frame));
    },
    close: (code, reason = "") => {
      clock += 1_000;
      newest().handlers.onClose(code, reason);
    },
    retry: () => pending("retry"),
    watchdog: () => pending("silence"),
    elapse: () => run("retry"),
    goQuiet: () => run("silence"),
    last: () => statuses[statuses.length - 1]!,
    hello: () => JSON.parse(newest().sent[0]!) as Record<string, unknown>,
    reports: () =>
      newest()
        .sent.map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .filter((frame) => frame["type"] === RELAY_MESSAGES.report),
    receipts: () =>
      newest()
        .sent.map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .filter((frame) => frame["type"] === RELAY_MESSAGES.receipt),
    asked,
    setReport: (next) => {
      report = next;
    },
    push: () => link.push(),
    requests,
    stop: () => link.stop(),
  };
}

describe("dialling", () => {
  test("the deployment says nothing until the relay challenges it", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.dials[0]!.handlers.onOpen();
    expect(relay.dials[0]!.sent).toEqual([]);
  });

  test("a configured relay reports `reconnecting` from the first dial", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    expect(relay.statuses[0]).toMatchObject({ configured: true, state: "reconnecting" });
  });
});

describe("a first pairing", () => {
  test("spends the token, names the deployment, and carries no signature", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    expect(relay.hello()).toMatchObject({
      type: RELAY_MESSAGES.hello,
      protocol: RELAY_PROTOCOL,
      name: "acme/widget",
      pairingToken: "mint-fresh",
    });
    expect(relay.hello()["signature"]).toBeUndefined();
  });

  test("the key it presents is the key it saves", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    expect(relay.saved).toHaveLength(1);
    expect(relay.hello()["publicKey"]).toBe(relay.saved[0]!.publicKey);
  });

  test("a refused pairing takes the key back off the volume", () => {
    const relay = harness({ pairingToken: "mistyped" });
    relay.challenge();
    expect(relay.saved).toHaveLength(1);
    relay.close(RELAY_CLOSE.tokenSpent, "token-spent");
    expect(relay.forgotten).toHaveLength(1);
  });

  test("a dropped socket is not a refusal — the key stays, the token is gone", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    relay.close(1006);
    expect(relay.forgotten).toEqual([]);
  });

  test("a later refusal does not take a key an earlier pairing earned", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    relay.close(1006);
    relay.elapse();
    relay.challenge();
    relay.close(RELAY_CLOSE.unlinked, "unlinked");
    expect(relay.forgotten).toEqual([]);
  });

  test("and it reports connected once the hello is away", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    expect(relay.last()).toMatchObject({ state: "connected", nextRetryAt: null });
  });

  test("the token is spent once — a reconnect signs instead", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    relay.close(1006);
    relay.elapse();
    relay.challenge();
    const second = JSON.parse(relay.dials[1]!.sent[0]!) as Record<string, unknown>;
    expect(second["pairingToken"]).toBeUndefined();
    expect(typeof second["signature"]).toBe("string");
  });
});

describe("a deployment that has already paired", () => {
  test("signs the relay's nonce with the key on its volume", () => {
    const key = generateDeploymentKey();
    const relay = harness({ key });
    relay.challenge();
    const hello = relay.hello();
    expect(hello["publicKey"]).toBe(key.publicKey);
    expect(
      verifyHelloSignature(
        key.publicKey,
        { nonce: NONCE, boxKey: key.boxKey },
        hello["signature"] as string,
      ),
    ).toBe(true);
  });

  test("saves nothing — the key is already where it belongs", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    expect(relay.saved).toEqual([]);
  });

  test("and ignores a pairing token still sitting in the environment", () => {
    const key = generateDeploymentKey();
    const relay = harness({ key, pairingToken: "left-in-dot-env" });
    relay.challenge();
    expect(relay.hello()["pairingToken"]).toBeUndefined();
    expect(relay.logs.join("\n")).toContain("PHOEBE_RELAY_TOKEN is ignored");
  });
});

describe("a deployment with neither a key nor a token", () => {
  test("never dials, and says why through the report", () => {
    const relay = harness();
    expect(relay.dials).toEqual([]);
    expect(relay.last()).toMatchObject({ configured: true, state: "unpaired" });
  });
});

describe("the close codes, one rule each", () => {
  test.each([
    ["unlinked", RELAY_CLOSE.unlinked],
    ["bad-signature", RELAY_CLOSE.badSignature],
    ["token-spent", RELAY_CLOSE.tokenSpent],
    ["replaced", RELAY_CLOSE.replaced],
  ])("a %s close stops the link rather than retrying it", (reason, code) => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.close(code, reason);
    expect(relay.timers).toEqual([]);
    expect(relay.last()).toMatchObject({ state: "unpaired", nextRetryAt: null });
    expect(relay.last().lastClose).toMatchObject({ code, reason });
  });

  test("`unlinked` stops dialling for good — a later timer cannot resurrect it", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.close(RELAY_CLOSE.unlinked, "unlinked");
    expect(relay.dials).toHaveLength(1);
    expect(relay.timers).toEqual([]);
    expect(relay.warnings.join("\n")).toContain("the relay has forgotten this deployment");
  });

  test("a protocol close retries slowly — the fix is an operator upgrading the relay", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.close(RELAY_CLOSE.protocol, "relay speaks 1");
    expect(relay.retry()!.ms).toBe(PROTOCOL_RETRY_MS);
    expect(relay.last().state).toBe("reconnecting");
  });

  test("an older relay is named before its refusal arrives", () => {
    const relay = harness({ key: generateDeploymentKey(), protocol: 3 });
    relay.challenge(2);
    expect(relay.warnings.join("\n")).toContain("Upgrade the relay first");
  });

  test("an ordinary drop backs off and says when it will try again", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.close(1006);
    expect(relay.retry()!.ms).toBe(reconnectDelayMs(0, () => 0.5));
    expect(relay.last().state).toBe("reconnecting");
    expect(relay.last().nextRetryAt).not.toBeNull();
  });

  test("the ladder climbs while the relay stays down, and resets when it comes back", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.close(1006);
    expect(relay.retry()!.ms).toBe(reconnectDelayMs(0, () => 0.5));
    relay.elapse();
    relay.close(1006);
    expect(relay.retry()!.ms).toBe(reconnectDelayMs(1, () => 0.5));
    relay.elapse();
    relay.challenge();
    relay.close(1006);
    expect(relay.retry()!.ms).toBe(reconnectDelayMs(0, () => 0.5));
  });
});

describe("reconnectDelayMs", () => {
  test("the first retry lands inside five seconds — a restart is back before that", () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(0);
    expect(reconnectDelayMs(0, () => 1)).toBe(RECONNECT_FIRST_MS);
  });

  test("it doubles from there and stops at the cap", () => {
    expect(reconnectDelayMs(1, () => 1)).toBe(2 * RECONNECT_FIRST_MS);
    expect(reconnectDelayMs(2, () => 1)).toBe(4 * RECONNECT_FIRST_MS);
    expect(reconnectDelayMs(3, () => 1)).toBe(RECONNECT_CAP_MS);
    expect(reconnectDelayMs(9, () => 1)).toBe(RECONNECT_CAP_MS);
  });

  test("the cap stays under the dark threshold, so a knock always beats it", () => {
    expect(RECONNECT_CAP_MS).toBeLessThan(RELAY_DARK_AFTER_MS);
  });

  test("there is no last attempt — the top rung repeats", () => {
    expect(reconnectDelayMs(500, () => 1)).toBe(reconnectDelayMs(50, () => 1));
  });

  test("and every delay is jittered, so a fleet does not come back in one wave", () => {
    expect(reconnectDelayMs(9, () => 0.25)).toBe(Math.round(0.25 * RECONNECT_CAP_MS));
  });
});

describe("silence", () => {
  test("a connection with nothing inbound for a minute is redialled", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    expect(relay.watchdog()!.ms).toBe(RELAY_DARK_AFTER_MS);

    relay.goQuiet();

    expect(relay.dials[0]!.closed).toBe(true);
    expect(relay.retry()).toBeDefined();
    expect(relay.warnings.join("\n")).toContain("redialling");
  });

  test("the dial that follows is an ordinary reconnect, not a refusal", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.goQuiet();
    relay.elapse();
    expect(relay.dials).toHaveLength(2);
    expect(relay.last().lastClose).toMatchObject({ code: 1006, reason: "no heartbeat" });
  });

  test("a heartbeat pushes the deadline out rather than letting it lapse", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    const first = relay.watchdog();

    relay.deliver({ type: RELAY_MESSAGES.heartbeat });

    expect(relay.watchdog()).toBeDefined();
    expect(relay.watchdog()).not.toBe(first);
    expect(relay.timers.filter((timer) => timer.kind === "silence")).toHaveLength(1);
  });

  test("the clock starts on open, so a relay that never challenges is not waited on", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.dials[0]!.handlers.onOpen();
    expect(relay.watchdog()!.ms).toBe(RELAY_DARK_AFTER_MS);
  });

  test("and the close that does arrive afterwards is not a second reconnect", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.goQuiet();
    const scheduled = relay.retry();

    relay.close(1006);

    expect(relay.retry()).toBe(scheduled);
    expect(relay.timers.filter((timer) => timer.kind === "retry")).toHaveLength(1);
  });
});

describe("stopping", () => {
  test("closes the socket and cancels the pending retry", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.stop();
    expect(relay.dials[0]!.closed).toBe(true);
    relay.close(1006);
    expect(relay.timers).toEqual([]);
  });

  test("and cancels the silence watchdog with it", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    expect(relay.watchdog()).toBeDefined();
    relay.stop();
    expect(relay.watchdog()).toBeUndefined();
  });
});

describe("noise on the wire", () => {
  test("a frame that is not JSON, or not a challenge, is ignored", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.dials[0]!.handlers.onOpen();
    relay.deliver("{not json");
    relay.deliver({ type: RELAY_MESSAGES.heartbeat });
    expect(relay.dials[0]!.sent).toEqual([]);
  });

  test("a second challenge on one connection is answered once", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.challenge();
    expect(relay.dials[0]!.sent).toHaveLength(1);
  });
});

describe("pushing the report", () => {
  /** A report, as far as the link cares: a `schema` and a body it never reads. */
  const reportOf = (updatedAt: string): DeploymentReport =>
    ({ schema: 1, updatedAt }) as unknown as DeploymentReport;

  test("the whole report goes up the moment the hello is away", () => {
    const relay = harness({ pairingToken: "mint-fresh", report: reportOf("first") });

    relay.challenge();

    expect(relay.reports()).toEqual([
      { type: RELAY_MESSAGES.report, schema: 1, report: { schema: 1, updatedAt: "first" } },
    ]);
  });

  test("a deployment with no report yet sends none, and is not an error", () => {
    const relay = harness({ pairingToken: "mint-fresh" });

    relay.challenge();
    relay.push();

    expect(relay.reports()).toEqual([]);
  });

  test("a push carries the report the model holds now, not the one it held then", () => {
    const relay = harness({ pairingToken: "mint-fresh", report: reportOf("first") });
    relay.challenge();

    relay.setReport(reportOf("second"));
    relay.push();

    expect(relay.reports()).toHaveLength(2);
    expect(relay.reports()[1]!["report"]).toEqual({ schema: 1, updatedAt: "second" });
  });

  test("pushing the same report twice sends it once", () => {
    const relay = harness({ pairingToken: "mint-fresh", report: reportOf("first") });
    relay.challenge();

    relay.push();
    relay.push();

    expect(relay.reports()).toHaveLength(1);
  });

  test("a push with no socket is dropped, never queued", () => {
    const relay = harness({ pairingToken: "mint-fresh", report: reportOf("first") });
    relay.challenge();
    relay.close(1006);

    relay.setReport(reportOf("while it was down"));
    relay.push();
    relay.push();

    // Only the one this connection carried before it ended. Nothing was held
    // for the reconnect: the next connection opens with the whole report
    // anyway, and a queue would deliver an older version of the same truth.
    expect(relay.reports()).toHaveLength(1);
    expect(relay.reports()[0]!["report"]).toEqual({ schema: 1, updatedAt: "first" });
  });

  test("and the next connection opens with the whole report, unchanged or not", () => {
    const relay = harness({ key: generateDeploymentKey(), report: reportOf("first") });
    relay.challenge();
    expect(relay.reports()).toHaveLength(1);

    relay.close(1006);
    relay.elapse();
    relay.challenge();

    expect(relay.reports()).toEqual([
      { type: RELAY_MESSAGES.report, schema: 1, report: { schema: 1, updatedAt: "first" } },
    ]);
  });
});

describe("a config edit off the rail (#503, #547)", () => {
  /** A pen that records what it was asked and answers written. */
  function pen() {
    const asked: ConfigEdit[] = [];
    return {
      asked,
      apply: (edit: ConfigEdit): Promise<EditReceipt> => {
        asked.push(edit);
        return Promise.resolve({
          id: edit.id,
          state: "written",
          file: "/etc/phoebe/phoebe.config.ts",
          path: edit.path,
          value: edit.value,
          fingerprint: "sha256:after",
          at: "2026-09-18T12:00:00.000Z",
          ...(edit.by !== undefined ? { by: edit.by } : {}),
        });
      },
    };
  }

  const CONFIG_SET = {
    type: RELAY_MESSAGES.configSet,
    id: "edit-1",
    path: "pipelines.work.concurrency",
    value: 4,
    fingerprint: "sha256:loaded",
    by: "ada@example.test",
  };

  test("the pen is asked with the patch, the fingerprint and the relay's stamp", async () => {
    const writer = pen();
    const relay = harness({ key: generateDeploymentKey(), onConfigSet: writer.apply });
    relay.challenge();

    relay.deliver(CONFIG_SET);
    await Promise.resolve();

    expect(writer.asked).toEqual([
      {
        id: "edit-1",
        path: "pipelines.work.concurrency",
        value: 4,
        fingerprint: "sha256:loaded",
        by: "ada@example.test",
      },
    ]);
  });

  test("and the receipt goes back under the id the relay asked with", async () => {
    const writer = pen();
    const relay = harness({ key: generateDeploymentKey(), onConfigSet: writer.apply });
    relay.challenge();

    relay.deliver(CONFIG_SET);
    await Promise.resolve();
    await Promise.resolve();

    const receipt = relay.receipts()[0]!;
    expect(receipt["id"]).toBe("edit-1");
    expect(receipt["outcome"]).toBe("written");
    // Verbatim: the link carries the pen's words and writes none of its own.
    expect((receipt["detail"] as Record<string, unknown>)["state"]).toBe("written");
    expect((receipt["detail"] as Record<string, unknown>)["by"]).toBe("ada@example.test");
  });

  test("a link with no pen refuses in those words, with the edit to make by hand", async () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();

    relay.deliver(CONFIG_SET);
    await Promise.resolve();
    await Promise.resolve();

    const detail = relay.receipts()[0]!["detail"] as Record<string, unknown>;
    expect(relay.receipts()[0]!["outcome"]).toBe("refused");
    expect(detail["why"]).toContain("holds no pen");
    expect(detail["instruction"]).toContain("pipelines: { work: { concurrency: 4 } }");
  });

  test("a pen that threw is still answered, because the console is holding the ask open", async () => {
    const relay = harness({
      key: generateDeploymentKey(),
      onConfigSet: () => Promise.reject(new Error("the volume went away")),
    });
    relay.challenge();

    relay.deliver(CONFIG_SET);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const detail = relay.receipts()[0]!["detail"] as Record<string, unknown>;
    expect(detail["why"]).toBe("the volume went away");
    expect(detail["instruction"]).toContain("by hand");
  });

  test("an edit before the hello is ignored: that socket has not identified itself", async () => {
    const writer = pen();
    const relay = harness({ key: generateDeploymentKey(), onConfigSet: writer.apply });
    relay.dials[0]!.handlers.onOpen();

    relay.deliver(CONFIG_SET);
    await Promise.resolve();

    expect(writer.asked).toEqual([]);
    expect(relay.receipts()).toEqual([]);
  });

  test("a malformed edit is dropped rather than guessed at", async () => {
    const writer = pen();
    const relay = harness({ key: generateDeploymentKey(), onConfigSet: writer.apply });
    relay.challenge();

    for (const frame of [
      { ...CONFIG_SET, id: "" },
      { ...CONFIG_SET, by: undefined },
      { ...CONFIG_SET, fingerprint: undefined },
      { ...CONFIG_SET, path: 7 },
      { ...CONFIG_SET, value: { nested: true } },
    ]) {
      relay.deliver(frame);
      await Promise.resolve();
    }

    expect(writer.asked).toEqual([]);
    expect(relay.receipts()).toEqual([]);
  });

  test("parseConfigSet keeps the literals and refuses everything else", () => {
    for (const value of ["a", 4, true, null]) {
      expect(parseConfigSet({ ...CONFIG_SET, value })?.value).toBe(value);
    }
    expect(parseConfigSet({ ...CONFIG_SET, value: [] })).toBeNull();
    expect(parseConfigSet({ type: "phoebe:relay:heartbeat" })).toBeNull();
  });
});

describe("answering a doctor run", () => {
  const doctorRun = (id: string, by = "ada@example.test") => ({
    type: RELAY_MESSAGES.doctorRun,
    id,
    by,
  });

  test("asks the deployment's doctor and receipts the word it gets back", () => {
    const relay = harness({
      pairingToken: "mint-fresh",
      doctorRun: () => ({ outcome: RELAY_DOCTOR_RUN.started }),
    });
    relay.challenge();

    relay.deliver(doctorRun("req-1"));

    expect(relay.asked).toEqual(["ada@example.test"]);
    expect(relay.receipts()).toEqual([
      { type: RELAY_MESSAGES.receipt, id: "req-1", outcome: "started" },
    ]);
  });

  test("a second ask during that run is receipted `joined`, and nothing is doubled", () => {
    let running = false;
    const relay = harness({
      pairingToken: "mint-fresh",
      doctorRun: () => {
        const outcome = running ? RELAY_DOCTOR_RUN.joined : RELAY_DOCTOR_RUN.started;
        running = true;
        return { outcome };
      },
    });
    relay.challenge();

    relay.deliver(doctorRun("req-1"));
    relay.deliver(doctorRun("req-2"));

    expect(relay.receipts().map((receipt) => receipt["outcome"])).toEqual(["started", "joined"]);
  });

  test("the receipt carries the detail a refusal explains itself with", () => {
    const relay = harness({
      pairingToken: "mint-fresh",
      doctorRun: () => ({ outcome: RELAY_DOCTOR_RUN.refused, detail: "shutting down" }),
    });
    relay.challenge();

    relay.deliver(doctorRun("req-1"));

    expect(relay.receipts()[0]).toMatchObject({ outcome: "refused", detail: "shutting down" });
  });

  test("a link with no doctor behind it refuses in those words rather than going quiet", () => {
    // Silence would leave the console holding a request until the socket closed.
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();

    relay.deliver(doctorRun("req-1"));

    expect(relay.receipts()[0]).toMatchObject({ outcome: "refused" });
    expect(relay.receipts()[0]!["detail"]).toContain("no doctor");
  });

  test("an ask that throws is a refusal, not an exception on the socket", () => {
    const relay = harness({
      pairingToken: "mint-fresh",
      doctorRun: () => {
        throw new Error("the runner is gone");
      },
    });
    relay.challenge();

    relay.deliver(doctorRun("req-1"));

    expect(relay.receipts()[0]).toMatchObject({
      outcome: "refused",
      detail: "the runner is gone",
    });
  });

  test("an ask before the hello is ignored: the relay has not been answered yet", () => {
    const relay = harness({
      pairingToken: "mint-fresh",
      doctorRun: () => ({ outcome: RELAY_DOCTOR_RUN.started }),
    });
    relay.dials[0]!.handlers.onOpen();

    relay.deliver(doctorRun("req-1"));

    expect(relay.asked).toEqual([]);
    expect(relay.receipts()).toEqual([]);
  });

  test("a malformed ask is dropped rather than receipted under an id it invented", () => {
    const relay = harness({
      pairingToken: "mint-fresh",
      doctorRun: () => ({ outcome: RELAY_DOCTOR_RUN.started }),
    });
    relay.challenge();

    relay.deliver({ type: RELAY_MESSAGES.doctorRun, by: "ada@example.test" });
    relay.deliver({ type: RELAY_MESSAGES.doctorRun, id: "req-1" });

    expect(relay.asked).toEqual([]);
    expect(relay.receipts()).toEqual([]);
  });
});

describe("answering a request", () => {
  /** A paired link, connected, with an answerer behind it. */
  const connected = (answer?: (request: InboundRequest) => Promise<RequestAnswer>): Harness => {
    const relay = harness({
      key: generateDeploymentKey(),
      ...(answer !== undefined ? { answer } : {}),
    });
    relay.challenge();
    return relay;
  };

  const secretSet = (id: string) => ({
    type: RELAY_MESSAGES.secretSet,
    id,
    tenant: "acme/widget",
    key: "ANTHROPIC_API_KEY",
    action: "set",
    envelope: '{"v":1}',
    by: "ada@example.test",
  });

  test("the request reaches the answerer with its id and its frame", async () => {
    const relay = connected(async () => ({ outcome: "written" }));
    relay.deliver(secretSet("edit-1"));
    await Promise.resolve();

    expect(relay.requests).toHaveLength(1);
    expect(relay.requests[0]).toMatchObject({ type: RELAY_MESSAGES.secretSet, id: "edit-1" });
    expect(relay.requests[0]?.frame["key"]).toBe("ANTHROPIC_API_KEY");
  });

  test("the answer comes back as a receipt under the same id", async () => {
    const relay = connected(async () => ({
      outcome: "written",
      detail: { key: "ANTHROPIC_API_KEY" },
    }));
    relay.deliver(secretSet("edit-1"));
    await Promise.resolve();
    await Promise.resolve();

    expect(relay.receipts()).toEqual([
      {
        type: RELAY_MESSAGES.receipt,
        id: "edit-1",
        outcome: "written",
        detail: { key: "ANTHROPIC_API_KEY" },
      },
    ]);
  });

  test("a handler that throws is a refusal, not a console left waiting", async () => {
    const relay = connected(() => Promise.reject(new Error("the volume is read-only")));
    relay.deliver(secretSet("edit-1"));
    await Promise.resolve();
    await Promise.resolve();

    expect(relay.receipts()[0]).toMatchObject({
      id: "edit-1",
      outcome: "refused",
      detail: "the volume is read-only",
    });
  });

  test("a build with no answerer refuses by return rather than by silence", async () => {
    const relay = connected();
    relay.deliver(secretSet("edit-1"));
    await Promise.resolve();

    expect(relay.receipts()[0]).toMatchObject({ id: "edit-1", outcome: "refused" });
  });

  test("a request with no id is dropped — there is nothing to answer under", async () => {
    const relay = connected(async () => ({ outcome: "written" }));
    relay.deliver({ type: RELAY_MESSAGES.secretSet, tenant: "acme/widget" });
    await Promise.resolve();

    expect(relay.requests).toEqual([]);
    expect(relay.receipts()).toEqual([]);
  });

  test("a type this build has never heard of is dropped in silence", async () => {
    // A relay newer than its deployments is allowed to say things they do not
    // know, and there is no id to refuse under either way.
    const relay = connected(async () => ({ outcome: "written" }));
    relay.deliver({ type: "phoebe:relay:something-new", id: "edit-1" });
    await Promise.resolve();

    expect(relay.requests).toEqual([]);
    expect(relay.receipts()).toEqual([]);
  });

  test("a heartbeat is not a request", async () => {
    const relay = connected(async () => ({ outcome: "written" }));
    relay.deliver({ type: RELAY_MESSAGES.heartbeat });
    await Promise.resolve();

    expect(relay.requests).toEqual([]);
    expect(relay.receipts()).toEqual([]);
  });
});
