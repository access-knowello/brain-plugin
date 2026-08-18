// Thin client for brain-provisioning's HTTP API — the plugin's only contact
// with the SSO/multi-tenant side of Brain. Uses Obsidian's requestUrl(),
// not raw fetch(), since Obsidian's renderer process enforces CORS that
// requestUrl bypasses (see Obsidian Plugin Design.md) — this is the one
// reason this file can't just use the platform fetch.
import { requestUrl } from "obsidian";

export interface SyncTokenResponse {
	token: string;
	expires_at: string;
	repo_full_name: string;
	git_remote_url: string;
}

export interface MeResponse {
	user_subject: string;
	email: string;
	tenant: { id: string; display_name: string; repo_full_name: string } | null;
	tenant_status: string;
}

/**
 * Thrown for a 401/403 from the provisioning service — distinct from a
 * network failure, since main.ts's resolveCredentials() needs to treat the
 * two very differently (see the Build Plan doc's decided error handling).
 */
export class SsoAuthError extends Error {}

async function callProvisioningService<T>(
	baseUrl: string,
	path: string,
	method: "GET" | "POST",
	sessionToken: string
): Promise<T> {
	let res;
	try {
		res = await requestUrl({
			url: `${baseUrl}${path}`,
			method,
			headers: { Authorization: `Bearer ${sessionToken}` },
			throw: false,
		});
	} catch (err) {
		// requestUrl throws for outright network failure (DNS, connection
		// refused, timeout) rather than returning a response — normalize
		// both failure shapes into a plain Error so callers only ever
		// branch on SsoAuthError vs. everything else.
		throw new Error(`Couldn't reach the organization service: ${(err as Error).message ?? err}`);
	}

	if (res.status === 401 || res.status === 403) {
		throw new SsoAuthError(`Provisioning service rejected the session (HTTP ${res.status}).`);
	}
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Provisioning service request failed (HTTP ${res.status}).`);
	}
	return res.json as T;
}

/** Flow C — mints (or re-mints) a git token scoped to this tenant's repo. Re-checks membership fresh server-side on every call; a revoked member gets SsoAuthError here, not a stale cached token. */
export function mintSyncToken(baseUrl: string, sessionToken: string): Promise<SyncTokenResponse> {
	return callProvisioningService<SyncTokenResponse>(baseUrl, "/sync/token", "POST", sessionToken);
}

/** Learns tenant/membership state — right after sign-in (to decide whether onboarding is needed at all) and from the settings UI's manual "check status" retry. */
export function fetchMe(baseUrl: string, sessionToken: string): Promise<MeResponse> {
	return callProvisioningService<MeResponse>(baseUrl, "/me", "GET", sessionToken);
}

/**
 * Outcome of POST /tenants/provision or POST /tenants/{id}/join-request —
 * several genuinely different, expected shapes, not just success/failure:
 * - "minted": a real sync token came back immediately (new org's founder,
 *   or an existing org with join_policy "auto").
 * - "pending_approval": membership was recorded but needs an admin's
 *   approval (join_policy "admin_approval") — not an error.
 * - "token_pending": membership/org creation succeeded but the token mint
 *   itself failed transiently (202 — see brain-provisioning's
 *   mintAndRespond) — also not an error, just retry via a normal sync.
 * - "not_implemented": join_policy "group_scoped", a real, documented gap
 *   server-side (501), not a bug.
 * - "auth_error" / "request_failed": genuine failures.
 *
 * Deliberately NOT reusing callProvisioningService()'s throw-on-non-2xx
 * behavior — every one of the above is a status this plugin needs to
 * branch on by design, not treat as an exceptional failure.
 */
export interface ProvisionResult {
	kind: "minted" | "pending_approval" | "token_pending" | "not_implemented" | "auth_error" | "request_failed";
	token?: SyncTokenResponse;
	message?: string;
}

async function postAndInterpret(baseUrl: string, path: string, sessionToken: string, body?: unknown): Promise<ProvisionResult> {
	let res;
	try {
		res = await requestUrl({
			url: `${baseUrl}${path}`,
			method: "POST",
			headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
			throw: false,
		});
	} catch (err) {
		throw new Error(`Couldn't reach the organization service: ${(err as Error).message ?? err}`);
	}

	const json = res.json as { status?: string; token?: string; error?: string; message?: string } | undefined;

	if (res.status === 401 || res.status === 403) return { kind: "auth_error", message: json?.error };
	if (res.status === 501) return { kind: "not_implemented", message: json?.message ?? "This organization's join policy isn't supported yet." };
	if (res.status === 202) return { kind: "token_pending", message: json?.message };
	if (res.status === 200) {
		if (json?.token) return { kind: "minted", token: json as unknown as SyncTokenResponse };
		if (json?.status === "pending_approval") return { kind: "pending_approval" };
		// Defensive — an unrecognized 200 shape shouldn't be treated as a
		// hard failure, just as "nothing more to do right now."
		return { kind: "pending_approval" };
	}
	return { kind: "request_failed", message: `HTTP ${res.status}` };
}

/** Flow A — creates a brand-new org + repo if the caller's org has none yet, or joins/mints against an existing one per its join_policy (see brain-provisioning's tenantAccess.ts — both cases are now the same server-side logic). */
export function provisionTenant(baseUrl: string, sessionToken: string, displayName: string): Promise<ProvisionResult> {
	return postAndInterpret(baseUrl, "/tenants/provision", sessionToken, { display_name: displayName });
}

/** Flow B — joins an already-known tenant (its id comes from a prior /me call) per its join_policy. */
export function joinTenant(baseUrl: string, sessionToken: string, tenantId: string): Promise<ProvisionResult> {
	return postAndInterpret(baseUrl, `/tenants/${encodeURIComponent(tenantId)}/join-request`, sessionToken);
}
