// Minimal ACP adapter for testing model discovery.
// Speaks JSON-RPC over stdio, returns configOptions with model category.
import * as readline from "node:readline"

const rl = readline.createInterface({ input: process.stdin })

function send(response: unknown) {
  process.stdout.write(JSON.stringify(response) + "\n")
}

rl.on("line", (line) => {
  let msg: { id?: number; method?: string; params?: unknown }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (!msg.method || msg.id === undefined) return

  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "mock-cursor", version: "0.1.0" },
          agentCapabilities: {},
        },
      })
      break

    case "session/new":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "mock-session-1",
          configOptions: [
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
              ],
            },
          ],
        },
      })
      break

    case "session/set_model":
      send({ jsonrpc: "2.0", id: msg.id, result: {} })
      break

    case "session/prompt":
      // Send a minimal session update then respond
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from mock cursor" },
          },
        },
      })
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          stopReason: "end_turn",
          usage: { totalTokens: 10, inputTokens: 5, outputTokens: 5 },
        },
      })
      break

    case "session/cancel":
      send({ jsonrpc: "2.0", id: msg.id, result: {} })
      break

    default:
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      })
  }
})
