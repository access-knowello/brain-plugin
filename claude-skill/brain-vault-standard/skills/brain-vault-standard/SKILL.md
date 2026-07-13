---
name: brain-vault-standard
description: >
  Use this skill whenever working inside a Brain-synced Obsidian vault (any
  vault containing a root `_claude/MEMORY.md` and `_claude/vault-conventions.md`
  — the Brain Sync plugin scaffolds these on first connect) or whenever the
  user asks to "set up a new project" inside such a vault, write a "project
  note", update a "code map", or asks to "register this vault" / "point
  Claude at my Brain vault" / "make Claude recognize my vault" in their
  global CLAUDE.md. Also use it when a note's frontmatter has
  `metadata.type: project`, `reference`, `user`, or `feedback` inside a Brain
  vault, since that's the vault's standard document taxonomy.
---

# Brain Vault Standard

Brain is a shared, git-backed Obsidian vault product. Every Brain vault follows the same directory and document conventions so any team member's Claude Code instantly understands the layout — this skill is what teaches Claude that convention, since it isn't obvious from the files alone until you've read them once.

## 1. Recognizing a Brain vault

A vault is Brain-managed if it has, at its root:
- `_claude/MEMORY.md` — the top-level memory index
- `_claude/vault-conventions.md` — a copy of the rules below, scaffolded by the plugin on first connect

If both are present, treat this skill's conventions as authoritative for anything you create in the vault. If only some projects inside a larger vault follow the pattern, apply it per-project rather than assuming the whole vault does.

## 2. Directory pattern

```
<vault-root>/
  index.md                     ← vault landing page
  _claude/
    MEMORY.md                  ← top-level memory index (which projects exist)
    vault-conventions.md       ← this convention, self-contained

  <project>/                    ← created ad hoc as real projects appear — never scaffold this upfront
    index.md                    ← project landing page
    _claude/
      MEMORY.md                 ← project memory index (wikilinks, not file paths)
      <project-notes>.md        ← e.g. implementation-plan.md, decisions.md — as needed
      code/
        index.md                ← repo layout + task→file navigation
        <domain-map>.md         ← e.g. api-routes.md, models.md — project/stack-specific, as needed
```

Three different `index.md` files, don't confuse them: `<project>/index.md` (human-facing Obsidian landing page), `<project>/_claude/MEMORY.md` (memory-system index), `<project>/_claude/code/index.md` (code map index — repo layout, task→file navigation, NOT a landing page).

## 3. When to create a new project's `_claude/` structure

When the user starts real work in a new subfolder of the vault (a new client engagement, product, or codebase) and it doesn't yet have a `_claude/` folder, offer to scaffold it: `index.md`, `_claude/MEMORY.md`, and `_claude/code/index.md` once there's actual code to map. Don't create `_claude/code/*.md` domain files (routes, models, etc.) speculatively — only once the project has enough shape that they'd contain real content.

## 4. Document types and when to write each

- **Project Notes** (`_claude/*.md`, not under `code/`) — knowledge layer: active work, gotchas, decisions. Update when something is *learned or decided*, not on a schedule.
- **Code Map** (`_claude/code/*.md`) — structural codebase index: repo layout, task→file navigation, route/model/store tables as the stack calls for. Update **in the same session** as the code change it documents — don't batch across sessions.
- **Memory Index** (`_claude/MEMORY.md`, per-project and vault-root) — use wikilinks (`[[note-name]]`), not file paths. Update whenever a new note or code map file is added. From the vault-root `MEMORY.md`, every project's memory file is literally named `MEMORY.md`, so a bare `[[MEMORY]]` link is ambiguous across projects (Obsidian resolves duplicate basenames unpredictably) — always use a path-qualified wikilink with a display alias instead: `[[<project>/_claude/MEMORY|<project>]]`. List only projects/notes that actually exist — don't pre-list placeholders for structure you haven't created yet.

Frontmatter on every standard doc:
```yaml
---
name: kebab-case-slug
description: one-line summary of what this note is for
metadata:
  type: project | reference | user | feedback
---
```
(`project`/`reference` cover most Code Map and Project Notes content; `user`/`feedback` are for anything that's actually about a person or a working-style correction, same taxonomy as Claude Code's own memory system.)

## 5. Registering the vault in the user's global CLAUDE.md — explicit action only

**Never do this automatically or silently.** Only perform it when the user explicitly asks (e.g. "register this vault", "make Claude recognize my Brain vault", "point my global CLAUDE.md at this vault"). This edits a file outside the current project (`~/.claude/CLAUDE.md`), which is exactly the kind of hard-to-reverse, shared-state action that needs a clear ask and a visible diff before writing — don't just do it as a side effect of some other task.

When asked:

1. Read `~/.claude/CLAUDE.md` (create it if it doesn't exist).
2. Check for an existing `<!-- brain:start -->` / `<!-- brain:end -->` block.
3. Build the block below, substituting the real absolute vault path:

```markdown
<!-- brain:start -->
## Brain Vault

- Your team's Brain vault lives at: `<absolute-vault-path>`
- **Project Notes** — `_claude/*.md` inside a project folder — knowledge layer: active work, gotchas, decisions. Update when something is *learned or decided*.
- **Code Map** — `_claude/code/*.md` inside a project folder — structural codebase index. Update when *code changes*.
- Each project's `_claude/MEMORY.md` is its memory index (wikilinks, not file paths); the vault-root `_claude/MEMORY.md` indexes the projects themselves.
- Full convention: `<absolute-vault-path>/_claude/vault-conventions.md`
<!-- brain:end -->
```

4. If the block already exists, replace only the content between the markers (idempotent — re-running this never duplicates or clobbers the rest of the user's CLAUDE.md). If it doesn't exist, append the block at the end of the file.
5. Show the user the exact diff before writing, and confirm — same bar as any other edit to a file they didn't ask you to open.

## Related

- The Brain Sync Obsidian plugin scaffolds the vault-root files this skill recognizes — see the plugin's own README for install/setup.
- Full spec this skill is derived from lives in the Brain product's own vault at `products/brain/_claude/vault-convention-spec.md` (Knowello-internal design doc — not shipped to customer vaults, this SKILL.md is the self-contained, customer-facing version of it).
