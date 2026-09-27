# Domain Docs

This repository uses a single-context layout: one root `CONTEXT.md` glossary and ADRs in `docs/adr/`.

## Before exploring

- Read the root `CONTEXT.md` for domain terms.
- Read ADRs in `docs/adr/` that apply to the work.
- If a referenced domain file is absent, proceed; `/domain-modeling` creates domain files when terms or decisions are resolved.

## Layout

    /
    ├── CONTEXT.md
    └── docs/
        └── adr/
            └── 0001-example-decision.md

## Vocabulary and decisions

Use the glossary's terms in issues, plans, tests, and implementation. If a needed term is missing, reconsider the term or record the gap for `/domain-modeling`.

Surface any conflict with an applicable ADR explicitly, with the reason to reopen the decision.
