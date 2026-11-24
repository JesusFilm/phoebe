// PROTOTYPE — throwaway, map #914 ticket #919. Not production code.
//
// `?prototype=history&variant=A` turns the prototype on (dev builds only).
// The variant sits in the search string, so it survives the console's hash
// routing and a reload. The floating bar and ← → switch it.

import { useEffect, useState } from "react";

export const VARIANTS = [
  { key: "A", name: "History tab, filterable table" },
  { key: "B", name: "Inside pipelines, rail badge" },
  { key: "C", name: "Overview card and unit feed" },
  { key: "D", name: "A + C, B behind an expansion, stats button" },
] as const;

export type VariantKey = (typeof VARIANTS)[number]["key"];

export function prototypeOn(): boolean {
  if (!import.meta.env.DEV || typeof location === "undefined") return false;
  return new URLSearchParams(location.search).get("prototype") === "history";
}

function readVariant(): VariantKey {
  const raw = new URLSearchParams(location.search).get("variant");
  return VARIANTS.some((v) => v.key === raw) ? (raw as VariantKey) : "A";
}

const listeners = new Set<() => void>();

function setVariant(key: VariantKey): void {
  const params = new URLSearchParams(location.search);
  params.set("variant", key);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}${location.hash}`);
  for (const listener of listeners) listener();
}

/** The current variant, or null when the prototype is off. */
export function useVariant(): VariantKey | null {
  const [variant, set] = useState<VariantKey | null>(prototypeOn() ? readVariant() : null);
  useEffect(() => {
    if (!prototypeOn()) return;
    const listener = (): void => set(readVariant());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return variant;
}

function step(by: number): void {
  const index = VARIANTS.findIndex((v) => v.key === readVariant());
  const next = VARIANTS[(index + by + VARIANTS.length) % VARIANTS.length];
  if (next !== undefined) setVariant(next.key);
}

export function PrototypeSwitcher() {
  const variant = useVariant();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (variant === null) return null;
  const name = VARIANTS.find((v) => v.key === variant)?.name ?? "";
  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 12px",
        borderRadius: 999,
        background: "#111",
        color: "#fff",
        font: "13px system-ui, sans-serif",
        boxShadow: "0 4px 18px rgba(0,0,0,.35)",
      }}
    >
      <button
        type="button"
        onClick={() => step(-1)}
        style={barButton}
        aria-label="Previous variant"
      >
        ←
      </button>
      <span>
        PROTOTYPE {variant} ({name})
      </span>
      <button type="button" onClick={() => step(1)} style={barButton} aria-label="Next variant">
        →
      </button>
    </div>
  );
}

const barButton = {
  background: "transparent",
  color: "#fff",
  border: "1px solid #555",
  borderRadius: 999,
  padding: "0 8px",
  cursor: "pointer",
};
