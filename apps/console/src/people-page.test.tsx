// What the People page puts on screen (#505 §6, #548).
//
// Rendered to static markup, like the fleet page's test: these are pure
// components over what the relay answered, so the markup is the whole output.
// The assertions are the ones an operator would be misled by if they broke —
// a Remove button beside a row nobody can remove, and a token shown without the
// two settings that make it worth anything.

import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { Pairing, PeopleList } from "./people-page.tsx";
import { ago, NOW, person } from "./test-fixture.ts";

const LIST = renderToStaticMarkup(
  <PeopleList
    people={[
      person({ email: "ada@example.test", self: true, addedBy: "bootstrap" }),
      person({ email: "grace@example.test", addedBy: "ada@example.test" }),
      person({ email: "alan@example.test", addedBy: "ada@example.test", signedIn: false }),
      person({ email: "ops@example.test", addedBy: "environment", fromEnvironment: true }),
    ]}
    now={NOW}
    onRemove={() => {}}
  />,
);

describe("the list", () => {
  test("names everyone who may sign in", () => {
    for (const email of ["ada@", "grace@", "alan@", "ops@"]) {
      expect(LIST, email).toContain(email);
    }
  });

  test("offers Remove exactly where a removal would work", () => {
    // Two buttons, for the two rows that are neither the reader's own nor the
    // environment's: ada is the one reading and ops came from ALLOWED_EMAILS,
    // so grace and alan are the removable pair.
    expect([...LIST.matchAll(/>Remove</g)]).toHaveLength(2);
  });

  test("says why the two rows without one keep their place", () => {
    expect(LIST).toContain("you cannot remove yourself");
    expect(LIST).toContain("edit ALLOWED_EMAILS and restart the relay");
  });

  test("marks the reader and the environment's entries differently", () => {
    expect(LIST).toContain(">you<");
    expect(LIST).toContain(">from environment<");
  });

  test("an invitation nobody has accepted says so rather than looking broken", () => {
    expect(LIST).toContain("has not signed in yet");
  });

  test("carries no role, rank or permission anywhere", () => {
    for (const word of ["admin", "role", "owner", "permission", "read-only"]) {
      expect(LIST.toLowerCase(), word).not.toContain(word);
    }
  });
});

describe("minting a pairing token", () => {
  const minted = renderToStaticMarkup(
    <Pairing
      token={{
        token: "a-single-use-token",
        expiresAt: new Date(NOW.getTime() + 14 * 60_000).toISOString(),
        relayUrl: "wss://relay.example.test/deployments",
      }}
      now={NOW}
      onMint={() => {}}
    />,
  );

  test("says the token once, with both settings it is useless without", () => {
    expect(minted).toContain("a-single-use-token");
    expect(minted).toContain("phoebe.config.ts");
    expect(minted).toContain("relay: { url: &quot;wss://relay.example.test/deployments&quot; }");
    expect(minted).toContain("PHOEBE_RELAY_TOKEN=a-single-use-token");
  });

  test("warns that this is the only showing, and how long it lasts", () => {
    expect(minted).toContain("Copy it now");
    expect(minted).toContain("another 14 min");
  });

  test("says to take the spent token back out of the environment", () => {
    expect(minted).toContain("token-stale");
  });

  test("a token whose fifteen minutes ran out says to mint another", () => {
    const stale = renderToStaticMarkup(
      <Pairing
        token={{ token: "t", expiresAt: ago(60), relayUrl: "wss://relay.example.test/deployments" }}
        now={NOW}
        onMint={() => {}}
      />,
    );

    expect(stale).toContain("mint another");
  });

  test("before a mint there is a button and no characters to leak", () => {
    const quiet = renderToStaticMarkup(<Pairing token={null} now={NOW} onMint={() => {}} />);

    expect(quiet).toContain("Mint a pairing token");
    expect(quiet).not.toContain("PHOEBE_RELAY_TOKEN");
  });
});
