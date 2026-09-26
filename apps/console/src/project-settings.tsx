// A project's own settings, above its tabs: what the rail calls it, and where it
// is. Laid out the way T3 Code's project config is, on Coss UI's fields: each
// setting a row with its name and a line about it on the left and the control
// on the right.
//
// Both are the companion's to keep, not the deployment's (#527 §12): the display
// name is a label on the rail and nowhere else, and the location is the folder
// the companion drives. Changing the location re-points the same entry at
// another folder — the date it was added and the name it was given come along;
// what the folder holds is read afresh, like everything else about an install.

import { useState } from "react";
import type { InstallPatch, LocalInstall } from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";

export function ProjectSettings({
  install,
  onUpdate,
  onPickLocation,
}: {
  install: LocalInstall;
  /** Save a change through the bridge. Rejects with the reason when main refuses. */
  onUpdate: (patch: InstallPatch) => Promise<void>;
  /** The folder picker, opened inside WSL for a WSL install. Null when dismissed. */
  onPickLocation: () => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(install.label ?? "");
  const [saving, setSaving] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const folderName = folderNameOf(install);
  const changed = draft.trim() !== (install.label ?? "");

  const save = async (patch: InstallPatch): Promise<void> => {
    setSaving(true);
    setTrouble(null);
    try {
      await onUpdate(patch);
    } catch (error) {
      setTrouble(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="project-settings" aria-label="This project">
      <Field className="project-row">
        <div className="project-row-text">
          <FieldLabel>Display name</FieldLabel>
          <FieldDescription>
            What the rail calls it. Empty means the folder&apos;s own name,{" "}
            <span className="mono">{folderName}</span>.
          </FieldDescription>
        </div>
        <form
          className="project-row-control"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ label: draft.trim() === "" ? null : draft.trim() });
          }}
        >
          <Input
            size="sm"
            value={draft}
            placeholder={folderName}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" variant="outline" size="sm" disabled={saving || !changed}>
            Save
          </Button>
        </form>
      </Field>
      <Field className="project-row">
        <div className="project-row-text">
          <FieldLabel>Location</FieldLabel>
          <FieldDescription>
            Points this entry at another folder. Nothing is moved on disk; the new folder is read as
            it stands, and the name above comes along.
          </FieldDescription>
        </div>
        <div className="project-row-control">
          <Input size="sm" className="mono" value={install.dir} readOnly title={install.dir} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => {
              // The picker itself can fail — a distro that is gone, a dialog
              // main could not open — and that reads like a refused save.
              void onPickLocation()
                .then((picked) => {
                  if (picked !== null && picked !== install.dir) return save({ dir: picked });
                  return undefined;
                })
                .catch((error: unknown) => {
                  setTrouble(error instanceof Error ? error.message : String(error));
                });
            }}
          >
            Change…
          </Button>
        </div>
      </Field>
      {trouble === null ? null : (
        <p className="trouble" role="alert">
          {trouble}
        </p>
      )}
    </section>
  );
}

/** The folder's own name, the way the rail would show it with no label set. */
function folderNameOf(install: LocalInstall): string {
  if (install.wsl !== undefined) return install.wsl.dir.split("/").pop() || install.wsl.distro;
  const segments = install.dir.split(/[\\/]+/).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? install.dir;
}
