# Brain Sync — Obsidian Plugin

Shared, git-backed sync for an organization's Obsidian vault. Not published to the Obsidian community plugin store yet; this covers manual/dev installs only.

## Current status

No SSO yet — you manually create a GitHub App installation token (or a fine-grained PAT) and paste it into plugin settings.

## Requirements

- Desktop Obsidian only (`isDesktopOnly: true` — the plugin shells out to a real `git` binary via `simple-git`, which isn't available on mobile).
- A local folder to use as your vault, already (or about to be) connected to a `Knowello-Brain/<tenant-repo>` GitHub repo.
- A GitHub App installation token or fine-grained PAT scoped to that repo (Contents read/write).

## Install — team rollout via BRAT (recommended)

For anyone other than the one person doing dev work on the plugin itself, install via **BRAT** (Beta Reviewers Auto-update Tester) instead of the manual build-and-copy process below. BRAT is itself an ordinary, published Obsidian community plugin whose whole job is installing *other* plugins straight from a GitHub repo's releases — it's the standard way to distribute a plugin that isn't in the official community directory yet.

### One-time: publish this repo so BRAT can see it

This repo isn't pushed anywhere yet, so this has to happen once before anyone can BRAT-install it.

1. **Create the GitHub repo.** `gh` CLI here is authenticated as a personal account, which can't create repos under `access-knowello` — create it in the browser instead, logged in as `access-knowello`, at `https://github.com/new` → name it `brain-plugin` → **private**.

2. **Push the existing local code:**
   ```bash
   cd ~/workspace/knowello/brain-plugin
   git init
   git branch -m main
   git config user.name "Knowello Access"
   git config user.email "access@knowello.com.au"
   git remote add origin git@brolli:access-knowello/brain-plugin.git
   git add .
   git commit -m "Initial commit"
   git push -u origin main
   ```

3. **Cut a release** — this is the part BRAT actually reads; it does not clone the repo or read off the `main` branch directly.
   - Build first: `npm run build` (produces `main.js`, gitignored from the repo itself but that's fine — release assets are uploaded separately from tracked files).
   - The git tag **must exactly match** the `version` field in `manifest.json` (currently `0.0.1`) — this is how BRAT and Obsidian itself determine what's "newer."
   - Tag and push the tag:
     ```bash
     git tag 0.0.1
     git push origin 0.0.1
     ```
   - Create the GitHub Release with **`main.js` and `manifest.json` attached as individual release assets** (not a source zip — BRAT downloads these two files by name from the release, nothing else). Since `gh` is on the `groky` account and can't act on `access-knowello` repos, do this in the browser: go to the repo → **Releases → Draft a new release** → choose the `0.0.1` tag → attach `main.js` and `manifest.json` from `~/workspace/knowello/brain-plugin/` as binary attachments → publish.

### Each teammate, one time

1. Install **BRAT** itself the normal way: Obsidian Settings → Community plugins → Browse → search "BRAT" → install → enable.
2. BRAT's settings → **Add Beta Plugin** → enter `access-knowello/brain-plugin` (just `owner/repo`, no URL) → BRAT fetches the latest release's `manifest.json`/`main.js` and installs Brain Sync like any other plugin.
   - This repo is **private**, so BRAT needs its own separate GitHub PAT first: generate one (classic, `repo` scope is simplest) from your own GitHub account and paste it into BRAT's settings, or the fetch will fail.
3. From here, follow the "Enable it in Obsidian" → "Configure it" steps below as normal (still needs the vault-scoping step and a sync token — BRAT only solves *getting the plugin installed*, not the auth/token question).

### Shipping an update later

Bump `version` in `manifest.json`, rebuild, tag and push a new tag matching the new version, cut a new GitHub Release with the new `main.js`/`manifest.json` attached. Teammates' BRAT either auto-checks periodically or they can run BRAT's "Check for updates" command manually.

## Install (manual, for plugin development)

1. **Build the plugin:**
   ```bash
   cd ~/workspace/knowello/brain-plugin
   npm install
   npm run build
   ```
   This produces `main.js` alongside the existing `manifest.json`.

2. **Give the target vault its own `.obsidian` config, separate from any other vault.** Obsidian scopes to whatever folder you open as a vault — if your vault folder lives inside a larger personal vault (e.g. a `knowello` subfolder inside a bigger `ObsVault`), open *that specific subfolder* as its own vault via **File → Open Vault → Open folder as vault**, rather than opening the parent. Registering a brand-new vault this way has to be done through this dialog — Obsidian's `obsidian://open?path=...` URI does not add a vault it's never seen before.

3. **Copy the built plugin into that vault:**
   ```bash
   mkdir -p "<vault>/.obsidian/plugins/brain-sync"
   cp main.js manifest.json "<vault>/.obsidian/plugins/brain-sync/"
   ```

4. **Enable it in Obsidian:** Settings → Community plugins → trust/enable community plugins if prompted → toggle **Brain Sync** on.

5. **Configure it:** open the Brain Sync settings tab, turn on **"Reveal connection details"** (off by default — a power-user escape hatch, not the intended end-user flow), and fill in:
   - **Remote URL** — `https://github.com/Knowello-Brain/<tenant-repo>.git`
   - **Token** — a GitHub App installation token or fine-grained PAT (see below)
   - **Branch** — `main`

6. **Sync:** click **Sync now**, or turn on **Auto-sync** and set an interval. Auto-sync polls on a timer (`setInterval`) — it is not triggered by file saves.

## Troubleshooting: "couldn't find git" / `spawn git ENOENT`

Obsidian (like most GUI apps) can launch with a minimal `PATH` that doesn't match what your Terminal/PowerShell sees — so git can work fine on the command line but still be invisible to the plugin. The plugin auto-detects git at startup (trying the plain `git` command, then a few common per-OS install locations), but if that still fails:

1. Confirm git is actually installed: run `git --version` in Terminal (Mac/Linux) or PowerShell/Command Prompt (Windows). If it prompts to install something, do that first.
2. Find the full path: `which git` (Mac/Linux) or `where.exe git` (Windows).
3. Paste that full path into Brain Sync settings → **Troubleshooting → Git binary path**, then try **Sync now** again.

Common Windows-specific cause: if Git for Windows was installed without the "Git from the command line" PATH option, or if only GitHub Desktop is installed (its bundled git isn't exposed system-wide), `git` won't resolve automatically — the manual path override above is the fix either way.

**Setting "Git binary path" to the correct path still doesn't work (fixed in `0.0.3`):** if you set this to the standard Windows location — `C:\Program Files\Git\cmd\git.exe` — and Sync still fails, that wasn't a mistake in the path. `simple-git` (the library this plugin uses) rejects any custom binary path containing a space by default, and "Program Files" always has one. `gitManager.ts` now passes `unsafe: { allowUnsafeCustomBinary: true }` specifically to allow this — safe here because the path only ever comes from the plugin's own local settings, never a remote/untrusted source. Make sure you're on `0.0.3` or later.

## Getting a token

Two options, both scoped to just the one tenant repo:

- **GitHub App installation token** (expires in ~1 hour):
  ```bash
  node scripts/mint-installation-token.mjs --app-id <id> --key .secrets/knowello-brain-sync.pem --repo Knowello-Brain/<repo>
  ```
  Fine for a one-off test; impractical for real day-to-day use since it needs re-minting hourly by hand.

- **Fine-grained PAT** (recommended for ongoing dogfood use): create it yourself in GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens, scoped to only `Knowello-Brain/<repo>` with Contents read/write. Long-lived, no re-minting.

## Connecting a vault that doesn't have a repo yet

If the vault folder isn't connected to a `Knowello-Brain` repo at all yet (brand new tenant, or reconnecting an existing folder), use the connect script instead of doing it by hand — it mints a token, then runs the exact init/fetch/merge-unrelated-histories/push sequence the plugin's own `connectExisting()` performs, and handles both an existing-history merge and a brand-new empty repo:

```bash
node scripts/connect-vault-to-brain.mjs \
  --vault <path> \
  --app-id <id> \
  --key .secrets/knowello-brain-sync.pem \
  --repo Knowello-Brain/<repo> \
  --author-name "<name>" \
  --author-email <email> \
  [--push]
```

Dry-run by default (everything up to the local merge) — pass `--push` to actually push.

## Companion: the `brain-vault-standard` Claude Code Skill

On first connect, this plugin scaffolds a standard vault layout (`index.md`, `_claude/MEMORY.md`, `_claude/vault-conventions.md`) so any Brain vault is organized the same way. To have Claude Code actually *recognize* that layout and apply the same conventions when writing Project Notes and Code Maps, install the companion Skill at `claude-skill/brain-vault-standard/` — see that folder's own `README.md` for install steps. It's a separate, optional install (not bundled into the Obsidian plugin itself), same lightweight manual-install approach as this plugin uses pre-BRAT.

## What this plugin does *not* do (yet)

- No SSO / sign-in — the remote URL and token are entered manually in settings.
- No conflict-resolution UI — a raw git merge conflict is what you'll see if two people edit the same note offline at the same time.
- No binary/attachment handling beyond whatever plain git does.
