import { App, PluginSettingTab, Setting } from "obsidian";
import { normalizePluginIds, ObsidianConfigSyncMode } from "../shared/pathRules";
import type WebSyncPlugin from "./main";

export type SyncDirection = "two-way" | "pull-only" | "push-only";

export interface SyncPluginSettings {
  serverUrl: string;
  token: string;
  vaultId: string;
  syncDirection: SyncDirection;
  obsidianConfigSyncMode: ObsidianConfigSyncMode;
  syncedPluginIds: string[];
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
  syncDirection: "two-way",
  obsidianConfigSyncMode: "minimal",
  syncedPluginIds: [],
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
      .setName("Sync direction")
      .setDesc("Two-way is normal sync. Pull only never uploads this device. Push only never applies remote changes.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("two-way", "Two-way")
          .addOption("pull-only", "Pull only")
          .addOption("push-only", "Push only")
          .setValue(this.plugin.data.settings.syncDirection)
          .onChange(async (value) => {
            this.plugin.data.settings.syncDirection = value as SyncDirection;
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Obsidian config sync")
      .setDesc("Minimal syncs WebSync bootstrap files. Selected plugins also sync chosen plugin resources.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("minimal", "Minimal")
          .addOption("selected-plugins", "Selected plugins")
          .setValue(this.plugin.data.settings.obsidianConfigSyncMode)
          .onChange(async (value) => {
            this.plugin.data.settings.obsidianConfigSyncMode = value as ObsidianConfigSyncMode;
            await this.plugin.savePluginData();
            this.display();
          });
      });

    if (this.plugin.data.settings.obsidianConfigSyncMode === "selected-plugins") {
      new Setting(containerEl)
        .setName("Plugin IDs")
        .setDesc("Comma, space, or newline separated plugin IDs. Plugin data.json files are always excluded.")
        .addTextArea((text) => {
          text
            .setPlaceholder("dataview, obsidian-marp-plugin")
            .setValue(formatPluginIds(this.plugin.data.settings.syncedPluginIds))
            .onChange(async (value) => {
              this.plugin.data.settings.syncedPluginIds = parsePluginIds(value);
              await this.plugin.savePluginData();
            });
          text.inputEl.rows = 3;
        });
    }

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

export function parsePluginIds(value: string): string[] {
  return normalizePluginIds(value.split(/[\s,]+/));
}

function formatPluginIds(ids: string[]): string {
  return ids.join(", ");
}
