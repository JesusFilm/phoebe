// @vitest-environment jsdom
// The add-remote modal's presses (map #690, #699): what one field parses
// into, each failure line, and where a success says the row landed.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PairResult } from "phoebe-agent/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { AddRemote } from "./add-remote.tsx";
import { bridge, install, remote } from "./test-fixture.ts";

const record = remote;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const LINK = "https://youtube-studio.tail4f2c.ts.net/pair#code=ABCD-EFGH-JK12";

async function open(
  answer: PairResult,
  props: {
    prefill?: string;
    records?: ReturnType<typeof record>[];
    joined?: boolean;
    tailscale?: boolean | null;
  } = {},
) {
  const asked: { url: string; code: string; label: string }[] = [];
  const base = bridge({ pairResult: answer });
  const b = {
    ...base,
    remotes: {
      ...base.remotes,
      pair: (input: { url: string; code: string; label: string }) => {
        asked.push(input);
        return Promise.resolve(answer);
      },
    },
  };
  const paired: string[] = [];
  const opened: string[] = [];
  await act(async () => {
    root.render(
      <AddRemote
        bridge={b}
        defaultLabel="this companion"
        prefill={props.prefill ?? ""}
        records={props.records ?? []}
        joinedInstallOf={() => (props.joined ? install({ dir: "/repos/ys" }) : null)}
        tailscaleRunning={props.tailscale === undefined ? true : props.tailscale}
        onPaired={(r) => paired.push(r.deploymentId)}
        onClose={() => undefined}
        onOpen={(id) => opened.push(id)}
      />,
    );
  });
  return { asked, paired, opened };
}

function input(id: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`#${id}`)!;
}

async function type(id: string, value: string): Promise<void> {
  const field = input(id);
  // React keeps its own value tracker on the element, so the prototype's
  // setter is what makes an input event read as a change.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pair(): Promise<void> {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

describe("the one field", () => {
  test("a pairing link fills host and code and hides the code field", async () => {
    const { asked } = await open({ outcome: "paired", record: record() });
    await type("add-remote-input", LINK);
    expect(container.textContent).toContain("link with code");
    expect(container.querySelector("#add-remote-code")).toBeNull();
    await pair();
    expect(asked).toEqual([
      {
        url: "https://youtube-studio.tail4f2c.ts.net",
        code: "ABCDEFGHJK12",
        label: "this companion",
      },
    ]);
  });

  test("a bare address shows a code field, and the code is normalised before it is sent", async () => {
    const { asked } = await open({ outcome: "paired", record: record() });
    await type("add-remote-input", "demo-host.tail4f2c.ts.net:8443");
    expect(container.querySelector("#add-remote-code")).not.toBeNull();
    await type("add-remote-code", "abcd efgh jkl2");
    await type("add-remote-label", "Ops laptop");
    await pair();
    expect(asked).toEqual([
      { url: "https://demo-host.tail4f2c.ts.net:8443", code: "ABCDEFGHJK12", label: "Ops laptop" },
    ]);
  });

  test("an empty field and a malformed code are refused before anything is sent", async () => {
    const { asked } = await open({ outcome: "paired", record: record() });
    await pair();
    expect(container.textContent).toContain("Paste a pairing link, or enter the deployment");
    await type("add-remote-input", "demo-host.ts.net");
    await type("add-remote-code", "ABC");
    await pair();
    expect(container.textContent).toContain("A code is twelve letters and digits");
    expect(asked).toEqual([]);
  });
});

describe("each failure is one line", () => {
  test.each([
    [{ outcome: "unreachable" as const, detail: "" }, true, "Nothing answered at that address"],
    [{ outcome: "unreachable" as const, detail: "" }, false, "Tailscale is off"],
    [{ outcome: "tailscale-off" as const, detail: "" }, true, "Tailscale is off"],
    [{ outcome: "not-phoebe" as const, detail: "" }, true, "not a Phoebe deployment"],
    [{ outcome: "code-rejected" as const, detail: "" }, true, "single use and last five minutes"],
    [{ outcome: "protocol" as const, detail: "" }, true, "Update the companion"],
  ])("%o with Tailscale %s", async (answer, tailscale, line) => {
    await open(answer, { tailscale });
    await type("add-remote-input", LINK);
    await pair();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(line);
  });
});

describe("success says where the row landed", () => {
  test("a new machine, with the way to its page", async () => {
    const { paired, opened } = await open({ outcome: "paired", record: record() });
    await type("add-remote-input", LINK);
    await pair();
    expect(container.textContent).toContain(
      "Added as a new machine, youtube-studio.tail4f2c.ts.net",
    );
    expect(paired).toEqual(["dep_YT"]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(opened).toEqual(["dep_YT"]);
  });

  test("a known host gains a row; a second route for a folder here is said too", async () => {
    await open(
      {
        outcome: "paired",
        record: record({
          deploymentId: "dep_NEW",
          url: "https://youtube-studio.tail4f2c.ts.net:8443",
        }),
      },
      { records: [record()], joined: true },
    );
    await type(
      "add-remote-input",
      "https://youtube-studio.tail4f2c.ts.net:8443/pair#code=ABCD-EFGH-JK12",
    );
    await pair();
    expect(container.textContent).toContain(
      "Added to youtube-studio.tail4f2c.ts.net, which already had one deployment.",
    );
    expect(container.textContent).toContain("also the folder at /repos/ys on this machine");
  });

  test("pair again opens with the address filled in and says the row kept its things", async () => {
    await open(
      { outcome: "paired", record: record() },
      {
        prefill: "https://youtube-studio.tail4f2c.ts.net",
        records: [record({ reachability: "blocked", blocked: "expired" })],
      },
    );
    expect(container.textContent).toContain("Pair again");
    expect(input("add-remote-input").value).toBe("https://youtube-studio.tail4f2c.ts.net");
    await type("add-remote-code", "ABCD-EFGH-JK12");
    await pair();
    expect(container.textContent).toContain(
      "Paired again. The row under youtube-studio.tail4f2c.ts.net kept its label",
    );
  });
});
