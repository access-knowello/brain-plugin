import {
	App,
	FileSystemAdapter,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";
import { GitManager, type RemoteCredentials, type SyncStatus } from "./gitManager";
import { mintSyncToken, fetchMe, provisionTenant, joinTenant, SsoAuthError, type ProvisionResult } from "./sso";
import { ProvisionOrgModal } from "./onboarding";

interface BrainSyncSettings {
	// Phase 1 (no SSO): manually issued token + remote URL. Still fully
	// supported post-Phase-2 — see resolveCredentials()'s fallback — not a
	// deprecated path, just no longer the only one.
	remoteUrl: string;
	token: string;
	branch: string;
	autoSyncEnabled: boolean;
	autoSyncIntervalMinutes: number;
	devModeRevealRemote: boolean;
	lastSyncedAt: string | null;
	scaffoldingDone: boolean;
	/** Manual override if auto-detection can't find git (e.g. "spawn git ENOENT"). Empty = auto-detect. */
	gitBinaryPath: string;
	/** Sets repo-local git identity so commits work on a fresh git install with no user.name/email configured anywhere. Empty = leave whatever's already configured on the machine alone. */
	authorName: string;
	authorEmail: string;

	// Phase 2: which brain-provisioning deployment to talk to. Not
	// user-facing (see the "For developers" settings section) — real
	// end-users always stay on "production". "custom" is the escape hatch
	// for anything else (a local dev instance, a future staging env),
	// using provisioningBaseUrlOverride instead of a hardcoded URL.
	ssoEnvironment: SsoEnvironment;
	provisioningBaseUrlOverride: string;
	/**
	 * Presence of ssoSessionToken is the discriminator for "signed in via
	 * SSO" — not a separate mode enum, matching credsConfigured()'s own
	 * existing field-presence style. Makes "sign out" trivially safe: clear
	 * these eight fields, nothing else, manual fields (if present) become
	 * active again with zero special-casing.
	 */
	ssoSessionToken: string | null;
	/** Mirrors GET /me's tenant_status verbatim ("member", "no_tenant", "not_a_member", "pending_approval", "revoked", ...) — drives both resolveCredentials()'s guard and the settings UI's state. Null only before the first /me call ever completes. */
	ssoTenantStatus: string | null;
	ssoTenantId: string | null;
	ssoTenantDisplayName: string | null;
	ssoCachedGitToken: string | null;
	ssoCachedGitTokenExpiresAt: string | null;
	ssoCachedRemoteUrl: string | null;
	ssoCachedRepoFullName: string | null;
}

type SsoEnvironment = "production" | "development" | "custom";

/** The two real, known brain-provisioning deployments. "custom" isn't listed here — it reads provisioningBaseUrlOverride instead, see resolveProvisioningBaseUrl(). */
const PROVISIONING_URLS: Record<Exclude<SsoEnvironment, "custom">, string> = {
	production: "https://brain.brolli.ai",
	development: "https://devbrain.brolli.ai",
};

function resolveProvisioningBaseUrl(s: BrainSyncSettings): string {
	if (s.ssoEnvironment === "custom") {
		return s.provisioningBaseUrlOverride.trim() || PROVISIONING_URLS.production;
	}
	return PROVISIONING_URLS[s.ssoEnvironment];
}

/** Human text for every tenant_status GET /me can return — used both in Notices and the settings UI, so they never drift apart into two different descriptions of the same state. */
function describeTenantStatus(status: string): string {
	switch (status) {
		case "member":
			return "you're an active member of your organization's Brain.";
		case "no_tenant":
			return "your organization hasn't set up Brain yet.";
		case "not_a_member":
			return "you're not yet a member of your organization's Brain.";
		case "pending_approval":
			return "your access is still waiting on admin approval.";
		case "revoked":
			return "your access to your organization's Brain was revoked.";
		default:
			return `your organization access is in an unexpected state ("${status}").`;
	}
}

const DEFAULT_SETTINGS: BrainSyncSettings = {
	remoteUrl: "",
	token: "",
	branch: "main",
	autoSyncEnabled: false,
	autoSyncIntervalMinutes: 15,
	devModeRevealRemote: false,
	lastSyncedAt: null,
	scaffoldingDone: false,
	gitBinaryPath: "",
	authorName: "",
	authorEmail: "",

	ssoEnvironment: "production",
	provisioningBaseUrlOverride: "",
	ssoSessionToken: null,
	ssoTenantStatus: null,
	ssoTenantId: null,
	ssoTenantDisplayName: null,
	ssoCachedGitToken: null,
	ssoCachedGitTokenExpiresAt: null,
	ssoCachedRemoteUrl: null,
	ssoCachedRepoFullName: null,
};

/** Cached SSO git token is refreshed once inside this window of its own expiry — mirrors how close to expiry is still "safe enough" to use once, without risking it dying mid-sync. */
const SSO_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export default class BrainSyncPlugin extends Plugin {
	settings: BrainSyncSettings;
	gitManager: GitManager;
	status: SyncStatus = "idle";
	private autoSyncTimer: number | null = null;

	async onload() {
		await this.loadSettings();

		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("Brain Sync requires a local vault (not available in this environment).");
			return;
		}
		this.gitManager = new GitManager(adapter);
		await this.gitManager.resolveGitBinary(this.settings.gitBinaryPath);

		this.addSettingTab(new BrainSyncSettingTab(this.app, this));

		// The plugin never performs the IdP OAuth exchange itself — it only
		// opens brain-provisioning's hosted /auth/login in the system
		// browser (see the settings UI's "Connect your organization"
		// button) and receives an opaque Knowello session token back via
		// this URI scheme once that service's own /auth/callback completes
		// the real exchange server-side.
		this.registerObsidianProtocolHandler("brain-sync", (params) => this.handleSsoCallback(params));

		this.addCommand({
			id: "brain-sync-now",
			name: "Sync now",
			callback: () => this.syncNow(),
		});

		this.applyAutoSyncSchedule();
	}

	/**
	 * Saves the session token immediately, before anything below, so a
	 * network failure right after sign-in never loses the sign-in itself —
	 * a manual retry from settings just picks up from here instead.
	 */
	private async handleSsoCallback(params: Record<string, string>): Promise<void> {
		const session = params.session;
		if (!session) {
			new Notice("Brain Sync: sign-in link was missing a session token.");
			return;
		}

		this.settings.ssoSessionToken = session;
		this.settings.ssoTenantStatus = null;
		this.settings.ssoTenantId = null;
		this.settings.ssoTenantDisplayName = null;
		this.settings.ssoCachedGitToken = null;
		this.settings.ssoCachedGitTokenExpiresAt = null;
		this.settings.ssoCachedRemoteUrl = null;
		this.settings.ssoCachedRepoFullName = null;
		await this.saveSettings();

		await this.checkOrganizationStatus(session, { promptToProvision: true });
	}

	/**
	 * Learns tenant/membership state via /me, then does whatever's needed to
	 * make progress: mint a token (already a member), prompt to provision
	 * (nobody's connected this org yet), join (org exists, caller isn't a
	 * member yet — auto-join or admin_approval both need no user input
	 * either way), or just report a wait/not-implemented state. Called right
	 * after sign-in, and again from the settings UI's manual retry button —
	 * never from background auto-sync (see resolveCredentials()), so a
	 * modal never appears unannounced.
	 */
	async checkOrganizationStatus(session: string, opts: { promptToProvision: boolean }): Promise<void> {
		const baseUrl = resolveProvisioningBaseUrl(this.settings);
		let me;
		try {
			me = await fetchMe(baseUrl, session);
		} catch (err) {
			new Notice(`Brain Sync: couldn't check your organization status (${(err as Error).message}). Retry from settings.`, 12000);
			return;
		}

		this.settings.ssoTenantId = me.tenant?.id ?? null;
		this.settings.ssoTenantDisplayName = me.tenant?.display_name ?? null;
		this.settings.ssoTenantStatus = me.tenant_status;
		await this.saveSettings();

		if (me.tenant_status === "member") {
			try {
				await this.refreshSsoToken(session);
				new Notice(`Brain Sync: signed in — connected to ${this.settings.ssoCachedRepoFullName}.`);
			} catch (err) {
				new Notice(
					`Brain Sync: signed in, but couldn't mint a sync token yet (${(err as Error).message}). It'll retry on the next sync.`,
					12000
				);
			}
			return;
		}

		if (me.tenant_status === "no_tenant") {
			if (!opts.promptToProvision) {
				new Notice('Brain Sync: your organization hasn\'t set up Brain yet — click "Set up your organization" in settings.', 12000);
				return;
			}
			new ProvisionOrgModal(this.app, async (displayName) => {
				if (!displayName) {
					new Notice("Brain Sync: setup cancelled — you can set up your organization anytime from settings.");
					return;
				}
				await this.provisionOrganization(session, displayName);
			}).open();
			return;
		}

		if (me.tenant_status === "not_a_member" && this.settings.ssoTenantId) {
			await this.joinOrganization(session, this.settings.ssoTenantId);
			return;
		}

		// pending_approval (a prior join-request already exists), revoked,
		// or anything else — nothing to DO, just report it accurately.
		new Notice(`Brain Sync: ${describeTenantStatus(me.tenant_status)}`, 12000);
	}

	async provisionOrganization(session: string, displayName: string): Promise<void> {
		let result: ProvisionResult;
		try {
			result = await provisionTenant(resolveProvisioningBaseUrl(this.settings), session, displayName);
		} catch (err) {
			new Notice(`Brain Sync: couldn't set up your organization (${(err as Error).message}). Try again from settings.`, 12000);
			return;
		}
		await this.applyProvisionOrJoinResult(result, `Brain Sync: organization "${displayName}" created — you're the admin.`);
	}

	private async joinOrganization(session: string, tenantId: string): Promise<void> {
		let result: ProvisionResult;
		try {
			result = await joinTenant(resolveProvisioningBaseUrl(this.settings), session, tenantId);
		} catch (err) {
			new Notice(`Brain Sync: couldn't join your organization (${(err as Error).message}). Try again from settings.`, 12000);
			return;
		}
		await this.applyProvisionOrJoinResult(result, "Brain Sync: joined your organization.");
	}

	private async applyProvisionOrJoinResult(result: ProvisionResult, successMessage: string): Promise<void> {
		switch (result.kind) {
			case "minted": {
				const token = result.token!;
				this.settings.ssoCachedGitToken = token.token;
				this.settings.ssoCachedGitTokenExpiresAt = token.expires_at;
				this.settings.ssoCachedRemoteUrl = token.git_remote_url;
				this.settings.ssoCachedRepoFullName = token.repo_full_name;
				this.settings.ssoTenantStatus = "member";
				await this.saveSettings();
				new Notice(`${successMessage} Connected to ${token.repo_full_name}.`);
				return;
			}
			case "token_pending":
				// Membership/org creation itself succeeded — only the token
				// mint failed transiently. A normal sync retries it.
				this.settings.ssoTenantStatus = "member";
				await this.saveSettings();
				new Notice(`${successMessage} ${result.message ?? "Retrying token setup on the next sync."}`, 12000);
				return;
			case "pending_approval":
				this.settings.ssoTenantStatus = "pending_approval";
				await this.saveSettings();
				new Notice("Brain Sync: request sent — waiting for an admin to approve your access.", 12000);
				return;
			case "not_implemented":
				new Notice(`Brain Sync: ${result.message}`, 12000);
				return;
			case "auth_error":
				new Notice("Brain Sync: your sign-in was rejected trying to set this up. Sign in again from settings.", 12000);
				return;
			default:
				new Notice(`Brain Sync: setup didn't complete (${result.message ?? "unknown error"}). Try again from settings.`, 12000);
		}
	}

	/** Mints a fresh sync token via SSO and caches it. Throws rather than showing a Notice itself — callers decide how to present failure, since the right message differs by context (fresh sign-in vs. a routine background sync). */
	private async refreshSsoToken(session: string): Promise<void> {
		const minted = await mintSyncToken(resolveProvisioningBaseUrl(this.settings), session);
		this.settings.ssoCachedGitToken = minted.token;
		this.settings.ssoCachedGitTokenExpiresAt = minted.expires_at;
		this.settings.ssoCachedRemoteUrl = minted.git_remote_url;
		this.settings.ssoCachedRepoFullName = minted.repo_full_name;
		await this.saveSettings();
	}

	/**
	 * SSO first (refreshing the cached git token if it's missing or close
	 * to its own expiry), falling back to manual fields if SSO fails but
	 * they're present — never a silent hard failure for someone with a
	 * working manual fallback. Returns null only when neither path can
	 * produce credentials.
	 *
	 * Deliberately never triggers onboarding (provisioning/joining/modals)
	 * itself — this runs on every sync, including unattended background
	 * auto-sync, where popping up a modal or silently creating an org would
	 * be a bad surprise. Onboarding only ever happens in direct response to
	 * a user action (handleSsoCallback right after sign-in, or the settings
	 * UI's manual "Set up" / "Check status" buttons).
	 */
	private async resolveCredentials(): Promise<RemoteCredentials | null> {
		if (this.settings.ssoSessionToken) {
			if (this.settings.ssoTenantStatus && this.settings.ssoTenantStatus !== "member") {
				new Notice(
					`Brain Sync: ${describeTenantStatus(this.settings.ssoTenantStatus)}` +
						(this.credsConfigured() ? " Falling back to manual credentials." : " Open Brain Sync settings to finish setup."),
					12000
				);
				return this.credsConfigured() ? { remoteUrl: this.settings.remoteUrl, token: this.settings.token } : null;
			}

			const expiresAt = this.settings.ssoCachedGitTokenExpiresAt
				? new Date(this.settings.ssoCachedGitTokenExpiresAt).getTime()
				: 0;
			const needsRefresh = !this.settings.ssoCachedGitToken || expiresAt - Date.now() < SSO_TOKEN_REFRESH_WINDOW_MS;

			if (needsRefresh) {
				try {
					await this.refreshSsoToken(this.settings.ssoSessionToken);
				} catch (err) {
					// Deliberately does NOT clear ssoSessionToken on a 401/403
					// here — a transient false-401 shouldn't force re-auth, and
					// a genuinely revoked member should just keep failing (the
					// actual desired offboarding outcome) until they notice and
					// sign out manually.
					if (err instanceof SsoAuthError) {
						// Re-check via /me for an accurate reason (e.g. actually
						// revoked) instead of assuming — best-effort, falls back
						// to the generic message if this itself fails.
						try {
							const me = await fetchMe(resolveProvisioningBaseUrl(this.settings), this.settings.ssoSessionToken);
							this.settings.ssoTenantStatus = me.tenant_status;
							this.settings.ssoTenantId = me.tenant?.id ?? null;
							await this.saveSettings();
						} catch {
							// Couldn't even check — fall through to the generic message below.
						}
						const reason = this.settings.ssoTenantStatus
							? describeTenantStatus(this.settings.ssoTenantStatus)
							: "your organization sign-in was rejected — access may have been revoked.";
						new Notice(
							`Brain Sync: ${reason}` +
								(this.credsConfigured() ? " Falling back to manual credentials." : " Sign in again from Brain Sync settings."),
							12000
						);
					} else {
						new Notice(
							`Brain Sync: couldn't reach the organization service (${(err as Error).message}).` +
								(this.credsConfigured() ? " Falling back to manual credentials." : " Skipping this sync."),
							12000
						);
					}
					return this.credsConfigured() ? { remoteUrl: this.settings.remoteUrl, token: this.settings.token } : null;
				}
			}

			return { remoteUrl: this.settings.ssoCachedRemoteUrl!, token: this.settings.ssoCachedGitToken! };
		}

		return this.credsConfigured() ? { remoteUrl: this.settings.remoteUrl, token: this.settings.token } : null;
	}

	onunload() {
		this.clearAutoSyncSchedule();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private credsConfigured(): boolean {
		return this.settings.remoteUrl.trim() !== "" && this.settings.token.trim() !== "";
	}

	async syncNow(): Promise<void> {
		if (this.status === "syncing") return;
		this.status = "syncing";

		const creds = await this.resolveCredentials();
		if (!creds) {
			this.status = "idle";
			new Notice("Brain Sync: sign in to your organization, or set a remote URL and token in settings, first.");
			return;
		}

		try {
			await this.gitManager.ensureIdentity(this.settings.authorName, this.settings.authorEmail, this.settings.branch);

			if (!(await this.gitManager.isRepo())) {
				// First-ever connect: connectExisting()'s own merge
				// (--allow-unrelated-histories) is what reconciles the
				// vault's existing content with remote history, so there's
				// nothing to commit beforehand.
				await this.gitManager.connectExisting(creds, this.settings.branch);
			} else {
				// Commit local changes before pulling, not after. Pulling
				// first meant any local edit that also changed upstream
				// aborted the whole sync ("your local changes would be
				// overwritten by merge") instead of resolving cleanly —
				// standard practice elsewhere is commit-then-sync for
				// exactly this reason.
				await this.gitManager.commitAll("Brain Sync: local changes");
				await this.gitManager.pull(creds, this.settings.branch);
			}

			if (!this.settings.scaffoldingDone) {
				await this.gitManager.scaffoldVault();
				this.settings.scaffoldingDone = true;
				await this.saveSettings();
			}

			// Self-healing: a merge/connect above can reintroduce
			// per-machine files another (not-yet-updated) machine still has
			// tracked — .gitignore alone never retroactively untracks an
			// already-committed path, so this re-applies on every sync
			// rather than needing a one-off manual fix each time it recurs.
			await this.gitManager.untrackIgnoredFiles();

			await this.gitManager.commitAll("Brain Sync: local changes");
			await this.gitManager.push(creds, this.settings.branch);

			this.settings.lastSyncedAt = new Date().toISOString();
			await this.saveSettings();
			this.status = "idle";
			new Notice("Brain Sync: synced.");
		} catch (err) {
			this.status = "error";
			console.error("Brain Sync error", err);
			const message = (err as Error).message ?? String(err);
			if (message.includes("ENOENT") && message.includes("git")) {
				const { path: triedPath } = this.gitManager.getBinaryStatus();
				new Notice(
					`Brain Sync couldn't run git (tried: "${triedPath}"). If git is installed, set its full path ` +
						'under Brain Sync settings → "Git binary path" — paste it with no surrounding quotes — then try again.',
					12000
				);
			} else if (message.includes("Author identity unknown") || message.includes("unable to auto-detect email")) {
				new Notice(
					'Brain Sync failed: no git author identity set on this machine. Set "Author name" and ' +
						'"Author email" under Brain Sync settings, then try again.',
					12000
				);
			} else {
				new Notice(`Brain Sync failed: ${message}`);
			}
		}
	}

	applyAutoSyncSchedule() {
		this.clearAutoSyncSchedule();
		if (!this.settings.autoSyncEnabled) return;
		const intervalMs = this.settings.autoSyncIntervalMinutes * 60 * 1000;
		this.autoSyncTimer = window.setInterval(() => this.syncNow(), intervalMs);
		this.registerInterval(this.autoSyncTimer);
	}

	clearAutoSyncSchedule() {
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
	}
}

class BrainSyncSettingTab extends PluginSettingTab {
	plugin: BrainSyncPlugin;

	constructor(app: App, plugin: BrainSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		containerEl.createEl("h2", { text: "Brain Sync" });

		const statusText =
			s.lastSyncedAt !== null
				? `Last synced ${new Date(s.lastSyncedAt).toLocaleString()}`
				: "Not yet synced";
		new Setting(containerEl).setName("Status").setDesc(statusText);

		containerEl.createEl("h3", { text: "Organization" });
		this.renderOrganizationSection(containerEl, s);

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Pull, then push, any changes to your organization's brain.")
			.addButton((btn) =>
				btn.setButtonText("Sync now").onClick(async () => {
					await this.plugin.syncNow();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName("Author name")
			.setDesc(
				"Used for commit authorship. Leave blank if git already has a name/email configured on this " +
					'machine — only needed if syncing fails with "Author identity unknown."'
			)
			.addText((text) =>
				text
					.setPlaceholder("Your name")
					.setValue(s.authorName)
					.onChange(async (value) => {
						s.authorName = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Author email").addText((text) =>
			text
				.setPlaceholder("you@knowello.com.au")
				.setValue(s.authorEmail)
				.onChange(async (value) => {
					s.authorEmail = value.trim();
					await this.plugin.saveSettings();
				})
		);

		new Setting(containerEl)
			.setName("Auto-sync")
			.setDesc("Sync automatically on an interval.")
			.addToggle((toggle) =>
				toggle.setValue(s.autoSyncEnabled).onChange(async (value) => {
					s.autoSyncEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.applyAutoSyncSchedule();
				})
			);

		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
			.addText((text) =>
				text
					.setValue(String(s.autoSyncIntervalMinutes))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!Number.isNaN(parsed) && parsed > 0) {
							s.autoSyncIntervalMinutes = parsed;
							await this.plugin.saveSettings();
							this.plugin.applyAutoSyncSchedule();
						}
					})
			);

		containerEl.createEl("h3", { text: "Troubleshooting" });
		const gitStatus = this.plugin.gitManager.getBinaryStatus();
		const gitStatusText = gitStatus.valid
			? `✓ Currently using "${gitStatus.path}" — confirmed working.`
			: `✗ Currently trying "${gitStatus.path}" — this did NOT run successfully.`;
		new Setting(containerEl)
			.setName("Git binary path")
			.setDesc(
				`${gitStatusText} Leave blank to auto-detect. Set this if Sync now fails with "couldn't find git" — ` +
					"paste the path with no surrounding quotes, e.g. " +
					"C:\\Program Files\\Git\\cmd\\git.exe on Windows, or the output of `which git` in Terminal on Mac/Linux."
			)
			.addText((text) =>
				text
					.setPlaceholder("Auto-detect")
					.setValue(s.gitBinaryPath)
					.onChange(async (value) => {
						s.gitBinaryPath = value.trim();
						await this.plugin.saveSettings();
						await this.plugin.gitManager.resolveGitBinary(s.gitBinaryPath);
						this.display();
					})
			);

		containerEl.createEl("h3", { text: "For developers" });
		new Setting(containerEl)
			.setName("Reveal connection details")
			.setDesc(
				"Manual token entry — coexists with signing in above, doesn't replace it. Useful as a fallback, " +
					"for local testing, or before your organization has SSO set up."
			)
			.addToggle((toggle) =>
				toggle.setValue(s.devModeRevealRemote).onChange(async (value) => {
					s.devModeRevealRemote = value;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (s.devModeRevealRemote) {
			new Setting(containerEl).setName("Remote URL").addText((text) =>
				text
					.setPlaceholder("https://github.com/knowello-brains/acme-co.git")
					.setValue(s.remoteUrl)
					.onChange(async (value) => {
						s.remoteUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

			new Setting(containerEl)
				.setName("Token")
				.setDesc("GitHub App installation token (or a PAT for local testing). Kept in plugin data only, never written into .git/config.")
				.addText((text) =>
					text.setValue(s.token).onChange(async (value) => {
						s.token = value.trim();
						await this.plugin.saveSettings();
					})
				);

			new Setting(containerEl).setName("Branch").addText((text) =>
				text.setValue(s.branch).onChange(async (value) => {
					s.branch = value.trim() || "main";
					await this.plugin.saveSettings();
				})
			);

			new Setting(containerEl)
				.setName("Provisioning environment")
				.setDesc(
					`Where "Connect your organization" above and background token refresh talk to. Currently: ${resolveProvisioningBaseUrl(s)}. ` +
						'Only change this off "Production" for testing — normal use never needs to touch it.'
				)
				.addDropdown((dropdown) =>
					dropdown
						.addOption("production", "Production (brain.brolli.ai)")
						.addOption("development", "Development (devbrain.brolli.ai)")
						.addOption("custom", "Custom URL…")
						.setValue(s.ssoEnvironment)
						.onChange(async (value) => {
							s.ssoEnvironment = value as SsoEnvironment;
							await this.plugin.saveSettings();
							this.display();
						})
				);

			if (s.ssoEnvironment === "custom") {
				new Setting(containerEl)
					.setName("Custom provisioning URL")
					.addText((text) =>
						text
							.setPlaceholder("http://localhost:8080")
							.setValue(s.provisioningBaseUrlOverride)
							.onChange(async (value) => {
								s.provisioningBaseUrlOverride = value.trim();
								await this.plugin.saveSettings();
							})
					);
			}
		}
	}

	/**
	 * Four real states once signed in: active member (done), no tenant yet
	 * (needs "Set up"), a known tenant but not yet a member (waiting on
	 * approval, or a stale state worth re-checking), or never checked at
	 * all (e.g. settings opened before the first /me call ever completed).
	 * Not signed in is the fifth, simplest state.
	 */
	private renderOrganizationSection(containerEl: HTMLElement, s: BrainSyncSettings): void {
		if (!s.ssoSessionToken) {
			new Setting(containerEl)
				.setName("Connect your organization")
				.setDesc("Sign in with your organization's Microsoft account — no manual tokens needed.")
				.addButton((btn) =>
					btn
						.setButtonText("Connect your organization")
						.setCta()
						.onClick(() => {
							window.open(`${resolveProvisioningBaseUrl(s)}/auth/login`);
						})
				);
			return;
		}

		const signOut = async () => {
			s.ssoSessionToken = null;
			s.ssoTenantStatus = null;
			s.ssoTenantId = null;
			s.ssoTenantDisplayName = null;
			s.ssoCachedGitToken = null;
			s.ssoCachedGitTokenExpiresAt = null;
			s.ssoCachedRemoteUrl = null;
			s.ssoCachedRepoFullName = null;
			await this.plugin.saveSettings();
			this.display();
		};

		if (s.ssoTenantStatus === "member") {
			new Setting(containerEl)
				.setName("Signed in")
				.setDesc(`Connected to: ${s.ssoTenantDisplayName ?? s.ssoCachedRepoFullName ?? "your organization"}`)
				.addButton((btn) => btn.setButtonText("Sign out").onClick(signOut));
			return;
		}

		if (s.ssoTenantStatus === "no_tenant") {
			new Setting(containerEl)
				.setName("Signed in — no organization yet")
				.setDesc("Nobody from your organization has connected Brain yet.")
				.addButton((btn) =>
					btn
						.setButtonText("Set up your organization")
						.setCta()
						.onClick(() => {
							new ProvisionOrgModal(this.app, async (displayName) => {
								if (!displayName || !s.ssoSessionToken) return;
								await this.plugin.provisionOrganization(s.ssoSessionToken, displayName);
								this.display();
							}).open();
						})
				)
				.addButton((btn) => btn.setButtonText("Sign out").onClick(signOut));
			return;
		}

		// not_a_member, pending_approval, revoked, or genuinely never checked
		// (null) — all share the same "check status" recovery action; the
		// description is what actually differs between them.
		const description =
			s.ssoTenantStatus === null
				? "Signed in, but your organization status hasn't been checked yet."
				: `Signed in — ${describeTenantStatus(s.ssoTenantStatus)}`;
		new Setting(containerEl)
			.setName("Signed in")
			.setDesc(description)
			.addButton((btn) =>
				btn.setButtonText("Check status").onClick(async () => {
					if (!s.ssoSessionToken) return;
					await this.plugin.checkOrganizationStatus(s.ssoSessionToken, { promptToProvision: true });
					this.display();
				})
			)
			.addButton((btn) => btn.setButtonText("Sign out").onClick(signOut));
	}
}
