import { App, PluginSettingTab, Setting } from "obsidian";
import type WebSyncPlugin from "./main";

export interface SyncPluginSettings {
  serverUrl: string;
  token: string;
  vaultId: string;
  autoConnect: boolean;
  syncOnStart: boolean;
  replaceLocalOnStart: boolean;
}

export interface SyncPluginData {
  settings: SyncPluginSettings;
}

export const DEFAULT_SETTINGS: SyncPluginSettings = {
  serverUrl: "wss://your-domain.example/sync",
  token: "",
  vaultId: "default",
  autoConnect: true,
  syncOnStart: true,
  replaceLocalOnStart: false
};

export function createDefaultData(): SyncPluginData {
  return {
    settings: { ...DEFAULT_SETTINGS }
  };
}

export class WebSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: WebSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "WebSync" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Use ws:// or wss:// and include /sync.")
      .addText((text) => {
        text
          .setPlaceholder("wss://your-domain.example/sync")
          .setValue(this.plugin.data.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.data.settings.serverUrl = value.trim();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Sync token")
      .setDesc("Shared token configured on the sync service.")
      .addText((text) => {
        text
          .setPlaceholder("required")
          .setValue(this.plugin.data.settings.token)
          .onChange(async (value) => {
            this.plugin.data.settings.token = value.trim();
            await this.plugin.savePluginData();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Vault ID")
      .addText((text) => {
        text.setValue(this.plugin.data.settings.vaultId).onChange(async (value) => {
          this.plugin.data.settings.vaultId = value.trim() || "default";
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName("Auto connect")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.data.settings.autoConnect).onChange(async (value) => {
          this.plugin.data.settings.autoConnect = value;
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName("Sync on start")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.data.settings.syncOnStart).onChange(async (value) => {
          this.plugin.data.settings.syncOnStart = value;
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName("Replace local on next start")
      .setDesc("One-time bootstrap for old devices. Keeps WebSync and Remotely Save, then makes this vault match the sync service.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.data.settings.replaceLocalOnStart).onChange(async (value) => {
          this.plugin.data.settings.replaceLocalOnStart = value;
          await this.plugin.savePluginData();
        });
      });
  }
}
