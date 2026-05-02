export * as ACPFrontendMapper from "./mapper"

import { Effect } from "effect"
import type { SessionUpdate, ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk"
import { PartID } from "@/session/schema"
import type * as MessageV2 from "@/session/message-v2"
import type { Interface as SessionInterface } from "@/session/session"
import type { Interface as TodoInterface } from "@/session/todo"

export type State = {
  text?: MessageV2.TextPart
  reasoning?: MessageV2.ReasoningPart
  tools: Record<string, MessageV2.ToolPart>
}

export function create(): State {
  return {
    tools: {},
  }
}

export const apply = Effect.fn("ACPFrontendMapper.apply")(function* (input: {
  state: State
  message: MessageV2.Assistant
  update: SessionUpdate
  sessions: SessionInterface
  todo: TodoInterface
}) {
  switch (input.update.sessionUpdate) {
    case "agent_message_chunk":
      if (input.update.content.type !== "text") return
      yield* appendText({
        kind: "text",
        state: input.state,
        sessions: input.sessions,
        sessionID: input.message.sessionID,
        messageID: input.message.id,
        delta: input.update.content.text,
      })
      return
    case "agent_thought_chunk":
      if (input.update.content.type !== "text") return
      yield* appendText({
        kind: "reasoning",
        state: input.state,
        sessions: input.sessions,
        sessionID: input.message.sessionID,
        messageID: input.message.id,
        delta: input.update.content.text,
      })
      return
    case "tool_call": {
      yield* finalizeText({ state: input.state, sessions: input.sessions })
      yield* finalizeReasoning({ state: input.state, sessions: input.sessions })
      const part = yield* upsertTool({
        state: input.state,
        sessions: input.sessions,
        sessionID: input.message.sessionID,
        messageID: input.message.id,
        toolCallId: input.update.toolCallId,
        title: input.update.title,
      })
      input.state.tools[input.update.toolCallId] = yield* input.sessions.updatePart({
        ...part,
        tool: input.update.title,
        state: {
          status: "pending",
          input: record(input.update.rawInput),
          raw:
            typeof input.update.rawInput === "string"
              ? input.update.rawInput
              : JSON.stringify(input.update.rawInput ?? {}),
        },
      })
      return
    }
    case "tool_call_update":
      yield* finalizeText({ state: input.state, sessions: input.sessions })
      yield* updateTool({
        state: input.state,
        sessions: input.sessions,
        sessionID: input.message.sessionID,
        messageID: input.message.id,
        update: input.update,
      })
      return
    case "plan":
      yield* input.todo.update({
        sessionID: input.message.sessionID,
        todos: input.update.entries.map((entry) => ({
          content: entry.content,
          status: entry.status,
          priority: entry.priority ?? "medium",
        })),
      })
      return
    case "usage_update":
      input.message.cost = input.update.cost?.amount ?? input.message.cost
      return
    default:
      return
  }
})

const finalizeText = Effect.fn("ACPFrontendMapper.finalizeText")(function* (input: {
  state: State
  sessions: SessionInterface
}) {
  if (!input.state.text) return
  input.state.text.time = {
    start: input.state.text.time?.start ?? Date.now(),
    end: Date.now(),
  }
  yield* input.sessions.updatePart(input.state.text)
  input.state.text = undefined
})

const finalizeReasoning = Effect.fn("ACPFrontendMapper.finalizeReasoning")(function* (input: {
  state: State
  sessions: SessionInterface
}) {
  if (!input.state.reasoning) return
  input.state.reasoning.time = {
    start: input.state.reasoning.time.start,
    end: Date.now(),
  }
  yield* input.sessions.updatePart(input.state.reasoning)
  input.state.reasoning = undefined
})

export const finish = Effect.fn("ACPFrontendMapper.finish")(function* (input: {
  state: State
  sessions: SessionInterface
}) {
  yield* finalizeText(input)
  yield* finalizeReasoning(input)
})

const appendText = Effect.fn("ACPFrontendMapper.appendText")(function* (input: {
  kind: "text" | "reasoning"
  state: State
  sessions: SessionInterface
  sessionID: MessageV2.TextPart["sessionID"]
  messageID: MessageV2.TextPart["messageID"]
  delta: string
}) {
  if (!input.delta) return

  if (input.kind === "text") {
    if (!input.state.text) {
      input.state.text = yield* input.sessions.updatePart({
        id: PartID.ascending(),
        type: "text",
        text: "",
        sessionID: input.sessionID,
        messageID: input.messageID,
        time: { start: Date.now() },
      })
    }
    input.state.text.text += input.delta
    yield* input.sessions.updatePartDelta({
      sessionID: input.sessionID,
      messageID: input.messageID,
      partID: input.state.text.id,
      field: "text",
      delta: input.delta,
    })
    return
  }

  if (!input.state.reasoning) {
    input.state.reasoning = yield* input.sessions.updatePart({
      id: PartID.ascending(),
      type: "reasoning",
      text: "",
      sessionID: input.sessionID,
      messageID: input.messageID,
      time: { start: Date.now() },
    })
  }
  input.state.reasoning.text += input.delta
  yield* input.sessions.updatePartDelta({
    sessionID: input.sessionID,
    messageID: input.messageID,
    partID: input.state.reasoning.id,
    field: "text",
    delta: input.delta,
  })
})

const upsertTool = Effect.fn("ACPFrontendMapper.upsertTool")(function* (input: {
  state: State
  sessions: SessionInterface
  sessionID: MessageV2.ToolPart["sessionID"]
  messageID: MessageV2.ToolPart["messageID"]
  toolCallId: string
  title: string
}) {
  const existing = input.state.tools[input.toolCallId]
  if (existing) return existing

  const part = yield* input.sessions.updatePart({
    id: PartID.ascending(),
    type: "tool",
    callID: input.toolCallId,
    tool: input.title,
    sessionID: input.sessionID,
    messageID: input.messageID,
    state: {
      status: "pending",
      input: {},
      raw: "{}",
    },
  })
  input.state.tools[input.toolCallId] = part
  return part
})

const updateTool = Effect.fn("ACPFrontendMapper.updateTool")(function* (input: {
  state: State
  sessions: SessionInterface
  sessionID: MessageV2.ToolPart["sessionID"]
  messageID: MessageV2.ToolPart["messageID"]
  update: ToolCallUpdate
}) {
  const part = yield* upsertTool({
    state: input.state,
    sessions: input.sessions,
    sessionID: input.sessionID,
    messageID: input.messageID,
    toolCallId: input.update.toolCallId,
    title: input.update.title ?? "tool",
  })
  const title = input.update.title ?? part.tool
  const inputValue = record(input.update.rawInput)
  const output = contentText(input.update.content)

  if (input.update.status === "in_progress") {
    input.state.tools[input.update.toolCallId] = yield* input.sessions.updatePart({
      ...part,
      tool: title,
      state: {
        status: "running",
        input: inputValue,
        title,
        metadata: {
          ...record(input.update.rawOutput),
          ...(output ? { output } : {}),
        },
        time: {
          start: part.state.status === "running" ? part.state.time.start : Date.now(),
        },
      },
    })
    return
  }

  if (input.update.status === "completed") {
    input.state.tools[input.update.toolCallId] = yield* input.sessions.updatePart({
      ...part,
      tool: title,
      state: {
        status: "completed",
        input: inputValue,
        output,
        title,
        metadata: {
          ...record(input.update.rawOutput),
          ...(output ? { output } : {}),
        },
        time: {
          start: part.state.status === "running" ? part.state.time.start : Date.now(),
          end: Date.now(),
        },
      },
    })
    return
  }

  input.state.tools[input.update.toolCallId] = yield* input.sessions.updatePart({
    ...part,
    tool: title,
    state: {
      status: "error",
      input: inputValue,
      error: output || "Tool failed",
      metadata: {
        ...record(input.update.rawOutput),
        ...(output ? { output } : {}),
      },
      time: {
        start: part.state.status === "running" ? part.state.time.start : Date.now(),
        end: Date.now(),
      },
    },
  })
})

function record(value: unknown) {
  if (!value || typeof value !== "object") return {}
  return value as Record<string, unknown>
}

function contentText(content?: ToolCallContent[] | null) {
  if (!content?.length) return ""
  return content
    .flatMap((item) => {
      if (item.type === "content") {
        if (item.content.type === "text") return [item.content.text]
        return [JSON.stringify(item.content)]
      }
      if (item.type === "diff") return [`Diff ${item.path}`]
      if (item.type === "terminal") return [`Terminal ${item.terminalId}`]
      return []
    })
    .join("\n")
    .trim()
}
