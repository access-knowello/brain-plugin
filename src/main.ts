import {
	App,
	FileSystemAdapter,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";
import { GitManager, type SyncStatus } from "./gitManager";

interface BrainSyncSettings {
	// Phase 1 (no SSO yet, per MVP Sketch): manually issued token + remote URL.
	// Phase 2 replaces this pair with a Knowello session obtained via
	// registerObsidianProtocolHandler, per Obsidian Plugin Design.md.
	remoteUrl: string;
	token: string;
	branch: string;
	autoSyncEnabled: boolean;
	autoSyncIntervalMinutes: number;
	devModeRevealRemote: boolean;
	lastSyncedAt: string | null;
	scaffoldingDone: boolean;
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
};

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

		this.addSettingTab(new BrainSyncSettingTab(this.app, this));

		this.addCommand({
			id: "brain-sync-now",
			name: "Sync now",
			callback: () => this.syncNow(),
		});

		this.applyAutoSyncSchedule();
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
		if (!this.credsConfigured()) {
			new Notice("Brain Sync: set a remote URL and token in settings first.");
			return;
		}
		if (this.status === "syncing") return;

		this.status = "syncing";
		const creds = { remoteUrl: this.settings.remoteUrl, token: this.settings.token };
		try {
			if (!(await this.gitManager.isRepo())) {
				await this.gitManager.connectExisting(creds, this.settings.branch);
			} else {
				await this.gitManager.pull(creds, this.settings.branch);
			}

			if (!this.settings.scaffoldingDone) {
				await this.gitManager.scaffoldVault();
				this.settings.scaffoldingDone = true;
				await this.saveSettings();
			}

			await this.gitManager.commitAll("Brain Sync: local changes");
			await this.gitManager.push(creds, this.settings.branch);

			this.settings.lastSyncedAt = new Date().toISOString();
			await this.saveSettings();
			this.status = "idle";
			new Notice("Brain Sync: synced.");
		} catch (err) {
			this.status = "error";
			console.error("Brain Sync error", err);
			new Notice(`Brain Sync failed: ${(err as Error).message}`);
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

		containerEl.createEl("h3", { text: "For developers" });
		new Setting(containerEl)
			.setName("Reveal connection details")
			.setDesc(
				"Phase 1 only: no SSO yet, so the remote URL and token are entered here directly. " +
					"Phase 2 replaces this with sign-in via your organization's identity provider."
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
		}
	}
}
