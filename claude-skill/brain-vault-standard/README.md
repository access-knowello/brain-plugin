# brain-vault-standard — Claude Code Skill

Teaches Claude Code the Brain vault convention: how to recognize a Brain-synced vault, the standard directory/document layout, and how to write Project Notes and Code Maps in a consistent format. Complements the Brain Sync Obsidian plugin (`../../`), which scaffolds the vault-root files this skill recognizes on first connect.

Full convention this skill implements: `skills/brain-vault-standard/SKILL.md`. Design rationale (why this exists, what's scaffolded vs. what the skill teaches ad hoc): `products/brain/_claude/vault-convention-spec.md` in the Brain product vault (Knowello-internal, not needed to use the skill).

No marketplace listing yet — install manually, same as the plugin pre-BRAT. Revisit once Brain has external (non-Knowello) users.

## Install

1. Copy (or symlink) this whole folder into `~/.claude/skills/`:
   ```bash
   cp -r claude-skill/brain-vault-standard ~/.claude/skills/brain-vault-standard
   ```
   Symlink instead of copy if you want to pick up updates without re-copying:
   ```bash
   ln -s "$(pwd)/claude-skill/brain-vault-standard" ~/.claude/skills/brain-vault-standard
   ```

2. Enable it in `~/.claude/settings.json` under `enabledPlugins`:
   ```json
   {
     "enabledPlugins": {
       "brain-vault-standard@local": true
     }
   }
   ```

3. Restart Claude Code (or start a new session) so it picks up the newly enabled skill.

## Usage

Once enabled, Claude applies this skill automatically whenever it's working inside a vault that has a root `_claude/MEMORY.md` and `_claude/vault-conventions.md` (the plugin scaffolds both on first connect) — no need to invoke it by name.

Two things worth knowing explicitly:

- **Starting a new project inside the vault:** just start working — Claude will recognize the vault and offer to scaffold that project's own `index.md` / `_claude/MEMORY.md` / `_claude/code/index.md` once there's real code to map.
- **Registering the vault in your global CLAUDE.md:** this is the one action the skill never takes automatically. Ask explicitly — "register this vault" or "make Claude recognize my Brain vault" — and Claude will show you the exact diff to `~/.claude/CLAUDE.md` before writing it.
