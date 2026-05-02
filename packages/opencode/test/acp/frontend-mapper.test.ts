import { describe, expect } from "bun:test"
import { Layer, Effect } from "effect"
import { ProviderID, ModelID } from "@/provider/schema"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { Todo } from "@/session/todo"
import { ACPFrontendMapper } from "@/acp/frontend/mapper"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Todo.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("acp frontend mapper", () => {
  it.live("maps ACP updates into native parts and todos", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todo = yield* Todo.Service
        const session = yield* sessions.create()
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("codex"), modelID: ModelID.make("gpt-5.5") },
        })
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          modelID: ModelID.make("gpt-5.5"),
          providerID: ProviderID.make("codex"),
          path: { cwd: session.directory, root: session.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)

        const state = ACPFrontendMapper.create()
        const update = (value: unknown) => value as Parameters<typeof ACPFrontendMapper.apply>[0]["update"]
        const push = (update: Parameters<typeof ACPFrontendMapper.apply>[0]["update"]) =>
          ACPFrontendMapper.apply({
            state,
            message: assistant,
            update,
            sessions,
            todo,
          })

        yield* push(
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello " },
          }),
        )
        yield* push(
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "world" },
          }),
        )
        yield* push(
          update({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "thinking" },
          }),
        )
        yield* push(
          update({
            sessionUpdate: "tool_call",
            toolCallId: "call_1",
            title: "bash",
            rawInput: { command: "pwd" },
            kind: "execute",
            status: "pending",
            locations: [],
          }),
        )
        yield* push(
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "call_1",
            title: "bash",
            status: "in_progress",
            rawInput: { command: "pwd" },
            kind: "execute",
            content: [{ type: "content", content: { type: "text", text: "/repo" } }],
          }),
        )
        yield* push(
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "call_1",
            title: "bash",
            status: "completed",
            rawInput: { command: "pwd" },
            kind: "execute",
            content: [{ type: "content", content: { type: "text", text: "/repo" } }],
          }),
        )
        yield* push(
          update({
            sessionUpdate: "plan",
            entries: [
              { content: "map ACP todos", status: "in_progress", priority: "high" },
              { content: "finish runtime", status: "pending", priority: "medium" },
            ],
          }),
        )
        yield* ACPFrontendMapper.finish({ state, sessions })

        const stored = MessageV2.get({ sessionID: session.id, messageID: assistant.id })
        const text = stored.parts.find((part): part is MessageV2.TextPart => part.type === "text")
        const reasoning = stored.parts.find((part): part is MessageV2.ReasoningPart => part.type === "reasoning")
        const tool = stored.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
        const todos = yield* todo.get(session.id)

        expect(text?.text).toBe("hello world")
        expect(reasoning?.text).toBe("thinking")
        expect(tool?.state.status).toBe("completed")
        if (tool?.state.status === "completed") {
          expect(tool.state.output).toContain("/repo")
        }
        expect(todos).toHaveLength(2)
        expect(todos[0]?.content).toBe("map ACP todos")
      }),
    ),
  )

  it.live("creates separate text parts when text is split by tool calls", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todo = yield* Todo.Service
        const session = yield* sessions.create()
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("codex"), modelID: ModelID.make("gpt-5.5") },
        })
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          modelID: ModelID.make("gpt-5.5"),
          providerID: ProviderID.make("codex"),
          path: { cwd: session.directory, root: session.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)

        const state = ACPFrontendMapper.create()
        const update = (value: unknown) => value as Parameters<typeof ACPFrontendMapper.apply>[0]["update"]
        const push = (update: Parameters<typeof ACPFrontendMapper.apply>[0]["update"]) =>
          ACPFrontendMapper.apply({
            state,
            message: assistant,
            update,
            sessions,
            todo,
          })

        yield* push(
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before tool" },
          }),
        )
        yield* push(
          update({
            sessionUpdate: "tool_call",
            toolCallId: "call_1",
            title: "bash",
            rawInput: { command: "pwd" },
            kind: "execute",
            status: "pending",
            locations: [],
          }),
        )
        yield* push(
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "call_1",
            title: "bash",
            status: "completed",
            rawInput: { command: "pwd" },
            kind: "execute",
            content: [{ type: "content", content: { type: "text", text: "/repo" } }],
          }),
        )
        yield* push(
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " after tool" },
          }),
        )
        yield* ACPFrontendMapper.finish({ state, sessions })

        const stored = MessageV2.get({ sessionID: session.id, messageID: assistant.id })
        const textParts = stored.parts.filter((part): part is MessageV2.TextPart => part.type === "text")
        const toolParts = stored.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool")

        expect(textParts.length).toBe(2)
        expect(textParts[0]?.text).toBe("before tool")
        expect(textParts[1]?.text).toBe(" after tool")
        expect(toolParts.length).toBe(1)
        expect(toolParts[0]?.state.status).toBe("completed")

        const textIndices = textParts.map((p) => stored.parts.indexOf(p))
        const toolIndex = stored.parts.indexOf(toolParts[0]!)
        expect(textIndices[0]).toBeLessThan(toolIndex)
        expect(toolIndex).toBeLessThan(textIndices[1]!)
      }),
    ),
  )
})
