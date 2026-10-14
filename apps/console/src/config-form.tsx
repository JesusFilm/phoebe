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
  ConfigEditValue,
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
  value: SavedValue;
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

/** What a row may save. Not `null`: an empty control is "nothing to save", not a write. */
export type SavedValue = Exclude<ConfigEditValue, null>;

/**
 * The select item that stands for the list rather than for a value of its own
 * (#655). A field carrying `listAlternative` offers it beside the closed set,
 * and picking it reveals the box the list is typed in. Picked is a state of the
 * control, not a value — nothing by this name reaches the config — so the name
 * has to stay outside the values of any field that offers it.
 */
export const LIST_ITEM = "prefixes";

/** Whether this row offers the list item at all — the catalogue's flag, nothing else. */
function offersList(field: Pick<ConfigFieldFacts, "listAlternative">): boolean {
  return field.listAlternative === true;
}

/**
 * What a row's control holds, as text: the file's value, or nothing.
 *
 * A list is two different things depending on the row. Where the row offers the
 * list item, the select holds the item and the list itself lives in the box
 * beside it. Where it does not — a locked row over a list the console never
 * offers to change, like the fleet's tenants — the list is the text.
 */
function draftOf(field: ConfigFieldFacts): string {
  if (Array.isArray(field.value)) {
    return offersList(field) ? LIST_ITEM : field.value.join(", ");
  }
  return field.state === "set" && field.value !== null && field.value !== undefined
    ? String(field.value)
    : "";
}

/**
 * The items a row's control offers, or `undefined` when it is a box rather
 * than a list of choices. A field that also takes a list offers one more item
 * than it has values — the list itself (#655).
 */
export function choicesOf(
  field: Pick<ConfigFieldFacts, "type" | "values" | "listAlternative">,
): readonly string[] | undefined {
  if (field.type === "boolean") return ["true", "false"];
  if (field.type !== "enum") return undefined;
  const values = field.values ?? [];
  return offersList(field) ? [...values, LIST_ITEM] : values;
}

/**
 * What the list box holds before anything is typed: the list the file already
 * holds, else the prefill the companion read off the path the catalogue names
 * (`prScope`'s is `branchPrefix`), so the literal default is on screen rather
 * than implied.
 */
export function listDraftOf(field: ConfigFieldFacts): string {
  const current = Array.isArray(field.value) ? field.value : field.listPrefill;
  return (current ?? []).join(", ");
}

/** A comma-separated list as the config holds it: trimmed, with blanks dropped. */
export function listOfDraft(draft: string): string[] {
  return draft
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
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
  onSave: (value: SavedValue) => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(field));
  const [listDraft, setListDraft] = useState(() => listDraftOf(field));
  // The list is picked, not typed, so its own box only speaks when the select
  // is on it — and then it speaks instead of the select, whose value is the
  // item name rather than anything the config would hold.
  const listing = offersList(field) && draft === LIST_ITEM;
  const value: ConfigEditValue = listing ? listOfDraft(listDraft) : valueOfDraft(field, draft);
  const changed = listing
    ? draft !== draftOf(field) || listDraft.trim() !== listDraftOf(field).trim()
    : draft.trim() !== draftOf(field);
  const choices = choicesOf(field);
  const fallback = field.default === undefined ? "not set" : String(field.default);
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
          {choices !== undefined ? (
            <>
              <ChoiceControl
                field={field}
                choices={choices}
                fallback={fallback}
                draft={draft}
                running={running}
                onDraft={setDraft}
              />
              {listing ? (
                <Input
                  size="sm"
                  className="mono"
                  aria-label={`${field.path} ${LIST_ITEM}`}
                  value={listDraft}
                  placeholder={`comma-separated ${LIST_ITEM}`}
                  disabled={running}
                  onChange={(event) => setListDraft(event.target.value)}
                />
              ) : null}
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

/** The empty draft, as the select knows it: an item of its own, so unset stays pickable. */
const UNSET = "";

/**
 * A closed set of values, as Coss UI's select rather than the browser's own,
 * whose popup follows the OS and not the console's theme. An unset setting
 * offers what applies without it as the first item, so a form can say nothing
 * as deliberately as it says something.
 */
function ChoiceControl({
  field,
  choices,
  fallback,
  draft,
  running,
  onDraft,
}: {
  field: ConfigFieldFacts;
  choices: readonly string[];
  fallback: string;
  draft: string;
  running: boolean;
  onDraft: (draft: string) => void;
}) {
  // The unset item says it is unset, and what applies: a default of `false`
  // must not read as one more `false` in the list.
  const unsetLabel = field.default === undefined ? "not set" : `not set (${fallback})`;
  const items = [
    ...(field.state === "unset" ? [{ value: UNSET, label: unsetLabel }] : []),
    ...choices.map((choice) => ({ value: choice, label: choice })),
  ];
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
