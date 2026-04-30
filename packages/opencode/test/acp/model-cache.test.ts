import { test, expect, afterAll } from "bun:test"
import path from "path"
import { ACPModel } from "@/provider/acp-model"
import { ProviderID, ModelID } from "@/provider/schema"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import type { NewSessionResponse, SessionConfigOption } from "@agentclientprotocol/sdk"

const MOCK_ADAPTER = `bun ${path.join(import.meta.dirname, "mock-cursor-adapter.ts")}`

async function listModels() {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const providers = yield* provider.list()
      return providers[ProviderID.make("acp")]?.models ?? {}
    }),
  )
}

// -- Unit tests for cacheModelsFromSessionResponse --

test("cacheModelsFromSessionResponse extracts models from configOptions with category model", () => {
  const info = ACPModel.provider()
  ACPModel.bindModels(info.models)

  ACPModel.cacheModelsFromSessionResponse(
    "cursor",
    null,
    [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "claude-sonnet-4",
        options: [
          { value: "claude-sonnet-4", name: "Claude Sonnet 4" },
          { value: "gpt-4.1", name: "GPT-4.1" },
          { value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { value: "composer-2", name: "Composer 2" },
        ],
      },
      {
        type: "select",
        id: "thought_level",
        name: "Thinking",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ] satisfies SessionConfigOption[],
  )

  expect(info.models["cursor:claude-sonnet-4"]).toBeDefined()
  expect(info.models["cursor:claude-sonnet-4"].name).toBe("Claude Sonnet 4")
  expect(info.models["cursor:gpt-4.1"]).toBeDefined()
  expect(info.models["cursor:gemini-2.5-pro"]).toBeDefined()
  // Non-model options must NOT be added
  expect(info.models["cursor:low"]).toBeUndefined()
  expect(info.models["cursor:medium"]).toBeUndefined()

  ACPModel.bindModels({})
})

test("cacheModelsFromSessionResponse handles grouped config options", () => {
  const info = ACPModel.provider()
  ACPModel.bindModels(info.models)

  ACPModel.cacheModelsFromSessionResponse("cursor", null, [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "claude-sonnet-4",
      options: [
        {
          group: "anthropic",
          name: "Anthropic",
          options: [
            { value: "claude-sonnet-4", name: "Claude Sonnet 4" },
            { value: "claude-opus-4", name: "Claude Opus 4" },
          ],
        },
        {
          group: "openai",
          name: "OpenAI",
          options: [
            { value: "gpt-4.1", name: "GPT-4.1" },
            { value: "o3", name: "o3" },
          ],
        },
      ],
    },
  ] satisfies SessionConfigOption[])

  expect(info.models["cursor:claude-sonnet-4"]).toBeDefined()
  expect(info.models["cursor:claude-opus-4"]).toBeDefined()
  expect(info.models["cursor:gpt-4.1"]).toBeDefined()
  expect(info.models["cursor:o3"]).toBeDefined()

  ACPModel.bindModels({})
})

test("cacheModelsFromSessionResponse prefers models field over configOptions", () => {
  const info = ACPModel.provider()
  ACPModel.bindModels(info.models)

  ACPModel.cacheModelsFromSessionResponse(
    "cursor",
    {
      availableModels: [{ modelId: "from-models-field", name: "From Models Field" }],
      currentModelId: "from-models-field",
    },
    [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "from-config-options",
        options: [{ value: "from-config-options", name: "From Config Options" }],
      },
    ] satisfies SessionConfigOption[],
  )

  expect(info.models["cursor:from-models-field"]).toBeDefined()
  expect(info.models["cursor:from-config-options"]).toBeUndefined()

  ACPModel.bindModels({})
})

// -- Integration: cached models appear in Provider.list() --

test("cached models appear in Provider.list() via live provider state", async () => {
  await using tmp = await tmpdir({
    config: { model: "acp/codex:gpt-5.5" },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await listModels()
      expect(before["cursor:composer-2"]).toBeDefined()
      expect(before["cursor:some-new-model"]).toBeUndefined()

      ACPModel.cacheModels("cursor", [
        { id: "some-new-model", name: "Some New Model" },
        { id: "another-model", name: "Another Model" },
      ])

      const after = await listModels()
      expect(after["cursor:some-new-model"]).toBeDefined()
      expect(after["cursor:some-new-model"].name).toBe("Some New Model")
      expect(after["cursor:another-model"]).toBeDefined()
    },
  })
})

// -- Full end-to-end: mock adapter → runtime.ensure → cache → provider list --

test("runtime caches models from mock cursor ACP adapter configOptions", async () => {
  await using tmp = await tmpdir({
    config: {
      model: "acp/cursor:claude-sonnet-4",
      acp: {
        cursor: { command: MOCK_ADAPTER },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Before any session, only defaults
      const before = await listModels()
      expect(before["cursor:composer-2"]).toBeDefined()
      expect(before["cursor:claude-sonnet-4"]).toBeUndefined()
      expect(before["cursor:gpt-4.1"]).toBeUndefined()

      // Run a prompt through the mock cursor adapter
      const { SessionPrompt } = await import("@/session/prompt")
      const { Session } = await import("@/session/session")

      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create()

          yield* prompt.prompt({
            sessionID: session.id,
            model: {
              providerID: ProviderID.make("acp"),
              modelID: ModelID.make("cursor:claude-sonnet-4"),
            },
            parts: [{ type: "text", text: "hello" }],
          })
        }),
      )

      // After the prompt, models from configOptions should be cached
      const after = await listModels()
      expect(after["cursor:claude-sonnet-4"]).toBeDefined()
      expect(after["cursor:claude-sonnet-4"].name).toBe("Claude Sonnet 4")
      expect(after["cursor:gpt-4.1"]).toBeDefined()
      expect(after["cursor:gpt-4.1"].name).toBe("GPT-4.1")
      expect(after["cursor:gemini-2.5-pro"]).toBeDefined()
      expect(after["cursor:gemini-2.5-pro"].name).toBe("Gemini 2.5 Pro")
    },
  })
}, 30_000)
