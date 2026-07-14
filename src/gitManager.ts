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
 * Standard vault-root scaffold, mirrored from
 * products/brain/_claude/vault-convention-spec.md in the vault — that doc is
 * the source of truth; update both together if either drifts.
 */
const SCAFFOLD_FILES: Record<string, string> = {
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

	constructor(adapter: FileSystemAdapter) {
		this.basePath = adapter.getBasePath();
		this.git = simpleGit({ baseDir: this.basePath });
	}

	/** Whatever binary path resolveGitBinary() last settled on — for display in settings, not used for git calls. */
	getBinaryPath(): string {
		return this.binaryPath;
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
		const trimmed = explicitPath?.trim();
		if (trimmed) {
			this.setBinary(trimmed);
			return;
		}

		if (await this.binaryWorks("git")) {
			this.setBinary("git");
			return;
		}

		for (const candidate of this.candidatePaths()) {
			const exists = await fs
				.access(candidate)
				.then(() => true)
				.catch(() => false);
			if (!exists) continue;
			if (await this.binaryWorks(candidate)) {
				this.setBinary(candidate);
				return;
			}
		}

		// Nothing worked — leave "git" as the binary so the eventual ENOENT
		// surfaces normally; the caller (main.ts) turns that into a Notice
		// pointing at the manual override setting.
		this.setBinary("git");
	}

	private setBinary(binary: string): void {
		this.binaryPath = binary;
		this.git = simpleGit({ baseDir: this.basePath, binary });
	}

	private async binaryWorks(binary: string): Promise<boolean> {
		try {
			await simpleGit({ binary }).version();
			return true;
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

	async init(): Promise<void> {
		await this.git.init();
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
		if (!(await this.isRepo())) await this.init();
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
		await this.git.raw([...this.authArgs(creds.token), "pull", "origin", branch]);
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
}
