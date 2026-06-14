import { Component, HostBinding } from "@angular/core";
import { ConfigService } from "tabby-core";

@Component({
  selector: "pilot-settings-tab",
  template: require("./pilotSettingsTab.component.pug"),
  styles: [require("./pilotSettingsTab.component.scss")],
})
export class PilotSettingsTabComponent {
  @HostBinding("class.content-box") true;

  providerOptions = [
    { value: "anthropic", label: "Anthropic Messages API" },
    { value: "openai-responses", label: "OpenAI Responses API" },
    { value: "openai-chat", label: "OpenAI Chat Completions API" },
  ];

  constructor(public config: ConfigService) {}

  get selectedProviderConfig(): any {
    const pilotConfig = this.config.store.pilot;
    if (!pilotConfig.providers) {
      pilotConfig.providers = {
        anthropic: { apiKey: "", baseURL: "", model: "" },
        openaiResponses: { apiKey: "", baseURL: "", model: "" },
        openaiChat: { apiKey: "", baseURL: "", model: "" },
      };
    }

    if (pilotConfig.provider === "openai-responses") {
      return pilotConfig.providers.openaiResponses;
    }
    if (pilotConfig.provider === "openai-chat") {
      return pilotConfig.providers.openaiChat;
    }
    return pilotConfig.providers.anthropic;
  }

  get apiKeyPlaceholder(): string {
    return this.config.store.pilot.provider === "anthropic" ? "sk-ant-..." : "sk-...";
  }

  get baseURLPlaceholder(): string {
    if (this.config.store.pilot.provider === "anthropic") {
      return "https://api.anthropic.com";
    }
    return "https://api.openai.com";
  }

  get modelPlaceholder(): string {
    if (this.config.store.pilot.provider === "anthropic") {
      return "claude-3-5-sonnet-20241022";
    }
    return "gpt-4o";
  }

  get providerHelpUrl(): string {
    return this.config.store.pilot.provider === "anthropic"
      ? "https://console.anthropic.com/"
      : "https://platform.openai.com/api-keys";
  }

  get providerHelpLabel(): string {
    return this.config.store.pilot.provider === "anthropic"
      ? "console.anthropic.com"
      : "platform.openai.com";
  }

  saveConfig(): void {
    this.config.save();
  }
}
