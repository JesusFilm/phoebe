// Nominal (branded) types for the three primitive slots that flow through the
// engine and were previously bare `string` / `number`: git commit SHAs, git
// branch refs, and PR numbers. Before branding, any two of these passed each
// other's parameter slot silently — a `headRefName` (branch) could be handed to
// a function expecting a `headSha`, and tsc said nothing.
//
// The brand is a compile-time-only phantom field; it has no runtime footprint.
// `asSha` / `asBranchRef` / `asPrNumber` are identity casts applied at the trust
// boundary — where `gh` output is parsed and where config values are loaded —
// so interior code carries the distinction that tsc then enforces end-to-end.
// See issue #14.

export type Sha = string & { readonly __brand: "Sha" };
export type BranchRef = string & { readonly __brand: "BranchRef" };
export type PrNumber = number & { readonly __brand: "PrNumber" };

export const asSha = (value: string): Sha => value as Sha;
export const asBranchRef = (value: string): BranchRef => value as BranchRef;
export const asPrNumber = (value: number): PrNumber => value as PrNumber;
