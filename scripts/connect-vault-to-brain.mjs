#!/usr/bin/env node
// Captures the exact sequence used to connect an existing Obsidian vault to a
// brain repo — proven manually against Knowello-Brain/knowello-brain for the
// real Knowello vault. Mirrors src/gitManager.ts's connectExisting(): init +
// fetch + merge --allow-unrelated-histories, since a real `git clone` refuses
// to run into a non-empty directory (which a vault always is — .obsidian/,
// existing notes, ...). Handles a brand-new empty tenant repo too (skips the
// merge if the remote branch doesn't exist yet).
//
// Usage:
//   node scripts/connect-vault-to-brain.mjs \
//     --vault ~/obsidian/ObsVault/knowello \
//     --app-id 4271996 --key .secrets/knowello-brain-sync.pem \
//     --repo Knowello-Brain/knowello-brain \
//     --author-name "Kyle" --author-email kyle@knowello.com.au \
//     [--branch main] [--message "Import vault content"] [--push]
//
// Without --push this is a dry run: everything up to and including the local
// merge happens, nothing is sent to GitHub.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mintInstallationToken, authHeaderArgs } from "./lib/githubApp.mjs";

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		if (!argv[i].startsWith("--")) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			args[key] = true;
		} else {
			args[key] = next;
			i += 1;
		}
	}
	return args;
}

function git(cwd, extraArgs, gitArgs) {
	return execFileSync("git", [...extraArgs, ...gitArgs], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { vault, repo } = args;
	const appId = args["app-id"];
	const keyPath = args.key;
	const branch = args.branch || "main";
	const message = args.message || "Import vault content";
	const authorName = args["author-name"];
	const authorEmail = args["author-email"];
	const doPush = Boolean(args.push);

	if (!vault || !appId || !keyPath || !repo || !repo.includes("/") || !authorName || !authorEmail) {
		console.error(
			"Usage: node connect-vault-to-brain.mjs --vault <path> --app-id <id> --key <pem> --repo <owner/name> " +
				"--author-name <name> --author-email <email> [--branch main] [--message '...'] [--push]"
		);
		process.exit(1);
	}

	const [owner, repoName] = repo.split("/");
	const remoteUrl = `https://github.com/${repo}.git`;

	console.log(`Minting installation token for ${repo}...`);
	const privateKeyPem = readFileSync(keyPath, "utf8");
	const tokenBody = await mintInstallationToken({ appId, privateKeyPem, owner, repoName });
	const auth = authHeaderArgs(tokenBody.token);
	console.log(`Token expires ${tokenBody.expires_at}`);

	if (!existsSync(`${vault}/.git`)) {
		console.log(`Initializing git repo in ${vault}...`);
		git(vault, [], ["init", "-q"]);
		git(vault, [], ["config", "user.name", authorName]);
		git(vault, [], ["config", "user.email", authorEmail]);
		git(vault, [], ["branch", "-m", branch]);
	}

	const remotes = git(vault, [], ["remote"]).split("\n").filter(Boolean);
	git(vault, [], remotes.includes("origin") ? ["remote", "set-url", "origin", remoteUrl] : ["remote", "add", "origin", remoteUrl]);

	// Commit any pending local changes before merging remote history, so the
	// merge has something of ours to reconcile against.
	if (git(vault, [], ["status", "--porcelain"]).trim().length > 0) {
		git(vault, [], ["add", "-A"]);
		git(vault, [], ["commit", "-q", "-m", message]);
		console.log(`Committed local changes: ${message}`);
	}

	console.log(`Fetching ${branch} from origin...`);
	let remoteHasBranch = true;
	try {
		git(vault, auth, ["fetch", "origin", branch]);
	} catch {
		remoteHasBranch = false;
		console.log(`origin has no ${branch} yet (empty repo) — nothing to merge.`);
	}

	if (remoteHasBranch) {
		console.log(`Merging origin/${branch} (allow-unrelated-histories)...`);
		try {
			git(vault, [], [
				"merge",
				`origin/${branch}`,
				"--allow-unrelated-histories",
				"-m",
				`Merge: connect vault to brain (${repo})`,
			]);
		} catch (err) {
			console.error("Merge failed — likely a real conflict, resolve manually:", err.message);
			process.exit(1);
		}
	}

	if (doPush) {
		console.log(`Pushing ${branch} to origin...`);
		git(vault, auth, ["push", "origin", branch]);
		console.log("Done.");
	} else {
		console.log(`Dry run complete (no --push passed) — ${branch} is up to date locally but not pushed.`);
	}
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
