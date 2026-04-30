export * as ACPModel from "./acp-model"

import type {
  SessionModelState,
  SessionConfigOption,
  SessionConfigSelectGroup,
} from "@agentclientprotocol/sdk"
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { spawn } from "node:child_process"
import { ProviderID, ModelID } from "./schema"
import type { Info as ACPConfigInfo } from "@/config/acp"
import type { Info as ProviderInfo, Model as ProviderModel } from "./provider"
import { Shell } from "@/shell/shell"

const DISCOVER_TIMEOUT = 10_000

export const providerID = ProviderID.make("acp")

export const adapters = ["codex", "claude-code", "cursor"] as const
export type AdapterID = (typeof adapters)[number]

const defaults = {
  codex: {
    command: "bunx @zed-industries/codex-acp",
    modelRef: "gpt-5.5",
    name: "Codex GPT-5.5",
  },
  "claude-code": {
    command: "bunx @zed-industries/claude-agent-acp",
    modelRef: "sonnet-4.6",
    name: "Claude Sonnet 4.6",
  },
  cursor: {
    command: "agent acp",
    modelRef: "composer-2",
    name: "Cursor Composer 2",
  },
} satisfies Record<AdapterID, { command: string; modelRef: string; name: string }>

function isAdapter(value: string): value is AdapterID {
  return adapters.includes(value as AdapterID)
}

export function fromString(value: string) {
  const idx = value.indexOf(":")
  if (idx <= 0) return
  const adapter = value.slice(0, idx)
  if (!isAdapter(adapter)) return
  const modelRef = value.slice(idx + 1)
  if (!modelRef) return
  return {
    providerID,
    modelID: ModelID.make(`${adapter}:${modelRef}`),
  }
}

export function extract(model: { providerID: string; modelID: string }) {
  if (model.providerID !== providerID) return
  const idx = model.modelID.indexOf(":")
  if (idx <= 0) return
  const adapter = model.modelID.slice(0, idx)
  if (!isAdapter(adapter)) return
  const modelRef = model.modelID.slice(idx + 1)
  if (!modelRef) return
  return {
    adapter,
    modelRef,
  }
}

export function isACPModel(model: { providerID: string; modelID: string }) {
  return extract(model) !== undefined
}

export function config(config: ACPConfigInfo | undefined, adapter: AdapterID) {
  return {
    command: config?.[adapter]?.command ?? defaults[adapter].command,
    env: config?.[adapter]?.env ?? {},
  }
}

export function model(adapter: AdapterID, modelRef: string): ProviderModel {
  const id = `${adapter}:${modelRef}`
  return {
    id: ModelID.make(id),
    providerID,
    api: {
      id,
      url: "",
      npm: "",
    },
    name: label(adapter, modelRef),
    family: adapter,
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 256_000,
      output: 32_000,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    variants: {},
  }
}

export function provider(): ProviderInfo {
  return {
    id: providerID,
    source: "custom",
    name: "ACP",
    env: [],
    options: {},
    models: Object.fromEntries(
      adapters.map((adapter) => {
        const info = defaults[adapter]
        const item = model(adapter, info.modelRef)
        return [item.id, { ...item, name: info.name }]
      }),
    ),
  }
}

let liveModels: Record<string, ProviderModel> | undefined

export function bindModels(models: Record<string, ProviderModel>) {
  liveModels = models
}

export function cacheModels(adapter: AdapterID, discovered: Array<{ id: string; name: string }>) {
  if (!liveModels) return
  for (const m of discovered) {
    const key = `${adapter}:${m.id}`
    if (!liveModels[key]) {
      liveModels[key] = { ...model(adapter, m.id), name: m.name }
    }
  }
}

export function cacheModelsFromSessionResponse(
  adapter: AdapterID,
  models: SessionModelState | null | undefined,
  configOptions: SessionConfigOption[] | null | undefined,
) {
  if (models?.availableModels?.length) {
    cacheModels(
      adapter,
      models.availableModels.map((m) => ({ id: m.modelId, name: m.name })),
    )
    return
  }
  if (!configOptions) return
  const modelOption = configOptions.find((opt) => opt.category === "model" && opt.type === "select")
  if (!modelOption || modelOption.type !== "select") return
  const entries: Array<{ id: string; name: string }> = []
  for (const item of modelOption.options) {
    if ("group" in item) {
      for (const opt of (item as SessionConfigSelectGroup).options) {
        entries.push({ id: opt.value, name: opt.name })
      }
    } else {
      entries.push({ id: item.value, name: item.name })
    }
  }
  cacheModels(adapter, entries)
}

export async function discoverModels(acpConfig: ACPConfigInfo | undefined, adapter: AdapterID, cwd: string) {
  const cmd = config(acpConfig, adapter)
  const proc = spawn(cmd.command, [], {
    cwd,
    env: { ...process.env, ...cmd.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: true,
  })

  const closed = new Promise<never>((_, reject) => {
    proc.once("error", (err) => reject(err))
    proc.once("exit", (code, signal) =>
      reject(
        new Error(
          `ACP adapter ${adapter} exited${code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : ""}`,
        ),
      ),
    )
  })
  void closed.catch(() => {})

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`ACP discovery timed out for ${adapter}`)), DISCOVER_TIMEOUT)
  })

  try {
    const conn = new ClientSideConnection(
      () => ({
        async sessionUpdate() {},
        async requestPermission() {
          return { outcome: { outcome: "cancelled" as const } }
        },
      }),
      ndJsonStream(
        new WritableStream<Uint8Array>({
          write(chunk) {
            if (!proc.stdin?.writable) return
            return new Promise<void>((resolve, reject) => {
              proc.stdin?.write(chunk, (err) => (err ? reject(err) : resolve()))
            })
          },
          close() {
            proc.stdin?.end()
          },
          abort() {
            proc.stdin?.destroy()
          },
        }),
        new ReadableStream<Uint8Array>({
          start(controller) {
            proc.stdout?.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
            proc.stdout?.once("end", () => controller.close())
            proc.stdout?.once("error", (err) => controller.error(err))
          },
          cancel() {
            proc.stdout?.destroy()
          },
        }),
      ),
    )

    await Promise.race([
      closed,
      timeout,
      conn.initialize({
        protocolVersion: 1,
        clientInfo: { name: "opencode", title: "OpenCode", version: "local" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
    ])

    const session = await Promise.race([closed, timeout, conn.newSession({ cwd, mcpServers: [] })])
    cacheModelsFromSessionResponse(adapter, session.models, session.configOptions)
  } catch {
    // best-effort: adapter may not be installed
  } finally {
    await Shell.killTree(proc, { exited: () => proc.exitCode !== null }).catch(() => {})
  }
}

function label(adapter: AdapterID, modelRef: string) {
  switch (adapter) {
    case "codex":
      return `Codex ${modelRef}`
    case "claude-code":
      return `Claude ${modelRef}`
    case "cursor":
      return `Cursor ${modelRef}`
  }
}
