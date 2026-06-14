import { Injectable } from "@angular/core";
import { streamText, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { ConfigService } from "tabby-core";
import { BaseTerminalTabComponent } from "tabby-terminal";
import { execSync } from "child_process";
import { PilotProviderType } from "../api/interfaces";
import { createOpenAIChatModel, createOpenAIResponsesModel } from "./providers/openai-language-model";

@Injectable({ providedIn: "root" })
export class PilotAIService {
  constructor(private config: ConfigService) {}

  async *chat(
    messages: any[],
    onToolCall: (toolCall: any) => Promise<boolean>,
    terminalTab?: BaseTerminalTabComponent<any> | null,
    providerType?: PilotProviderType,
  ) {
    const pilotConfig = this.config.store.pilot;
    const selectedProvider = providerType || pilotConfig.provider || 'anthropic';
    const providerConfig = this.getProviderConfig(selectedProvider);

    if (!providerConfig.apiKey) {
      throw new Error(
        "API key not configured for the selected provider. Please configure it in Settings > Pilot",
      );
    }

    if (!providerConfig.model) {
      throw new Error(
        "Model not configured for the selected provider. Please configure it in Settings > Pilot",
      );
    }

    const model = this.createModel(selectedProvider, providerConfig);

    const result = await streamText({
      model,
      messages,
      maxSteps: 20,
      maxTokens: pilotConfig.maxTokens || 4096,
      tools: {
        executeShell: tool({
          description:
            "Execute a shell command in the terminal. The command will be sent to the left terminal pane if available. You can specify how long to wait for the command output. If the output is not ready within the timeout, you can use readTerminalOutput to read it later.",
          parameters: z.object({
            command: z.string().describe("The shell command to execute"),
            timeoutSeconds: z
              .number()
              .optional()
              .describe(
                "How many seconds to wait for command output (default: 1). Should be as short as possible for instant commands, and be longer for slow commands like large file operations or network requests.",
              ),
          }),
          execute: async ({ command, timeoutSeconds }, { toolCallId }) => {
            const approved = await onToolCall({
              type: "tool-call",
              toolName: "executeShell",
              toolCallId,
              args: { command },
            });

            if (!approved) {
              return {
                success: false,
                error: "User rejected the command execution",
                cancelled: true,
              };
            }

            try {
              // 如果有终端，发送命令到终端并捕获输出
              if (terminalTab && terminalTab.session) {
                const timeoutMs = (timeoutSeconds || 5) * 1000;
                const output = await this.executeInTerminal(
                  terminalTab,
                  command,
                  timeoutMs,
                );
                return {
                  success: true,
                  output: output || "Command executed in terminal.",
                  sentToTerminal: true,
                };
              } else {
                // 回退方案：使用 execSync 在本地执行
                const timeoutMs = (timeoutSeconds || 30) * 1000;
                const output = execSync(command, {
                  encoding: "utf-8",
                  maxBuffer: 10 * 1024 * 1024,
                  timeout: timeoutMs,
                });
                return {
                  success: true,
                  output: output.toString(),
                  sentToTerminal: false,
                };
              }
            } catch (error: any) {
              return {
                success: false,
                error: error.message,
                stderr: error.stderr?.toString() || "",
                stdout: error.stdout?.toString() || "",
              };
            }
          },
        }),
        readTerminalOutput: tool({
          description:
            "Read additional output from the terminal. Use this after executeShell if the initial timeout was too short and you need to wait longer for the command to complete.",
          parameters: z.object({
            timeoutSeconds: z
              .number()
              .optional()
              .describe(
                "How many seconds to wait for additional output (default: 5).",
              ),
          }),
          execute: async ({ timeoutSeconds }, { toolCallId }) => {
            const approved = await onToolCall({
              type: "tool-call",
              toolName: "readTerminalOutput",
              toolCallId,
              args: { timeoutSeconds },
            });

            if (!approved) {
              return {
                success: false,
                error: "User rejected reading terminal output",
                cancelled: true,
              };
            }

            try {
              if (terminalTab && terminalTab.session) {
                const timeoutMs = (timeoutSeconds || 5) * 1000;
                const output = await this.readTerminalOutput(
                  terminalTab,
                  timeoutMs,
                );
                return {
                  success: true,
                  output:
                    output || "No additional output captured within timeout.",
                };
              } else {
                return {
                  success: false,
                  error: "No terminal available to read output from.",
                };
              }
            } catch (error: any) {
              return {
                success: false,
                error: error.message,
              };
            }
          },
        }),
      },
    });

    for await (const chunk of result.fullStream) {
      yield chunk;
    }
  }

  /**
   * 在终端中执行命令并捕获输出
   */
  private async executeInTerminal(
    terminalTab: BaseTerminalTabComponent<any>,
    command: string,
    timeout: number = 5000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const outputBuffer: string[] = [];
      let timeoutHandle: any;

      // 订阅终端输出
      const subscription = terminalTab.session?.output$.subscribe((data) => {
        outputBuffer.push(data);
      });

      // 设置超时
      timeoutHandle = setTimeout(() => {
        subscription?.unsubscribe();
        const output = outputBuffer.join("");
        resolve(
          output || "Command executed (no output captured within timeout)",
        );
      }, timeout);

      // 发送命令
      terminalTab.sendInput(command + "\n");
    });
  }

  /**
   * 读取终端的额外输出（不发送命令，只监听）
   */
  private async readTerminalOutput(
    terminalTab: BaseTerminalTabComponent<any>,
    timeout: number = 5000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const outputBuffer: string[] = [];
      let timeoutHandle: any;

      // 订阅终端输出
      const subscription = terminalTab.session?.output$.subscribe((data) => {
        outputBuffer.push(data);
      });

      // 设置超时
      timeoutHandle = setTimeout(() => {
        subscription?.unsubscribe();
        const output = outputBuffer.join("");
        resolve(output);
      }, timeout);
    });
  }

  validateConfig(): { valid: boolean; error?: string } {
    const pilotConfig = this.config.store.pilot;
    const selectedProvider = pilotConfig.provider || 'anthropic';
    const providerConfig = this.getProviderConfig(selectedProvider);

    if (!providerConfig.apiKey) {
      return { valid: false, error: "API Key is required" };
    }

    if (!providerConfig.model) {
      return { valid: false, error: "Model selection is required" };
    }

    return { valid: true };
  }

  private createModel(provider: PilotProviderType, providerConfig: any) {
    if (provider === 'openai-responses') {
      return createOpenAIResponsesModel(providerConfig);
    }
    if (provider === 'openai-chat') {
      return createOpenAIChatModel(providerConfig);
    }

    const anthropic = createAnthropic({
      apiKey: providerConfig.apiKey,
      baseURL: providerConfig.baseURL || undefined,
    });
    return anthropic(providerConfig.model);
  }

  private getProviderConfig(provider: PilotProviderType): any {
    const pilotConfig = this.config.store.pilot;
    const providers = pilotConfig.providers || {};

    if (provider === 'openai-responses') {
      return providers.openaiResponses || {};
    }
    if (provider === 'openai-chat') {
      return providers.openaiChat || {};
    }
    return providers.anthropic || {};
  }
}
