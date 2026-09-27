# Issue tracker: GitHub

Issues, specs, and implementation tickets live in this repository's GitHub Issues. Run `gh` from this checkout so it selects the repository from `origin`.

## Operations

- Create: `gh issue create --title "..." --body-file <path>`.
- Read: `gh issue view <number> --comments`; use `--json number,title,body,labels,comments` when structured data is needed.
- List: `gh issue list --state open --json number,title,body,labels`, adding label or state filters as needed.
- Comment: `gh issue comment <number> --body-file <path>`.
- Add or remove a label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

Use a body file for multiline issue text.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to `yes` if external PRs should enter the triage queue.

When enabled, inspect an external PR with `gh pr view` and `gh pr diff`, then use the corresponding `gh pr` comment, label, and close commands. Include external contributors; exclude owner, member, and collaborator work. GitHub shares issue and PR numbers, so identify the item type before acting on a bare number.

## Skill instructions

- “Publish to the issue tracker” means create a GitHub issue.
- “Fetch the relevant ticket” means read the referenced issue and its comments.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child tickets.

- Map: an issue labelled `wayfinder:map` containing Notes, Decisions-so-far, and Fog.
- Child: a GitHub sub-issue linked to the map and labelled `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). If sub-issues are unavailable, link it from a task list in the map and put `Part of #<map>` in its body.
- Blocking: use native issue dependencies. If unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body.
- Frontier: inspect the map's open children in map order; choose the first unassigned child with no open blockers.
- Claim: assign the child to `@me` before starting work.
- Resolve: comment with the answer, close the child, and add a short pointer to the map's Decisions-so-far.
