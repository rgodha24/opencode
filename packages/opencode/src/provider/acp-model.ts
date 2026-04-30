export * as ACPModel from "./acp-model"

import { ProviderID, ModelID } from "./schema"
import type { Info as ACPConfigInfo } from "@/config/acp"
import type { Info as ProviderInfo, Model as ProviderModel } from "./provider"

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
