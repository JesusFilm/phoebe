// One config, as the config tab shows it: a form first, the file behind it.
//
// The form is the settings the companion read out of the file
// (apps/desktop/src/config-fields.ts), one row each, laid out the way the
// project's own settings are above the tabs. Which rows depends on whose config
// it is: a workspace root has the deployment's few, a tenant has its own, and a
// solo install's one config has both, under a heading each. A row saves itself: `config set`
// moves one leaf at a time, so a form with one Save for the lot would be a form
// that could half-apply.
//
// The file view is the text as the folder holds it, with the form that names a
// path by hand under it. That form reaches what this one does not list, a
// pipeline's own settings or a kind's, and it is where a config that will not
// parse is still readable.

import { useState, type ReactNode } from "react";
import type {
  ConfigFieldFacts,
  EditReceipt,
  LocalInstall,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "~/components/ui/combobox";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { settingCopy } from "./config-copy.ts";
import { ReceiptPanel } from "./deployment-tabs.tsx";
import type { ConfigReading } from "./tabs.ts";

type ConfigFile = Extract<ConfigReading, { kind: "file" }>;

export type ConfigView = "form" | "file";

/**
 * Which view a config opens on. The form, unless there is nothing to put in
 * one: a config the companion could not parse, or a companion that reads no
 * fields.
 */
export function landingConfigView(config: ConfigFile): ConfigView {
  return (config.fields ?? []).length === 0 ? "file" : "form";
}

export function ConfigSpace({
  install,
  config,
  running,
  receipt,
  onStart,
  tenant,
  label,
  file,
  status,
}: {
  install: LocalInstall;
  config: ConfigFile;
  running: boolean;
  /** The receipt the last `config set` on this config answered with, if any. */
  receipt: EditReceipt | null;
  onStart: (request: VerbRunRequest) => void;
  /** A workspace child's folder: edits go to its config rather than the root's. */
  tenant?: string;
  /** What this config is called in the switch's label. */
  label: string;
  /** The form that names a path by hand, drawn under the file's text. */
  file: ReactNode;
  /** What a save that was not a `config set` came to, said under the form. */
  status?: ReactNode;
}) {
  const [view, setView] = useState<ConfigView>(() => landingConfigView(config));
  const fields = config.fields ?? [];

  return (
    <div className="config-space">
      <div className="config-views" role="group" aria-label={`How to view ${label}`}>
        {(["form", "file"] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={`config-view${view === name ? " current" : ""}`}
            aria-pressed={view === name}
            onClick={() => setView(name)}
          >
            {name === "form" ? "Form" : "File"}
          </button>
        ))}
      </div>
      {view === "file" ? (
        <>
          <pre className="config mono">{config.text}</pre>
          {file}
        </>
      ) : fields.length === 0 ? (
        <p className="muted">
          This config could not be read as settings, so there is no form to offer. The file view has
          it as written.
        </p>
      ) : (
        <>
          {configGroups(fields).map((group) => (
            <section
              key={group.scope}
              className="config-form"
              aria-label={`${group.heading} in ${label}`}
            >
              {/* One kind of row needs no heading over it. */}
              {group.alone ? null : <h3 className="config-group">{group.heading}</h3>}
              {group.fields.map((field) => (
                <ConfigFieldRow
                  // Keyed on what the file says, so a row redraws on the value a
                  // save landed rather than holding the draft that asked for it.
                  key={`${field.path}:${field.state}:${String(field.value)}`}
                  field={field}
                  running={running}
                  onSave={(value) =>
                    onStart(
                      saveRequest({
                        install: install.dir,
                        field,
                        value,
                        fingerprint: config.fingerprint,
                        ...(tenant === undefined ? {} : { tenant }),
                      }),
                    )
                  }
                />
              ))}
            </section>
          ))}
          {receipt === null ? null : <ReceiptPanel receipt={receipt} />}
          {status}
        </>
      )}
    </div>
  );
}

/**
 * The run one row's Save is. A `config set` against the fingerprint the form
 * was drawn from, for every row but the engine's ref: that moves with
 * `upgrade`, which runs the new ref's migrations before the config names it.
 */
export function saveRequest(opts: {
  install: string;
  field: Pick<ConfigFieldFacts, "path" | "via">;
  value: string | number | boolean | readonly string[];
  fingerprint: string;
  tenant?: string;
}): VerbRunRequest {
  if (opts.field.via === "upgrade") {
    return {
      install: opts.install,
      verb: "upgrade",
      check: false,
      target: "engine",
      ref: String(opts.value),
    };
  }
  return {
    install: opts.install,
    verb: "config set",
    path: opts.field.path,
    value: opts.value,
    fingerprint: opts.fingerprint,
    ...(opts.tenant === undefined ? {} : { tenant: opts.tenant }),
  };
}

export type ConfigGroup = {
  scope: ConfigFieldFacts["scope"];
  heading: string;
  /** The only group there is, so it goes without its heading. */
  alone: boolean;
  fields: ConfigFieldFacts[];
};

/** The rows by whose they are, the deployment's first, leaving out a kind with none. */
export function configGroups(fields: readonly ConfigFieldFacts[]): ConfigGroup[] {
  const groups = (
    [
      ["deployment", "Deployment"],
      ["tenant", "Repository"],
    ] as const
  )
    .map(([scope, heading]) => ({
      scope,
      heading,
      fields: fields.filter((field) => field.scope === scope),
    }))
    .filter((group) => group.fields.length > 0);
  return groups.map((group) => ({ ...group, alone: groups.length === 1 }));
}

/** The empty draft, as the select knows it: an item of its own, so unset stays pickable. */
const UNSET = "";

/**
 * The select item a list is picked by, and what that item is not: any value a
 * catalogued enum carries. `[]` is not a config value anywhere — the enums are
 * words — so it can stand for "the list" without shadowing one.
 */
const LIST = "[]";

/** One item of a row's select: what picking it drafts, and what it reads as. */
export type ChoiceItem = { value: string; label: string };

/**
 * The items a row's select offers, or null for a row that is not a select.
 *
 * Three kinds, in this order: unset, where saying nothing still applies;
 * the field's own closed values; and, for a field that also takes a list, one
 * more item named for what the list is. That last one is the only item whose
 * value is not its own label — the console has no word for a branch prefix and
 * does not need one, because the companion sent the word with the field.
 */
export function choiceItems(field: ConfigFieldFacts, fallback: string): ChoiceItem[] | null {
  const choices =
    field.type === "boolean" ? ["true", "false"] : field.type === "enum" ? field.values : undefined;
  if (choices === undefined) return null;
  // The unset item says it is unset, and what applies: a default of `false`
  // must not read as one more `false` in the list.
  const unsetLabel = field.default === undefined ? "not set" : `not set (${fallback})`;
  return [
    ...(field.state === "unset" ? [{ value: UNSET, label: unsetLabel }] : []),
    ...choices.map((choice) => ({ value: choice, label: choice })),
    ...(field.list === undefined ? [] : [{ value: LIST, label: field.list }]),
  ];
}

/** What a row's control holds, as text: the file's value, the list item, or nothing. */
function draftOf(field: ConfigFieldFacts): string {
  if (field.list !== undefined && Array.isArray(field.value)) return LIST;
  return field.state === "set" && field.value !== null && field.value !== undefined
    ? String(field.value)
    : "";
}

/**
 * What a row's list box holds before it is touched: the list the file holds, or
 * the prefill the companion read for it — the literal the enum arm is shorthand
 * for, so an operator edits a visible default rather than an empty box.
 */
export function listDraftOf(field: ConfigFieldFacts): string {
  const current = Array.isArray(field.value) ? field.value : (field.listPrefill ?? []);
  return current.join(", ");
}

/**
 * The list a comma-separated box is: entries trimmed, blanks dropped. An empty
 * box is the empty list, which is a thing an operator can mean — `prScope: []`
 * says the janitors scan nothing — and so is saved rather than refused.
 */
export function listOfDraft(draft: string): string[] {
  return draft
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Is this list the one the file already holds? */
function sameList(list: readonly string[], value: ConfigFieldFacts["value"]): boolean {
  return (
    Array.isArray(value) &&
    value.length === list.length &&
    list.every((entry, index) => entry === value[index])
  );
}

/**
 * The value a draft is, typed the way the setting is. Null when the draft is
 * not one: an empty box, or a number box holding something else.
 */
export function valueOfDraft(
  field: Pick<ConfigFieldFacts, "type">,
  draft: string,
): string | number | boolean | null {
  const text = draft.trim();
  if (text === "") return null;
  switch (field.type) {
    case "boolean":
      return text === "true" ? true : text === "false" ? false : null;
    case "number":
    case "integer": {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return null;
      return field.type === "integer" && !Number.isInteger(parsed) ? null : parsed;
    }
    default:
      return text;
  }
}

export function ConfigFieldRow({
  field,
  running,
  onSave,
}: {
  field: ConfigFieldFacts;
  running: boolean;
  onSave: (value: string | number | boolean | readonly string[]) => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(field));
  const [list, setList] = useState(() => listDraftOf(field));
  // The word this field calls a list, while the list is what is picked — null
  // on every row that is not on its list, which is every row that has none. The
  // box under the select is then what gets saved.
  const listing = field.list !== undefined && draft === LIST ? field.list : null;
  const value = listing === null ? valueOfDraft(field, draft) : listOfDraft(list);
  const changed =
    listing === null ? draft.trim() !== draftOf(field) : !sameList(listOfDraft(list), field.value);
  const fallback = field.default === undefined ? "not set" : String(field.default);
  const items = choiceItems(field, fallback);
  const copy = settingCopy(field.path);

  return (
    <Field className="project-row">
      <div className="project-row-text">
        <FieldLabel>
          {copy.label}
          {copy.label === field.path ? null : (
            <span className="mono setting-path">{field.path}</span>
          )}
        </FieldLabel>
        <FieldDescription>
          {copy.description === "" ? null : `${copy.description} `}
          {field.locked !== undefined
            ? field.locked
            : field.state === "computed"
              ? "Computed in the file, so it is shown as written and changed there."
              : field.default === undefined
                ? null
                : `Defaults to ${fallback}.`}
        </FieldDescription>
      </div>
      {field.state === "computed" || field.locked !== undefined ? (
        <div className="project-row-control">
          <Input
            size="sm"
            className="mono"
            aria-label={field.path}
            value={field.state === "computed" ? (field.raw ?? "") : draftOf(field)}
            readOnly
            title={field.raw}
          />
        </div>
      ) : (
        <form
          className="project-row-control"
          onSubmit={(event) => {
            event.preventDefault();
            if (value !== null) onSave(value);
          }}
        >
          {items !== null ? (
            <>
              <ChoiceControl
                field={field}
                items={items}
                draft={draft}
                running={running}
                onDraft={setDraft}
              />
              {/* Revealed by the list item, and only by it: until then the
                  field is one of its words and there is no list to show. */}
              {listing === null ? null : (
                <Input
                  size="sm"
                  className="mono"
                  aria-label={`${field.path} ${listing}`}
                  value={list}
                  placeholder={`${listing}, comma separated`}
                  disabled={running}
                  onChange={(event) => setList(event.target.value)}
                />
              )}
            </>
          ) : field.suggestions !== undefined && field.suggestions.length > 0 ? (
            <SuggestingControl
              field={field}
              fallback={fallback}
              draft={draft}
              running={running}
              onDraft={setDraft}
            />
          ) : (
            <Input
              size="sm"
              className="mono"
              aria-label={field.path}
              inputMode={field.type === "string" ? "text" : "numeric"}
              value={draft}
              placeholder={fallback}
              disabled={running}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={running || !changed || value === null}
          >
            Save
          </Button>
        </form>
      )}
    </Field>
  );
}

/**
 * A closed set of values, as Coss UI's select rather than the browser's own,
 * whose popup follows the OS and not the console's theme. An unset setting
 * offers what applies without it as the first item, so a form can say nothing
 * as deliberately as it says something.
 */
function ChoiceControl({
  field,
  items,
  draft,
  running,
  onDraft,
}: {
  field: ConfigFieldFacts;
  items: readonly ChoiceItem[];
  draft: string;
  running: boolean;
  onDraft: (draft: string) => void;
}) {
  return (
    <Select
      items={items}
      value={draft}
      disabled={running}
      onValueChange={(picked) => onDraft(picked ?? UNSET)}
    >
      <SelectTrigger size="sm" className="mono config-choice" aria-label={field.path}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className="mono">
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * A text box that offers values before anything is typed, and takes whatever is
 * typed: Coss UI's combobox with the draft as its input. Picking an item fills
 * the box; the box is what is saved, so a value the list does not know is as
 * good as one it does.
 */
function SuggestingControl({
  field,
  fallback,
  draft,
  running,
  onDraft,
}: {
  field: ConfigFieldFacts;
  fallback: string;
  draft: string;
  running: boolean;
  onDraft: (draft: string) => void;
}) {
  const suggestions = field.suggestions ?? [];
  return (
    <Combobox
      items={suggestions}
      inputValue={draft}
      onInputValueChange={(typed) => onDraft(typed)}
      value={suggestions.includes(draft) ? draft : null}
      onValueChange={(picked) => {
        if (picked !== null) onDraft(picked);
      }}
      disabled={running}
    >
      <ComboboxInput
        size="sm"
        className="mono"
        aria-label={field.path}
        placeholder={fallback}
        showClear={draft !== ""}
      />
      <ComboboxPopup>
        <ComboboxEmpty>Nothing offered matches; what is typed is what is saved.</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item} className="mono">
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
