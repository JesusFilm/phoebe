The `bench` kind never starts an agent with this prompt. Each trial in a bench
uses its contender's own `issues` prompt: the default branch's for `main`, the
PR head's for `pr`. This file exists because every scheduled kind names a
prompt the engine checks at boot.
