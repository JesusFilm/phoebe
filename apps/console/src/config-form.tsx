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
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
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
                    onStart({
                      install: install.dir,
                      verb: "config set",
                      path: field.path,
                      value,
                      fingerprint: config.fingerprint,
                      ...(tenant === undefined ? {} : { tenant }),
                    })
                  }
                />
              ))}
            </section>
          ))}
          {receipt === null ? null : <ReceiptPanel receipt={receipt} />}
        </>
      )}
    </div>
  );
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

/** What a row's control holds, as text: the file's value, or nothing. */
function draftOf(field: ConfigFieldFacts): string {
  return field.state === "set" && field.value !== null && field.value !== undefined
    ? String(field.value)
    : "";
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

function ConfigFieldRow({
  field,
  running,
  onSave,
}: {
  field: ConfigFieldFacts;
  running: boolean;
  onSave: (value: string | number | boolean) => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(field));
  const value = valueOfDraft(field, draft);
  const changed = draft.trim() !== draftOf(field);
  const choices =
    field.type === "boolean" ? ["true", "false"] : field.type === "enum" ? field.values : undefined;
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
          {choices === undefined ? (
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
          ) : (
            <select
              className="config-choice mono"
              aria-label={field.path}
              value={draft}
              disabled={running}
              onChange={(event) => setDraft(event.target.value)}
            >
              {field.state === "unset" ? <option value="">{fallback}</option> : null}
              {choices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
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
