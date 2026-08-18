// Shown once, right after a fresh sign-in, only when /me reports nobody
// from the user's organization has connected Brain yet ("no_tenant").
// Never shown from a background auto-sync tick — a modal popping up
// unannounced during scheduled sync would be jarring; onboarding decisions
// only ever happen in direct response to the user's own "Connect your
// organization" / "Set up your organization" click.
import { App, Modal, Setting } from "obsidian";

export class ProvisionOrgModal extends Modal {
	private displayName = "";
	private resolved = false;
	private readonly onSubmit: (displayName: string | null) => void;

	constructor(app: App, onSubmit: (displayName: string | null) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Set up your organization" });
		contentEl.createEl("p", {
			text: "Nobody from your organization has connected Brain yet — give it a name to create your organization's shared vault.",
		});

		new Setting(contentEl).setName("Organization name").addText((text) => {
			text.setPlaceholder("Acme Co").onChange((value) => (this.displayName = value));
			text.inputEl.focus();
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Create")
					.setCta()
					.onClick(() => this.submit(this.displayName.trim() || null))
			)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.submit(null)));
	}

	private submit(value: string | null): void {
		if (this.resolved) return;
		this.resolved = true;
		this.onSubmit(value);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		// Dismissed via Esc or an outside click, not a button — treat as cancel. submit() is idempotent, so this is a no-op if a button already handled it.
		this.submit(null);
	}
}
