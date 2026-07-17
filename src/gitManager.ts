import type { FileSystemAdapter } from "obsidian";
import simpleGit, { type SimpleGit } from "simple-git";
import { promises as fs } from "fs";
import * as path from "path";

export interface RemoteCredentials {
	remoteUrl: string;
	/** GitHub App installation token (or PAT for Phase 1 manual testing). Never persisted to disk. */
	token: string;
}

export type SyncStatus = "idle" | "syncing" | "error";

/**
 * Per-machine Obsidian/plugin state that should never be shared between
 * team members — window layout, theme, enabled plugins, and each person's
 * own git-token-bearing plugin settings file. Single source of truth for
 * both the scaffolded .gitignore text below and untrackIgnoredFiles() —
 * gitignore alone isn't enough (it never retroactively untracks a path
 * that's already committed), so this list also has to be actively
 * re-applied on every sync. Keep this one list in sync with itself; don't
 * let the scaffolded .gitignore and untrackIgnoredFiles() drift apart.
 */
const NEVER_TRACK_PATHS = [
	".obsidian/workspace.json",
	".obsidian/app.json",
	".obsidian/appearance.json",
	".obsidian/core-plugins.json",
	".obsidian/community-plugins.json",
	".obsidian/graph.json",
	".obsidian/plugins",
];

/**
 * Standard vault-root scaffold, mirrored from
 * products/brain/_claude/vault-convention-spec.md in the vault — that doc is
 * the source of truth; update both together if either drifts.
 */
const SCAFFOLD_FILES: Record<string, string> = {
	".gitignore": `.DS_Store
# Per-machine Obsidian config (window layout, theme, enabled plugins,
# and each person's own plugin settings) — every fresh install generates
# these locally before Brain Sync ever runs; tracking them means every
# new teammate's first connect hits a merge conflict on files that were
# never meant to be shared. Kept in sync with NEVER_TRACK_PATHS in
# gitManager.ts, which actively re-untracks these on every sync too —
# gitignore alone doesn't retroactively untrack an already-committed path.
${NEVER_TRACK_PATHS.map((p) => (p.endsWith(".json") ? p : `${p}/`)).join("\n")}
`,
	"index.md": `# Welcome to your Brain

This vault is synced via **Brain** — your team's shared, version-controlled Obsidian vault.

- \`_claude/MEMORY.md\` — the memory index Claude reads at the start of a session
- \`_claude/vault-conventions.md\` — how this vault is organized

Start a new project by creating a folder for it, then giving it its own \`_claude/\` subfolder as it grows (see \`vault-conventions.md\`).
`,
	"_claude/MEMORY.md": `---
name: memory-index
description: Top-level memory index for this Brain vault
metadata:
  type: reference
---

# Memory Index

No projects yet. As you add project folders, list them here with a one-line description and a link to that project's own \`_claude/MEMORY.md\`.

- [[vault-conventions]] — how this vault is organized
`,
	"_claude/vault-conventions.md": `---
name: vault-conventions
description: How this Brain vault is organized — read this before creating new project structure
metadata:
  type: reference
---

# Vault Conventions

This vault follows a standard layout so Claude (and anyone on the team) can navigate it consistently.

## Structure

- \`index.md\` — this vault's landing page
- \`_claude/MEMORY.md\` — top-level memory index (wikilinks, not file paths)

Each project living in this vault gets its own subfolder with the same pattern, scaled up:

\`\`\`
<project>/
  index.md
  _claude/
    MEMORY.md
    <project-notes>.md      (e.g. implementation-plan.md, decisions.md)
    code/
      index.md              (repo layout + task→file navigation)
      <domain-map>.md       (e.g. api-routes.md, models.md — as the project needs)
\`\`\`

## Rules

- Update the relevant Code Map file in the same session as the code change it documents.
- Update MEMORY.md (vault-root or project-level) whenever a new note or code map file is added.
- Use wikilinks (\`[[note-name]]\`) in MEMORY.md, not file paths.
- Every project's memory file is literally named \`MEMORY.md\`, so from the vault-root index a bare \`[[MEMORY]]\` link is ambiguous across projects. Use a path-qualified wikilink with a display alias instead: \`[[<project>/_claude/MEMORY|<project>]]\`.
`,
};

/**
 * Thin wrapper over simple-git exposing only what Brain needs: no branches,
 * log, diff strings, or blame — the plugin never shows git vocabulary to the
 * user. Auth is injected per-command via an Authorization header rather than
 * the remote URL or .git/config, so a token never touches disk.
 */
export class GitManager {
	private git: SimpleGit;
	private basePath: string;
	private binaryPath = "git";
	private binaryValid = false;

	constructor(adapter: FileSystemAdapter) {
		this.basePath = adapter.getBasePath();
		this.git = simpleGit({ baseDir: this.basePath });
	}

	/** What resolveGitBinary() last settled on, and whether it actually ran successfully — for display in settings. */
	getBinaryStatus(): { path: string; valid: boolean } {
		return { path: this.binaryPath, valid: this.binaryValid };
	}

	/**
	 * GUI apps (Obsidian included) are often launched with a minimal PATH —
	 * on macOS from launchd, on Windows from the Start Menu/shortcut — that
	 * doesn't match a full interactive shell's PATH. So a plain `spawn("git",
	 * ...)` that works fine in Terminal/PowerShell can still ENOENT from
	 * inside the app. Resolve a working git binary once, preferring (in
	 * order): an explicit user-set override, the plain "git" on PATH, then a
	 * short list of common per-OS install locations. Safe to call again if
	 * the override setting changes.
	 */
	async resolveGitBinary(explicitPath?: string): Promise<void> {
		// Strip surrounding quotes too — a very common paste mistake (e.g.
		// copying `"C:\Program Files\Git\cmd\git.exe"` including the quotes
		// from a command's quoted output) produces a string that looks right
		// but isn't a real path, and previously would've been trusted as-is.
		const trimmed = explicitPath?.trim().replace(/^["']|["']$/g, "");
		if (trimmed) {
			const works = await this.binaryWorks(trimmed);
			this.setBinary(trimmed, works);
			return;
		}

		if (await this.binaryWorks("git")) {
			this.setBinary("git", true);
			return;
		}

		for (const candidate of this.candidatePaths()) {
			const exists = await fs
				.access(candidate)
				.then(() => true)
				.catch(() => false);
			if (!exists) continue;
			if (await this.binaryWorks(candidate)) {
				this.setBinary(candidate, true);
				return;
			}
		}

		// Nothing worked — leave "git" as the binary so the eventual ENOENT
		// surfaces normally; the caller (main.ts) turns that into a Notice
		// that now names the exact path that was tried.
		this.setBinary("git", false);
	}

	private setBinary(binary: string, valid: boolean): void {
		this.binaryPath = binary;
		this.binaryValid = valid;
		this.git = simpleGit({ baseDir: this.basePath, binary, unsafe: { allowUnsafeCustomBinary: true } });
	}

	private async binaryWorks(binary: string): Promise<boolean> {
		try {
			// simple-git's version() doesn't throw for a missing binary — it
			// swallows the spawn error internally and resolves with
			// `installed: false` instead. Checking for a thrown exception
			// here would always report success.
			//
			// allowUnsafeCustomBinary is required here too: simple-git's own
			// custom-binary validation rejects any path containing a space —
			// which every default Windows git install hits, since
			// "C:\Program Files\Git\cmd\git.exe" has one. That's not a typo
			// on the user's part, it's simple-git being conservative about
			// binary paths by default; the path still comes from the user's
			// own local settings, not an untrusted remote source, so it's
			// safe to relax here.
			const result = await simpleGit({ binary, unsafe: { allowUnsafeCustomBinary: true } }).version();
			return result.installed;
		} catch {
			return false;
		}
	}

	private candidatePaths(): string[] {
		switch (process.platform) {
			case "win32": {
				const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(
					(p): p is string => !!p
				);
				return programFiles.flatMap((base) => [
					path.join(base, "Git", "cmd", "git.exe"),
					path.join(base, "Git", "bin", "git.exe"),
				]);
			}
			case "darwin":
				return ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
			default:
				return ["/usr/bin/git", "/usr/local/bin/git", "/snap/bin/git"];
		}
	}

	private authArgs(token: string): string[] {
		const header = Buffer.from(`x-access-token:${token}`).toString("base64");
		return ["-c", `http.extraHeader=Authorization: Basic ${header}`];
	}

	async isRepo(): Promise<boolean> {
		return this.git.checkIsRepo();
	}

	async init(branch = "main"): Promise<void> {
		await this.git.init();
		// git init's default initial branch name depends on the machine's
		// global init.defaultBranch config — still "master" on plenty of
		// untouched installs (especially Windows), while Brain Sync assumes
		// "main" everywhere else. Rewire HEAD to the branch we actually
		// expect before any commit exists, so the first commit lands on the
		// right branch regardless of that config. This only works pre-first-
		// commit, which is exactly when init() runs; deliberately not using
		// `git init --initial-branch=main` since that flag needs git 2.28+
		// and symbolic-ref works on any version.
		await this.git.raw(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
	}

	/**
	 * Sets repo-local (not --global) author identity from the plugin's own
	 * settings, if provided — a fresh git install has no identity configured
	 * anywhere and refuses to commit ("Author identity unknown"), which is
	 * exactly the kind of raw git error Brain is supposed to hide. No-op if
	 * both fields are empty, so machines that already have a working global
	 * git identity (the common case) are left untouched. Ensures the repo
	 * exists first, since local `git config` requires one.
	 */
	async ensureIdentity(name: string, email: string, branch = "main"): Promise<void> {
		if (!name.trim() && !email.trim()) return;
		if (!(await this.isRepo())) await this.init(branch);
		if (name.trim()) await this.git.raw(["config", "user.name", name.trim()]);
		if (email.trim()) await this.git.raw(["config", "user.email", email.trim()]);
	}

	async setRemote(remoteUrl: string): Promise<void> {
		const remotes = await this.git.getRemotes();
		if (remotes.some((r) => r.name === "origin")) {
			await this.git.remote(["set-url", "origin", remoteUrl]);
		} else {
			await this.git.addRemote("origin", remoteUrl);
		}
	}

	/**
	 * A real `git clone` refuses to run into a non-empty directory, which the
	 * vault folder always is (.obsidian/, existing notes, ...). So "connecting"
	 * an existing vault to a brain repo is init + fetch + merge with unrelated
	 * histories allowed, not a literal clone.
	 */
	async connectExisting(creds: RemoteCredentials, branch = "main"): Promise<void> {
		if (!(await this.isRepo())) await this.init(branch);
		await this.setRemote(creds.remoteUrl);
		await this.git.raw([...this.authArgs(creds.token), "fetch", "origin", branch]);
		await this.git.raw([
			"merge",
			`origin/${branch}`,
			"--allow-unrelated-histories",
			"-m",
			"Merge: connect vault to brain",
		]);
	}

	async pull(creds: RemoteCredentials, branch = "main"): Promise<void> {
		await this.setRemote(creds.remoteUrl);
		// --no-rebase pins this to merge semantics explicitly (matching
		// connectExisting()'s own merge-based approach) rather than relying
		// on the machine's global pull.rebase/pull.ff config. Without it,
		// git refuses with "Need to specify how to reconcile divergent
		// branches" the moment local and remote histories diverge — which
		// commit-before-pull (see main.ts's syncNow()) makes the normal
		// case, not an edge case.
		//
		// --allow-unrelated-histories: a local repo that's been through a
		// partial/failed connect attempt (identity error, branch mismatch,
		// etc. — all real cases we've hit) can end up with commits that
		// share no ancestor with the remote, which a plain pull refuses
		// with "refusing to merge unrelated histories". In Brain's model a
		// vault's local and remote are always meant to be the same logical
		// history — there's no legitimate case here where they're genuinely
		// unrelated projects, so this guard only ever protects against
		// exactly that stuck-state class of error, never a real mistake.
		await this.git.raw([
			...this.authArgs(creds.token),
			"pull",
			"--no-rebase",
			"--allow-unrelated-histories",
			"origin",
			branch,
		]);
	}

	async push(creds: RemoteCredentials, branch = "main"): Promise<void> {
		await this.setRemote(creds.remoteUrl);
		await this.git.raw([...this.authArgs(creds.token), "push", "origin", branch]);
	}

	async commitAll(message: string): Promise<number> {
		await this.git.add(["-A"]);
		const status = await this.git.status();
		if (status.staged.length === 0) return 0;
		await this.git.commit(message);
		return status.staged.length;
	}

	async status() {
		return this.git.status();
	}

	/**
	 * Writes the standard vault-root scaffold (index.md, _claude/MEMORY.md,
	 * _claude/vault-conventions.md). Idempotent — only creates files that
	 * don't already exist — so it's safe to call on every first-connect
	 * without clobbering a vault that already has its own content there.
	 * Returns the list of files actually created.
	 */
	async scaffoldVault(): Promise<string[]> {
		const created: string[] = [];
		for (const [relPath, content] of Object.entries(SCAFFOLD_FILES)) {
			const fullPath = path.join(this.basePath, relPath);
			const exists = await fs
				.access(fullPath)
				.then(() => true)
				.catch(() => false);
			if (exists) continue;
			await fs.mkdir(path.dirname(fullPath), { recursive: true });
			await fs.writeFile(fullPath, content, "utf-8");
			created.push(relPath);
		}
		return created;
	}

	/**
	 * Untracks any of NEVER_TRACK_PATHS that are currently tracked — files
	 * only stay untracked by .gitignore until something re-tracks them, and
	 * merging in another machine's history is exactly that: a machine on an
	 * older plugin version, or one that hasn't synced since a teammate's
	 * connect attempt predating this fix, can reintroduce these paths on any
	 * pull. gitignore never retroactively removes an already-tracked path,
	 * so this has to be actively re-applied — safe to call after every
	 * sync, not just once. `--ignore-unmatch` makes this a no-op for
	 * anything not currently tracked, and `--cached` never touches the
	 * actual files on disk. Returns whatever was actually untracked, if
	 * anything, so the caller knows whether there's something new to
	 * commit.
	 */
	async untrackIgnoredFiles(): Promise<string[]> {
		const tracked = await this.git.raw(["ls-files", ...NEVER_TRACK_PATHS]).catch(() => "");
		if (!tracked.trim()) return [];
		await this.git.raw(["rm", "--cached", "-r", "--ignore-unmatch", ...NEVER_TRACK_PATHS]);
		return tracked.trim().split("\n");
	}
}
