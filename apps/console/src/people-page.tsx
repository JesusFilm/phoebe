// The People page: who may sign into this relay, and where a new deployment's
// pairing token comes from (#505 §6, #548).
//
// **There are no roles, so there is nothing to grant.** Everyone on this list
// can see every deployment, mint a token, and edit this list — which is why the
// page is a list of addresses and not a permissions matrix. The only two rows
// that cannot be removed are refused for reasons that are facts rather than
// privileges: you are the one asking, and `ALLOWED_EMAILS` holds that one.
//
// **Minting lives here, beside the people, because it is the same act.** Adding
// a person and pairing a deployment are both "let this one in", and an operator
// setting a relay up does both in the same sitting. The token is shown once —
// the relay keeps only its expiry — so the panel says the two settings to make
// while the characters are still on screen, rather than sending someone to a
// doc to find out what to do with what they just copied.

import { useEffect, useState, type FormEvent } from "react";
import type { RelayPairingToken, RelayPerson } from "phoebe-agent/contracts";
import { age } from "./facts.ts";
import { isNotSignedIn, RelayRequestError, type RelayClient } from "./relay-client.ts";

export function PeoplePage({
  client,
  now,
  onSignedOut,
}: {
  client: RelayClient;
  now: Date;
  onSignedOut: () => void;
}) {
  const [people, setPeople] = useState<RelayPerson[] | null>(null);
  const [typed, setTyped] = useState("");
  const [trouble, setTrouble] = useState<string | null>(null);
  const [token, setToken] = useState<RelayPairingToken | null>(null);
  // One flag for every call this page makes, because they all write the same
  // list and a second click while the first is in flight would race it.
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let live = true;
    client.people().then(
      (listed) => {
        if (live) setPeople(listed);
      },
      (error: unknown) => {
        if (!live) return;
        if (isNotSignedIn(error)) onSignedOut();
        else setTrouble(refusal(error));
      },
    );
    return () => {
      live = false;
    };
  }, [client, onSignedOut]);

  /**
   * Every edit re-reads the list rather than patching the copy on screen. The
   * relay is the one that knows what an address turned into — lowercased, and
   * back-filled with a `sub` if that person has signed in since — and a page
   * that guessed would show its guess until the next reload.
   */
  async function run(edit: () => Promise<string | null>): Promise<void> {
    setWorking(true);
    setTrouble(null);
    try {
      const said = await edit();
      setPeople(await client.people());
      if (said !== null) setTrouble(said);
    } catch (error: unknown) {
      if (isNotSignedIn(error)) onSignedOut();
      else setTrouble(refusal(error));
    } finally {
      setWorking(false);
    }
  }

  function add(event: FormEvent): void {
    event.preventDefault();
    const email = typed.trim();
    if (email === "") return;
    void run(async () => {
      await client.addPerson(email);
      setTyped("");
      return null;
    });
  }

  function remove(person: RelayPerson): void {
    void run(async () => {
      const { sessionsEnded } = await client.removePerson(person.email);
      return sessionsEnded === 0
        ? `${person.email} is off the list.`
        : `${person.email} is off the list, and ${sessionsEnded} open ` +
            `${sessionsEnded === 1 ? "session" : "sessions"} ended.`;
    });
  }

  function mint(): void {
    void run(async () => {
      setToken(await client.mintPairingToken());
      return null;
    });
  }

  return (
    <main className="main">
      <h1>People</h1>
      <p className="legend">
        Everyone here can do everything: read every deployment, mint a pairing token, and edit this
        list. There are no roles.
      </p>

      <form className="add-person" onSubmit={add}>
        <label htmlFor="new-person">Add by email</label>
        <input
          id="new-person"
          type="email"
          value={typed}
          placeholder="someone@example.com"
          onChange={(event) => setTyped(event.target.value)}
        />
        <button type="submit" disabled={working}>
          Add
        </button>
      </form>

      {trouble === null ? null : <p className="facts trouble">{trouble}</p>}

      {people === null ? (
        <p className="muted">Reading the list…</p>
      ) : (
        <PeopleList people={people} now={now} working={working} onRemove={remove} />
      )}

      <Pairing token={token} now={now} working={working} onMint={mint} />
    </main>
  );
}

/**
 * The list itself. Pure, so a test renders it against a fixed `now` and reads
 * the markup — the same shape the fleet page keeps.
 */
export function PeopleList({
  people,
  now,
  working,
  onRemove,
}: {
  people: RelayPerson[];
  now: Date;
  working?: boolean;
  onRemove: (person: RelayPerson) => void;
}) {
  return (
    <ul className="people" aria-label="Allowlist">
      {people.map((person) => (
        <li key={person.email} className="person">
          <span className="name">
            {person.email}
            {person.self ? <span className="chip">you</span> : null}
            {person.fromEnvironment ? <span className="chip">from environment</span> : null}
          </span>
          <span className="facts">{provenance(person, now)}</span>
          {person.self || person.fromEnvironment ? (
            <span className="facts">{whyItStays(person)}</span>
          ) : (
            <button type="button" disabled={working} onClick={() => onRemove(person)}>
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The minting panel, and the token when there is one. Also pure: the token is a
 * prop rather than state here, so the test that matters — "the two settings are
 * on screen beside the characters" — is a render.
 */
export function Pairing({
  token,
  now,
  working,
  onMint,
}: {
  token: RelayPairingToken | null;
  now: Date;
  working?: boolean;
  onMint: () => void;
}) {
  return (
    <section className="pairing">
      <h2>Pair a deployment</h2>
      <p className="legend">
        A pairing token is single-use and good for fifteen minutes. The relay holds it in memory and
        never on its volume, so a restart voids one nobody has spent.
      </p>
      <button type="button" disabled={working} onClick={onMint}>
        Mint a pairing token
      </button>
      {token === null ? null : (
        <div className="token">
          <p>
            <strong>Copy it now.</strong> This is the only time the relay says it — mint another if
            it gets away from you. It is spendable for {lifeLeft(token, now)}.
          </p>
          <p className="mono token-value">{token.token}</p>
          <p>Two settings on the deployment, then boot:</p>
          <ol>
            <li>
              Root <code>phoebe.config.ts</code> —{" "}
              <code className="mono">{`relay: { url: "${token.relayUrl}" }`}</code>
            </li>
            <li>
              Root <code>.env</code> —{" "}
              <code className="mono">{`PHOEBE_RELAY_TOKEN=${token.token}`}</code>
            </li>
          </ol>
          <p className="facts">
            Once it has paired, take <code>PHOEBE_RELAY_TOKEN</code> back out: it is spent, and
            <code> phoebe doctor</code> reports <code>relay: token-stale</code> until it is gone.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * What is left of a token's fifteen minutes. Read off the relay's own
 * `expiresAt` rather than counted down from the mint, so a page left open over
 * a suspended laptop says "expired" instead of a number it made up.
 */
function lifeLeft(token: RelayPairingToken, now: Date): string {
  const left = Date.parse(token.expiresAt) - now.getTime();
  if (Number.isNaN(left) || left <= 0) return "no longer — mint another";
  return `another ${Math.ceil(left / 60_000)} min`;
}

/** Where this entry came from, in one clause. */
function provenance(person: RelayPerson, now: Date): string {
  if (person.fromEnvironment) return "ALLOWED_EMAILS";
  const added =
    person.addedBy === "bootstrap"
      ? `claimed this relay ${age(person.addedAt, now)} ago`
      : `added by ${person.addedBy} ${age(person.addedAt, now)} ago`;
  return person.signedIn ? added : `${added} · has not signed in yet`;
}

/** Why there is no Remove beside this one. Two reasons, and they differ. */
function whyItStays(person: RelayPerson): string {
  if (person.self) return "you cannot remove yourself";
  return "edit ALLOWED_EMAILS and restart the relay";
}

/**
 * The relay's refusal as a sentence. Every code the People routes answer with
 * gets its own, because "409" on screen tells an operator nothing about which
 * of the two lists they just argued with.
 */
function refusal(error: unknown): string {
  if (!(error instanceof RelayRequestError)) {
    return error instanceof Error ? error.message : String(error);
  }
  switch (error.code) {
    case "already-listed":
      return "That address is already on the list.";
    case "bad-email":
    case "no-email":
      return "That does not read as an email address.";
    case "cannot-remove-yourself":
      return "You cannot remove yourself — there are no roles, so nobody could put you back.";
    case "from-environment":
      return "ALLOWED_EMAILS holds that address. Edit the variable and restart the relay.";
    case "no-such-person":
      return "That address is not on the list.";
    default:
      return error.message;
  }
}
