// The label a person adds to a PR to have the bench kind measure it (#989).
// Its own module so the observer can name it in a proposal's body without
// importing the kind. Phoebe never adds it: only the bench kind removes it,
// once a bench has finished.

export const BENCH_LABEL = "phoebe:bench";
