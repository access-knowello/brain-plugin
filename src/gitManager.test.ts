import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { FileSystemAdapter } from "obsidian";
import { GitManager, type RemoteCredentials } from "./gitManager";

/**
 * These are real integration tests, not mocked unit tests: GitManager shells
 * out to the actual git binary (that's its whole job), so the only way to
 * genuinely catch a regression in it is to run it against real temp
 * directories and a real local bare repo standing in for "origin" — no
 * network involved, no CI dependency beyond git itself being on PATH (true
 * on every GitHub Actions runner).
 */

function fakeAdapter(basePath: string): FileSystemAdapter {
	return { getBasePath: () => basePath } as unknown as FileSystemAdapter;
}

async function mkVault(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "brain-test-vault-"));
}

async function mkBareRemote(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-test-remote-"));
	execFileSync("git", ["init", "--bare", dir]);
	return dir;
}

const creds = (remoteUrl: string): RemoteCredentials => ({ remoteUrl, token: "unused-for-local-transport" });

const tempDirs: string[] = [];
async function tracked(dir: Promise<string>): Promise<string> {
	const d = await dir;
	tempDirs.push(d);
	return d;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("GitManager — repo lifecycle", () => {
	it("init() creates a repo whose HEAD points to refs/heads/main, regardless of global init.defaultBranch", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));

		await manager.init();

		expect(await manager.isRepo()).toBe(true);
		const head = execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: vault }).toString().trim();
		expect(head).toBe("refs/heads/main");
	});

	it("ensureIdentity() is a no-op when both name and email are empty", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));

		await manager.ensureIdentity("", "");

		expect(await manager.isRepo()).toBe(false);
	});

	it("ensureIdentity() inits the repo if needed and sets local (not global) config", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));

		await manager.ensureIdentity("Test User", "test@example.com");

		expect(await manager.isRepo()).toBe(true);
		const name = execFileSync("git", ["config", "--local", "user.name"], { cwd: vault }).toString().trim();
		const email = execFileSync("git", ["config", "--local", "user.email"], { cwd: vault }).toString().trim();
		expect(name).toBe("Test User");
		expect(email).toBe("test@example.com");
	});
});

describe("GitManager — commitAll", () => {
	it("returns 0 and commits nothing when the working tree is clean", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));
		await manager.ensureIdentity("Test User", "test@example.com");

		const staged = await manager.commitAll("empty commit attempt");

		expect(staged).toBe(0);
	});

	it("stages and commits new/changed files, returning the staged count", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));
		await manager.ensureIdentity("Test User", "test@example.com");
		await fs.writeFile(path.join(vault, "note.md"), "hello");
		await fs.writeFile(path.join(vault, "note2.md"), "world");

		const staged = await manager.commitAll("add two notes");

		expect(staged).toBe(2);
		const log = execFileSync("git", ["log", "--oneline"], { cwd: vault }).toString().trim();
		expect(log).toContain("add two notes");
	});
});

describe("GitManager — vault scaffold", () => {
	it("creates the standard scaffold files on an empty vault", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));

		const created = await manager.scaffoldVault();

		expect(created.sort()).toEqual(
			[".gitignore", "index.md", "_agents/MEMORY.md", "_agents/vault-conventions.md"].sort()
		);
		await expect(fs.access(path.join(vault, "index.md"))).resolves.toBeUndefined();
	});

	it("is idempotent — never overwrites a file the vault already has", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));
		await fs.writeFile(path.join(vault, "index.md"), "my own content, don't touch");

		const created = await manager.scaffoldVault();

		expect(created).not.toContain("index.md");
		const content = await fs.readFile(path.join(vault, "index.md"), "utf-8");
		expect(content).toBe("my own content, don't touch");
	});
});

describe("GitManager — untrackIgnoredFiles", () => {
	it("returns an empty list when nothing tracked matches NEVER_TRACK_PATHS", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));
		await manager.ensureIdentity("Test User", "test@example.com");

		expect(await manager.untrackIgnoredFiles()).toEqual([]);
	});

	it("untracks a previously-committed never-track path without deleting it from disk", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));
		await manager.ensureIdentity("Test User", "test@example.com");
		await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
		await fs.writeFile(path.join(vault, ".obsidian", "workspace.json"), "{}");
		await manager.commitAll("accidentally committed per-machine state");

		const untracked = await manager.untrackIgnoredFiles();

		expect(untracked).toEqual([".obsidian/workspace.json"]);
		// still on disk — untrack is --cached only, never touches working tree
		await expect(fs.access(path.join(vault, ".obsidian", "workspace.json"))).resolves.toBeUndefined();
		const tracked2 = execFileSync("git", ["ls-files", ".obsidian/workspace.json"], { cwd: vault })
			.toString()
			.trim();
		expect(tracked2).toBe("");
	});
});

describe("GitManager — git binary resolution", () => {
	// Not exercised anywhere else in this suite, but it's the exact logic the
	// code comments warn not to regress (the 0.0.2->0.0.3 Windows-path-with-
	// spaces saga, see code/index.md) — worth its own coverage rather than
	// trusting type-level compatibility with the simple-git version in use.

	it("getBinaryStatus() starts at the unresolved default", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));

		expect(manager.getBinaryStatus()).toEqual({ path: "git", valid: false });
	});

	it("resolveGitBinary() with no override finds git on PATH", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));

		await manager.resolveGitBinary();

		expect(manager.getBinaryStatus()).toEqual({ path: "git", valid: true });
	});

	it("resolveGitBinary(explicitPath) trims surrounding quotes/whitespace and validates a real binary", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));
		const realGit = execFileSync("which", ["git"]).toString().trim();

		await manager.resolveGitBinary(`  "${realGit}"  `);

		expect(manager.getBinaryStatus()).toEqual({ path: realGit, valid: true });
	});

	it("resolveGitBinary(explicitPath) still works when that path contains a space — the Windows Program Files case", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));
		const realGit = execFileSync("which", ["git"]).toString().trim();
		const spacedDir = await tracked(fs.mkdtemp(path.join(os.tmpdir(), "brain-test-git binary with spaces-")));
		const spacedGitPath = path.join(spacedDir, "git");
		await fs.symlink(realGit, spacedGitPath);

		await manager.resolveGitBinary(spacedGitPath);

		expect(manager.getBinaryStatus()).toEqual({ path: spacedGitPath, valid: true });
	});

	it("resolveGitBinary(explicitPath) records an invalid path as invalid rather than silently falling back", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));

		await manager.resolveGitBinary("/definitely/not/a/real/git/binary");

		expect(manager.getBinaryStatus()).toEqual({ path: "/definitely/not/a/real/git/binary", valid: false });
	});
});

describe("GitManager — remote wiring", () => {
	it("adds origin when absent, updates the url when origin already exists", async () => {
		const vault = await tracked(mkVault());
		const manager = new GitManager(fakeAdapter(vault));
		await manager.init();

		await manager.setRemote("https://example.invalid/first.git");
		expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: vault }).toString().trim()).toBe(
			"https://example.invalid/first.git"
		);

		await manager.setRemote("https://example.invalid/second.git");
		expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: vault }).toString().trim()).toBe(
			"https://example.invalid/second.git"
		);
	});
});

describe("GitManager — connect/push/pull round trip against a local bare remote", () => {
	let remote: string;

	beforeEach(async () => {
		remote = await tracked(mkBareRemote());
	});

	it("pushes a fresh vault's history to an empty remote, then a second vault connects and receives it", async () => {
		const vaultA = await tracked(mkVault());
		const a = new GitManager(fakeAdapter(vaultA));
		await a.ensureIdentity("Author A", "a@example.com");
		await fs.writeFile(path.join(vaultA, "hello.md"), "from vault A");
		await a.commitAll("initial content");
		await a.push(creds(remote));

		const vaultB = await tracked(mkVault());
		const b = new GitManager(fakeAdapter(vaultB));
		await b.connectExisting(creds(remote));

		const content = await fs.readFile(path.join(vaultB, "hello.md"), "utf-8");
		expect(content).toBe("from vault A");
	});

	it("propagates a later push from one vault to another via pull()", async () => {
		const vaultA = await tracked(mkVault());
		const a = new GitManager(fakeAdapter(vaultA));
		await a.ensureIdentity("Author A", "a@example.com");
		await fs.writeFile(path.join(vaultA, "hello.md"), "v1");
		await a.commitAll("v1");
		await a.push(creds(remote));

		const vaultB = await tracked(mkVault());
		const b = new GitManager(fakeAdapter(vaultB));
		await b.connectExisting(creds(remote));

		await fs.writeFile(path.join(vaultA, "hello.md"), "v2");
		await a.commitAll("v2");
		await a.push(creds(remote));

		await b.pull(creds(remote));
		const content = await fs.readFile(path.join(vaultB, "hello.md"), "utf-8");
		expect(content).toBe("v2");
	});

	it("connectExisting merges unrelated histories when both sides already have independent commits", async () => {
		const vaultA = await tracked(mkVault());
		const a = new GitManager(fakeAdapter(vaultA));
		await a.ensureIdentity("Author A", "a@example.com");
		await fs.writeFile(path.join(vaultA, "shared.md"), "from A");
		await a.commitAll("A's history");
		await a.push(creds(remote));

		// vaultB already has its own unrelated local commit before connecting —
		// exactly the real "existing vault joins a brain" scenario.
		const vaultB = await tracked(mkVault());
		const b = new GitManager(fakeAdapter(vaultB));
		await b.ensureIdentity("Author B", "b@example.com");
		await fs.writeFile(path.join(vaultB, "local-note.md"), "already here before connecting");
		await b.commitAll("B's pre-existing history");

		await b.connectExisting(creds(remote));

		await expect(fs.access(path.join(vaultB, "shared.md"))).resolves.toBeUndefined();
		await expect(fs.access(path.join(vaultB, "local-note.md"))).resolves.toBeUndefined();
	});
});
