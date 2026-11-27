// The grouping run's output (#934): the findings it wrote to scratch, checked
// by code before anything is filed. A finding names a category and a target,
// and the two make its key, so both are held to a shape that fits in a marker.

/** Where the fix for a finding belongs. */
export const CATEGORIES = ["ticket", "convention", "factory", "engine"] as const;
export type Category = (typeof CATEGORIES)[number];

/** What each category means, as a proposal states it. */
export const CATEGORY_TEXT: Record<Category, string> = {
  ticket: "ticket defect: the tickets left out something the work needed",
  convention: "missing repo convention: the fix belongs in `AGENTS.md` or a repo-authored skill",
  factory: "factory defect: the fix belongs in `prompts/` or the governing `phoebe.config.ts`",
  engine: "engine defect: the fix belongs in Phoebe itself",
};

/** A target: a path or a short slug, no spaces, nothing that could close a comment. */
export const TARGET_RE = /^[A-Za-z0-9._/@+#-]{1,100}$/;

/** The longest title a proposal takes from a finding. */
export const TITLE_MAX = 120;

/** The draft file the grouping run writes. */
export const FINDINGS_FILE = "findings.json";

export type Finding = {
  category: Category;
  target: string;
  /** `<category>:<target>`, the dedupe key. */
  key: string;
  title: string;
  problem: string;
  fix: string;
  /** The flagged units' ids as the run was shown them (`u1`, `u2`, …). */
  units: string[];
};

/**
 * A problem the grouping run left out because its fix merged after the units
 * that showed it. Nothing is filed from one; the run summary lists it so a
 * person can check the omission was deliberate.
 */
export type Omission = {
  /** The cause, in one sentence. */
  cause: string;
  /** The PR, commit or issue that fixed it (`#872`, `abc1234`). */
  fixedBy: string;
  /** The flagged units' ids that showed it. */
  units: string[];
};

export type ParsedFindings = {
  findings: Finding[];
  omitted: Omission[];
  /** One line for each finding or omission that was dropped, and why. */
  dropped: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the draft. A draft that is not JSON, has no `findings` array, or has an
 * `omitted` that is not an array throws, which fails the run: there is nothing
 * to trust in it. A finding or omission that breaks the rules is dropped with
 * a reason and the rest still stand. Two findings on one key are one finding,
 * their units merged.
 */
export function parseFindings(raw: string, knownUnits: ReadonlySet<string>): ParsedFindings {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${FINDINGS_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value) || !Array.isArray(value["findings"])) {
    throw new Error(`${FINDINGS_FILE} has no \`findings\` array.`);
  }

  const byKey = new Map<string, Finding>();
  const dropped: string[] = [];
  value["findings"].forEach((entry: unknown, index: number) => {
    const at = `finding ${index + 1}`;
    if (!isRecord(entry)) {
      dropped.push(`${at}: not an object`);
      return;
    }
    const category = entry["category"];
    if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category)) {
      dropped.push(
        `${at}: category ${JSON.stringify(category)} is not one of ${CATEGORIES.join(", ")}`,
      );
      return;
    }
    const target = text(entry["target"]);
    if (!TARGET_RE.test(target)) {
      dropped.push(`${at}: target ${JSON.stringify(entry["target"])} is not a path or slug`);
      return;
    }
    const title = text(entry["title"]).replace(/\s+/g, " ");
    if (title === "") {
      dropped.push(`${at}: no title`);
      return;
    }
    const units = Array.isArray(entry["units"])
      ? [...new Set(entry["units"].filter((id): id is string => knownUnits.has(id as string)))]
      : [];
    if (units.length === 0) {
      dropped.push(`${at}: names none of the flagged units`);
      return;
    }
    const key = `${category}:${target}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.units = [...new Set([...existing.units, ...units])];
      return;
    }
    byKey.set(key, {
      category: category as Category,
      target,
      key,
      title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title,
      problem: text(entry["problem"]),
      fix: text(entry["fix"]),
      units,
    });
  });
  const omitted = parseOmitted(value["omitted"], knownUnits, dropped);
  return { findings: [...byKey.values()], omitted, dropped };
}

/** The draft's `omitted` list: absent is none, anything but a list throws. */
function parseOmitted(
  raw: unknown,
  knownUnits: ReadonlySet<string>,
  dropped: string[],
): Omission[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${FINDINGS_FILE} has an \`omitted\` that is not an array.`);
  }
  const omitted: Omission[] = [];
  raw.forEach((entry: unknown, index: number) => {
    const at = `omission ${index + 1}`;
    if (!isRecord(entry)) {
      dropped.push(`${at}: not an object`);
      return;
    }
    const cause = text(entry["cause"]).replace(/\s+/g, " ");
    if (cause === "") {
      dropped.push(`${at}: no cause`);
      return;
    }
    const fixedBy = text(entry["fixedBy"]).replace(/\s+/g, " ");
    if (fixedBy === "") {
      dropped.push(`${at}: no fixedBy`);
      return;
    }
    const units = entry["units"] ?? [];
    if (!Array.isArray(units)) {
      dropped.push(`${at}: units is not a list`);
      return;
    }
    omitted.push({
      cause,
      fixedBy,
      units: [...new Set(units.filter((id): id is string => knownUnits.has(id as string)))],
    });
  });
  return omitted;
}
