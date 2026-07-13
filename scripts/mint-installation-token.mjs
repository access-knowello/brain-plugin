#!/usr/bin/env node
// Phase 0 dev tool: mints a GitHub App installation token scoped to one repo.
//
// Usage:
//   node scripts/mint-installation-token.mjs --app-id 123456 --key /path/to/private-key.pem --repo Knowello-Brain/knowello-brain

import { readFileSync } from "node:fs";
import { mintInstallationToken } from "./lib/githubApp.mjs";

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		args[argv[i]?.replace(/^--/, "")] = argv[i + 1];
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const appId = args["app-id"];
	const keyPath = args["key"];
	const repo = args["repo"];

	if (!appId || !keyPath || !repo || !repo.includes("/")) {
		console.error(
			"Usage: node mint-installation-token.mjs --app-id <id> --key <path-to-pem> --repo <owner/name>"
		);
		process.exit(1);
	}

	const [owner, repoName] = repo.split("/");
	const privateKeyPem = readFileSync(keyPath, "utf8");

	const tokenBody = await mintInstallationToken({ appId, privateKeyPem, owner, repoName });

	console.log(`Installation token (expires ${tokenBody.expires_at}):`);
	console.log(tokenBody.token);
	console.log("\nTest clone with:");
	console.log(
		`git clone https://x-access-token:${tokenBody.token}@github.com/${repo}.git /tmp/brain-phase0-test`
	);
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
