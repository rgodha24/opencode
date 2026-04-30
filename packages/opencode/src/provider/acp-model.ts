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

export const adapters = ["codex", "claude-code", "cursor"] as const
export type AdapterID = (typeof adapters)[number]

const adapterProviderIDs: Record<AdapterID, ProviderID> = {
  codex: ProviderID.make("codex"),
  "claude-code": ProviderID.make("claude-code"),
  cursor: ProviderID.make("cursor"),
}

const defaults = {
  codex: {
    command: "bunx @zed-industries/codex-acp",
    providerName: "Codex",
  },
  "claude-code": {
    command: "bunx @zed-industries/claude-agent-acp",
    providerName: "Claude Code",
  },
  cursor: {
    command: "agent acp",
    providerName: "Cursor",
  },
} satisfies Record<AdapterID, { command: string; providerName: string }>

function isAdapter(value: string): value is AdapterID {
  return adapters.includes(value as AdapterID)
}

export function adapterForProvider(pid: string): AdapterID | undefined {
  for (const adapter of adapters) {
    if (adapterProviderIDs[adapter] === pid) return adapter
  }
  return undefined
}

export function providerIDFor(adapter: AdapterID): ProviderID {
  return adapterProviderIDs[adapter]
}

export function isACPProvider(pid: string): boolean {
  return adapterForProvider(pid) !== undefined
}

export function fromString(value: string) {
  if (value.includes(":")) {
    const idx = value.indexOf(":")
    const adapter = value.slice(0, idx)
    if (!isAdapter(adapter)) return
    const modelRef = value.slice(idx + 1)
    if (!modelRef) return
    return {
      providerID: adapterProviderIDs[adapter],
      modelID: ModelID.make(modelRef),
    }
  }
  return undefined
}

export function extract(m: { providerID: string; modelID: string }) {
  const adapter = adapterForProvider(m.providerID)
  if (!adapter) return
  return {
    adapter,
    modelRef: String(m.modelID),
  }
}

export function isACPModel(m: { providerID: string; modelID: string }) {
  return extract(m) !== undefined
}

export function config(cfg: ACPConfigInfo | undefined, adapter: AdapterID) {
  return {
    command: cfg?.[adapter]?.command ?? defaults[adapter].command,
    env: cfg?.[adapter]?.env ?? {},
  }
}

export function model(adapter: AdapterID, modelRef: string): ProviderModel {
  return {
    id: ModelID.make(modelRef),
    providerID: adapterProviderIDs[adapter],
    api: {
      id: modelRef,
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

export function provider(adapter: AdapterID): ProviderInfo {
  return {
    id: adapterProviderIDs[adapter],
    source: "custom",
    name: defaults[adapter].providerName,
    env: [],
    options: {},
    models: {},
  }
}

export function providers(): Record<ProviderID, ProviderInfo> {
  return Object.fromEntries(adapters.map((adapter) => [adapterProviderIDs[adapter], provider(adapter)])) as Record<
    ProviderID,
    ProviderInfo
  >
}

const liveModelsMap = new Map<AdapterID, Record<string, ProviderModel>>()

export function bindModels(adapter: AdapterID, models: Record<string, ProviderModel>) {
  liveModelsMap.set(adapter, models)
}

export function cacheModels(adapter: AdapterID, discovered: Array<{ id: string; name: string }>) {
  const live = liveModelsMap.get(adapter)
  if (!live) return
  for (const m of discovered) {
    if (!live[m.id]) {
      live[m.id] = { ...model(adapter, m.id), name: m.name }
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
