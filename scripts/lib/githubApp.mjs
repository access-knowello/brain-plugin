// Shared GitHub App JWT + installation-token logic, used by both
// mint-installation-token.mjs and connect-vault-to-brain.mjs. This is a
// throwaway stand-in for the real Provisioning Service's /sync/token endpoint
// (see Provisioning Service Sketch in the brain product vault) — same
// JWT-then-installation-token flow, just run from the CLI instead of a server.

import { createSign } from "node:crypto";

function base64url(input) {
	return Buffer.from(input).toString("base64url");
}

export function buildAppJwt(appId, privateKeyPem) {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: "RS256", typ: "JWT" };
	// iat backdated and exp capped well under GitHub's 10-minute ceiling to allow for clock drift
	const payload = { iat: now - 60, exp: now + 9 * 60, iss: Number(appId) };
	const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
	const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem);
	return `${unsigned}.${signature.toString("base64url")}`;
}

async function githubApi(path, jwt, init = {}) {
	const res = await fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(init.headers ?? {}),
		},
	});
	const body = await res.json();
	if (!res.ok) {
		throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body)}`);
	}
	return body;
}

/**
 * Mints a token scoped to exactly one repo. Requires the app to already be
 * installed on `owner` (org or user) with access to `repoName`.
 */
export async function mintInstallationToken({ appId, privateKeyPem, owner, repoName }) {
	const jwt = buildAppJwt(appId, privateKeyPem);

	const installations = await githubApi("/app/installations", jwt);
	const installation = installations.find(
		(i) => i.account?.login?.toLowerCase() === owner.toLowerCase()
	);
	if (!installation) {
		throw new Error(
			`No installation found for account "${owner}". Install the app on that org/account first, then re-run.`
		);
	}

	return githubApi(`/app/installations/${installation.id}/access_tokens`, jwt, {
		method: "POST",
		body: JSON.stringify({ repositories: [repoName] }),
	});
}

export function authHeaderArgs(token) {
	const header = Buffer.from(`x-access-token:${token}`).toString("base64");
	return ["-c", `http.extraHeader=Authorization: Basic ${header}`];
}
