import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ProviderID, ModelID } from "@/provider/schema"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { ACPFrontendRuntime } from "@/acp/frontend/runtime"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(SessionPrompt.defaultLayer)

describe("acp frontend prompt flow", () => {
  it.live("routes ACP model turns through the ACP frontend runtime", () =>
    provideTmpdirInstance(() =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          ACPFrontendRuntime.setPromptForTest(async (input) => {
            const update = (value: unknown) => value as Parameters<typeof input.onUpdate>[0]
            await input.onUpdate(
              update({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "hello from codex" },
              }),
            )
            await input.onUpdate(
              update({
                sessionUpdate: "plan",
                entries: [{ content: "native todo", status: "completed", priority: "medium" }],
              }),
            )
            return {
              acpSessionID: "acp_test_session",
              response: {
                stopReason: "end_turn",
                usage: {
                  totalTokens: 12,
                  inputTokens: 5,
                  outputTokens: 7,
                },
              },
            }
          })
        }),
        () =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const todo = yield* Todo.Service
            const session = yield* sessions.create()

            const message = yield* prompt.prompt({
              sessionID: session.id,
              model: {
                providerID: ProviderID.make("acp"),
                modelID: ModelID.make("codex:gpt-5.5"),
              },
              parts: [{ type: "text", text: "say hi" }],
            })

            const updatedSession = yield* sessions.get(session.id)
            const todos = yield* todo.get(session.id)
            const text = message.parts.find((part) => part.type === "text")

            expect(message.info.role).toBe("assistant")
            expect(text?.type === "text" ? text.text : "").toBe("hello from codex")
            expect(updatedSession.acpSessionID).toBe("acp_test_session")
            expect(todos[0]?.content).toBe("native todo")
          }),
        () => Effect.sync(() => ACPFrontendRuntime.setPromptForTest(undefined)),
      ),
    ),
  )
})
