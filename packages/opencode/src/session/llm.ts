import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import { FailoverPool, type FailoverChainEntry } from "@/failover"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Auth } from "@/auth"
import { withOAuthRecord } from "@/auth/context"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput): Promise<StreamOutput> {
    if (input.model.providerID === "failover") {
      return streamWithFailover(input)
    }
    return streamInternal(input)
  }

  async function streamWithFailover(input: StreamInput): Promise<StreamOutput> {
    const chain = input.model.options.failoverChain as FailoverChainEntry[]
    if (!chain || chain.length === 0) {
      throw new Error(`Failover model ${input.model.id} has no chain configured`)
    }

    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i]

      if (!(await FailoverPool.isAvailable(entry.provider, entry.model))) {
        continue
      }

      // If a specific account is specified, resolve it and check if it's available
      let pinnedRecordID: string | undefined
      if (entry.account) {
        pinnedRecordID = await Auth.OAuthPool.getRecordIDByLabel(entry.provider, entry.account)
        if (!pinnedRecordID) {
          log.warn("account label not found, skipping", { provider: entry.provider, account: entry.account })
          continue
        }
      }

      // Pre-check: if all OAuth accounts for this provider are on cooldown, skip to next provider
      // (only applies when no specific account is pinned - if pinned, we'll let it fail naturally)
      if (!pinnedRecordID && (await Auth.OAuthPool.allOnCooldown(entry.provider))) {
        log.info("all OAuth accounts on cooldown, skipping provider", { provider: entry.provider })
        await FailoverPool.recordOutcome({
          providerID: entry.provider,
          modelID: entry.model,
          statusCode: 429,
          ok: false,
          cooldownUntil: Date.now() + 30_000, // Brief cooldown to avoid repeated checks
        })

        if (i + 1 < chain.length) {
          Bus.publish(TuiEvent.ToastShow, {
            message: `Switched from ${entry.provider} to ${chain[i + 1].provider} (all accounts on cooldown)`,
            variant: "info",
            duration: 3000,
          })
        }

        continue
      }

      try {
        const actualModel = await Provider.getModel(entry.provider, entry.model)
        const modifiedInput = { ...input, model: actualModel }

        // If a specific account is pinned, wrap with withOAuthRecord to use only that account
        const result = pinnedRecordID
          ? await withOAuthRecord(entry.provider, pinnedRecordID, () => streamInternal(modifiedInput))
          : await streamInternal(modifiedInput)

        await FailoverPool.recordOutcome({
          providerID: entry.provider,
          modelID: entry.model,
          statusCode: 200,
          ok: true,
        })

        return result
      } catch (e) {
        if (isRateLimitError(e)) {
          const cooldownMs = extractRetryAfter(e) ?? 30_000
          await FailoverPool.recordOutcome({
            providerID: entry.provider,
            modelID: entry.model,
            statusCode: 429,
            ok: false,
            cooldownUntil: Date.now() + cooldownMs,
          })

          if (i + 1 < chain.length) {
            Bus.publish(TuiEvent.ToastShow, {
              message: `Switched from ${entry.provider} to ${chain[i + 1].provider}`,
              variant: "info",
              duration: 3000,
            })
          }

          continue
        }

        await FailoverPool.recordOutcome({
          providerID: entry.provider,
          modelID: entry.model,
          statusCode: 0,
          ok: false,
        })
        throw e
      }
    }

    throw new Error("All providers in failover chain exhausted or on cooldown")
  }

  function isRateLimitError(e: unknown): boolean {
    if (e instanceof Error) {
      const msg = e.message.toLowerCase()
      if (
        msg.includes("429") ||
        msg.includes("rate limit") ||
        msg.includes("too many requests") ||
        msg.includes("cooldown") ||
        msg.includes("credit balance")
      ) {
        return true
      }
      if ("status" in e && (e as any).status === 429) {
        return true
      }
      if ("statusCode" in e && (e as any).statusCode === 429) {
        return true
      }
      if ("isAllAccountsOnCooldown" in e && (e as any).isAllAccountsOnCooldown === true) {
        return true
      }
    }
    return false
  }

  function extractRetryAfter(e: unknown): number | undefined {
    if (e instanceof Error && "headers" in e) {
      const headers = (e as any).headers
      const value = headers?.get?.("retry-after") ?? headers?.["retry-after"]
      if (!value) return undefined
      const seconds = Number(value)
      if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000
      const dateMs = Date.parse(value)
      if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
    }
    return undefined
  }

  async function streamInternal(input: StreamInput): Promise<StreamOutput> {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = []
    system.push(
      [
        // use agent prompt otherwise provider prompt
        // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    const tools = await resolveTools(input)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `opencode/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const disabled = PermissionNext.disabled(Object.keys(input.tools), input.agent.permission)
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
