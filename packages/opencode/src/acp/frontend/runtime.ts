export * as ACPFrontendRuntime from "./runtime"

import {
  ClientSideConnection,
  RequestError,
  ndJsonStream,
  type ContentBlock,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalCommandRequest,
  type KillTerminalCommandResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk"
import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"
import * as Log from "@opencode-ai/core/util/log"
import { Context, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { ACPModel } from "@/provider/acp-model"
import { Filesystem } from "@/util/filesystem"
import { Shell } from "@/shell/shell"
import { withTimeout } from "@/util/timeout"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import type * as MessageV2 from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import * as Session from "@/session/session"
import { versionedType } from "@/sync"

const log = Log.create({ service: "acp.frontend.runtime" })
const DEFAULT_OUTPUT_LIMIT = 1024 * 64
const STARTUP_TIMEOUT = 12_000
const CANCEL_TIMEOUT = 5_000
const PROMPT_TIMEOUT = 1000 * 60 * 15
const deletedType = versionedType(Session.Event.Deleted.type, Session.Event.Deleted.version)

type Turn = {
  onUpdate: (update: SessionUpdate) => Promise<void> | void
}

type State = {
  sessionID: SessionID
  acpSessionID: string
  cwd: string
  proc: ChildProcess
  conn: ClientSideConnection
  terms: TermManager
  modelRef: string
  closed: Promise<never>
  turn?: Turn
}

type Store = {
  items: Map<SessionID, State>
}

export type PromptInput = {
  sessionID: SessionID
  cwd: string
  model: {
    providerID: string
    modelID: string
  }
  persistedSessionID?: string
  prompt: ContentBlock[]
  abort: AbortSignal
  onUpdate: (update: SessionUpdate) => Promise<void> | void
}

export type PromptResult = {
  response: PromptResponse
  acpSessionID: string
}

export interface Interface {
  readonly prompt: (input: PromptInput) => Effect.Effect<PromptResult, unknown>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ACPFrontendRuntime") {}

let promptForTest: ((input: PromptInput) => Promise<PromptResult>) | undefined

export function setPromptForTest(fn?: (input: PromptInput) => Promise<PromptResult>) {
  promptForTest = fn
}

export function toPrompt(parts: MessageV2.Part[]): ContentBlock[] {
  const result: ContentBlock[] = []
  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      result.push({ type: "text", text: part.text })
      continue
    }
    if (part.type !== "file") continue

    if (part.url.startsWith("file://")) {
      result.push({
        type: "resource_link",
        uri: part.url,
        name: part.filename ?? "file",
        mimeType: part.mime,
      })
      continue
    }

    if (!part.url.startsWith("data:")) continue

    const match = part.url.match(/^data:([^;]+);base64,(.*)$/)
    if (!match) continue
    const mimeType = match[1] ?? part.mime
    const data = match[2] ?? ""
    if (mimeType.startsWith("image/")) {
      result.push({
        type: "image",
        mimeType,
        data,
        uri: virtualUri(part.filename ?? "image"),
      })
      continue
    }

    const uri = virtualUri(part.filename ?? "file")
    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      result.push({
        type: "resource",
        resource: {
          uri,
          mimeType,
          text: Buffer.from(data, "base64").toString("utf-8"),
        },
      })
      continue
    }

    result.push({
      type: "resource",
      resource: {
        uri,
        mimeType,
        blob: data,
      },
    })
  }
  return result
}

const virtualUri = (name: string) => `file:///opencode/${encodeURIComponent(name)}`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const state = yield* InstanceState.make<Store>(
      Effect.fn("ACPFrontendRuntime.state")(function* (ctx) {
        const items = new Map<SessionID, State>()
        const onEvent = (event: GlobalEvent) => {
          if (event.directory !== ctx.directory) return
          if (event.payload?.type !== "sync") return
          if (event.payload.syncEvent?.type !== deletedType) return
          const item = Array.from(items.values()).find((item) => item.sessionID === event.payload.syncEvent.aggregateID)
          if (!item) return
          void close(item).finally(() => {
            items.delete(item.sessionID)
          })
        }

        GlobalBus.on("event", onEvent)
        yield* Effect.addFinalizer(
          Effect.promise(async () => {
            GlobalBus.off("event", onEvent)
            await Promise.all(Array.from(items.values(), (item) => close(item)))
            items.clear()
          }),
        )

        return { items }
      }),
    )

    const ensure = Effect.fn("ACPFrontendRuntime.ensure")(function* (input: PromptInput) {
      const parsed = ACPModel.extract(input.model)
      if (!parsed) throw new Error(`Expected ACP model, got ${input.model.providerID}/${input.model.modelID}`)

      const items = (yield* InstanceState.get(state)).items
      const existing = items.get(input.sessionID)
      if (existing && existing.proc.exitCode === null) {
        if (existing.modelRef !== parsed.modelRef) {
          yield* Effect.tryPromise(() =>
            Promise.race([
              existing.closed,
              abortPromise(input.abort),
              withTimeout(
                existing.conn.unstable_setSessionModel({
                  sessionId: existing.acpSessionID,
                  modelId: parsed.modelRef,
                }),
                STARTUP_TIMEOUT,
              ),
            ]),
          )
          existing.modelRef = parsed.modelRef
        }
        return existing
      }

      if (existing) {
        items.delete(input.sessionID)
        yield* Effect.promise(() => close(existing))
      }

      const cfg = yield* config.get()
      const command = ACPModel.config(cfg.acp, parsed.adapter)
      const proc = spawn(command.command, [], {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...command.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: true,
      })
      const terms = new TermManager()
      let stderr = ""
      let current: State | undefined

      proc.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk)
        log.debug("acp stderr", { output: String(chunk) })
      })

      const conn = new ClientSideConnection(
        () => ({
          async sessionUpdate(params) {
            if (!current?.turn) return
            if (params.sessionId !== current.acpSessionID) return
            await current.turn.onUpdate(params.update)
          },
          async requestPermission(params) {
            return allow(params)
          },
          async readTextFile(params) {
            return readText(current, params)
          },
          async writeTextFile(params) {
            return writeText(current, params)
          },
          async createTerminal(params) {
            return terms.create(params, current?.cwd ?? input.cwd)
          },
          async terminalOutput(params) {
            return terms.output(params)
          },
          async waitForTerminalExit(params) {
            return terms.wait(params)
          },
          async killTerminal(params) {
            return terms.kill(params)
          },
          async releaseTerminal(params) {
            return terms.release(params)
          },
        }),
        ndJsonStream(toWritable(proc), toReadable(proc)),
      )

      const closed = raceClose(proc, parsed.adapter, () => stderr)
      void closed.catch(() => undefined)

      const startup = yield* Effect.tryPromise({
        try: async () => {
          try {
            await withTimeout(
              Promise.race([
                closed,
                abortPromise(input.abort),
                conn.initialize({
                  protocolVersion: 1,
                  clientInfo: {
                    name: "opencode",
                    title: "OpenCode",
                    version: "local",
                  },
                  clientCapabilities: {
                    fs: {
                      readTextFile: true,
                      writeTextFile: true,
                    },
                    terminal: true,
                  },
                }),
              ]),
              STARTUP_TIMEOUT,
            )

            if (input.persistedSessionID) {
              try {
                await withTimeout(
                  Promise.race([
                    closed,
                    abortPromise(input.abort),
                    conn.loadSession({
                      cwd: input.cwd,
                      sessionId: input.persistedSessionID,
                      mcpServers: [],
                    }),
                  ]),
                  STARTUP_TIMEOUT,
                )
                return input.persistedSessionID
              } catch (error) {
                log.warn("failed to load persisted ACP session, creating a new one", {
                  error,
                  sessionID: input.sessionID,
                  acpSessionID: input.persistedSessionID,
                })
              }
            }

            const created = await withTimeout(
              Promise.race([
                closed,
                abortPromise(input.abort),
                conn.newSession({
                  cwd: input.cwd,
                  mcpServers: [],
                }),
              ]),
              STARTUP_TIMEOUT,
            )
            return created.sessionId
          } catch (error) {
            await close({
              sessionID: input.sessionID,
              acpSessionID: input.persistedSessionID ?? "",
              cwd: input.cwd,
              proc,
              conn,
              terms,
              modelRef: parsed.modelRef,
              closed,
            })
            throw new Error(
              stderr.trim()
                ? `Failed to start ${parsed.adapter} ACP adapter: ${stderr.trim()}`
                : `Failed to start ${parsed.adapter} ACP adapter`,
              { cause: error },
            )
          }
        },
        catch: (cause) => cause,
      })

      current = {
        sessionID: input.sessionID,
        acpSessionID: startup,
        cwd: input.cwd,
        proc,
        conn,
        terms,
        modelRef: parsed.modelRef,
        closed,
      }
      items.set(input.sessionID, current)

      yield* Effect.tryPromise(() =>
        Promise.race([
          current.closed,
          abortPromise(input.abort),
          withTimeout(
            current.conn.unstable_setSessionModel({
              sessionId: current.acpSessionID,
              modelId: parsed.modelRef,
            }),
            STARTUP_TIMEOUT,
          ),
        ]),
      ).pipe(Effect.catchAll(() => Effect.void))

      return current
    })

    const prompt = Effect.fn("ACPFrontendRuntime.prompt")(function* (input: PromptInput) {
      if (promptForTest) {
        return yield* Effect.tryPromise(() => promptForTest(input))
      }

      const item = yield* ensure(input)
      item.turn = { onUpdate: input.onUpdate }

      const cancel = () => {
        Promise.race([
          item.closed,
          abortPromise(input.abort),
          withTimeout(
            item.conn.cancel({
              sessionId: item.acpSessionID,
            }),
            CANCEL_TIMEOUT,
          ),
        ]).catch((error) => {
          log.error("failed to cancel ACP prompt", { error, sessionID: input.sessionID })
        })
      }

      input.abort.addEventListener("abort", cancel, { once: true })
      try {
        const response = yield* Effect.tryPromise(() =>
          Promise.race([
            item.closed,
            abortPromise(input.abort),
            withTimeout(
              item.conn.prompt({
                sessionId: item.acpSessionID,
                prompt: input.prompt,
              }),
              PROMPT_TIMEOUT,
            ),
          ]),
        )
        return {
          response,
          acpSessionID: item.acpSessionID,
        }
      } finally {
        item.turn = undefined
        input.abort.removeEventListener("abort", cancel)
      }
    })

    const cancel = Effect.fn("ACPFrontendRuntime.cancel")(function* (sessionID: SessionID) {
      const item = (yield* InstanceState.get(state)).items.get(sessionID)
      if (!item) return
      yield* Effect.tryPromise(() =>
        Promise.race([
          item.closed,
          withTimeout(
            item.conn.cancel({
              sessionId: item.acpSessionID,
            }),
            CANCEL_TIMEOUT,
          ),
        ]),
      ).pipe(Effect.catchAll(() => Effect.void))
    })

    return Service.of({ prompt, cancel })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

function resolvePath(item: State | undefined, filepath: string) {
  if (path.isAbsolute(filepath)) return filepath
  return path.resolve(item?.cwd ?? process.cwd(), filepath)
}

async function allow(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
  const option = params.options.find((item) => item.kind.startsWith("allow")) ?? params.options[0]
  if (!option) {
    return { outcome: { outcome: "cancelled" } }
  }
  return {
    outcome: {
      outcome: "selected",
      optionId: option.optionId,
    },
  }
}

async function readText(item: State | undefined, params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  const filepath = resolvePath(item, params.path)
  if (!(await Filesystem.exists(filepath))) {
    throw RequestError.resourceNotFound(filepath)
  }
  const text = await Filesystem.readText(filepath)
  const start = params.line ? Math.max(0, params.line - 1) : 0
  if (!params.line && !params.limit) {
    return { content: text }
  }
  const lines = text.split("\n")
  return {
    content: lines.slice(start, params.limit ? start + params.limit : undefined).join("\n"),
  }
}

async function writeText(item: State | undefined, params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  await Filesystem.write(resolvePath(item, params.path), params.content)
  return {}
}

async function close(item: State) {
  await item.terms.dispose()
  await Shell.killTree(item.proc, { exited: () => item.proc.exitCode !== null })
}

function raceClose(proc: ChildProcess, adapter: ACPModel.AdapterID, stderr: () => string) {
  return new Promise<never>((_, reject) => {
    const fail = (message: string, cause?: unknown) => {
      const suffix = stderr().trim()
      reject(new Error(suffix ? `${message}: ${suffix}` : message, { cause }))
    }

    proc.once("error", (error) => fail(`Failed to start ${adapter} ACP adapter`, error))
    proc.once("exit", (code, signal) => {
      fail(`ACP adapter exited unexpectedly${code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : ""}`)
    })
  })
}

function abortPromise(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error("ACP prompt aborted"))
      return
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(new Error("ACP prompt aborted"))
      },
      { once: true },
    )
  })
}

function toWritable(proc: ChildProcess) {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      if (!proc.stdin?.writable) return
      return new Promise<void>((resolve, reject) => {
        proc.stdin?.write(chunk, (error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
    close() {
      proc.stdin?.end()
    },
    abort() {
      proc.stdin?.destroy()
    },
  })
}

function toReadable(proc: ChildProcess) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      proc.stdout?.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      proc.stdout?.once("end", () => controller.close())
      proc.stdout?.once("error", (error) => controller.error(error))
    },
    cancel() {
      proc.stdout?.destroy()
    },
  })
}

type Term = {
  proc: ChildProcess
  output: string
  truncated: boolean
  limit: number
  exit?: {
    exitCode?: number | null
    signal?: string | null
  }
  done: Promise<WaitForTerminalExitResponse>
  resolve: (value: WaitForTerminalExitResponse) => void
}

class TermManager {
  private all = new Map<string, Term>()
  private count = 0

  async create(params: CreateTerminalRequest, cwdDefault: string): Promise<CreateTerminalResponse> {
    const terminalId = `term_${++this.count}`
    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? cwdDefault,
      env: {
        ...process.env,
        ...Object.fromEntries((params.env ?? []).map((item) => [item.name, item.value])),
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    const deferred = Promise.withResolvers<WaitForTerminalExitResponse>()
    const term: Term = {
      proc,
      output: "",
      truncated: false,
      limit: params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT,
      done: deferred.promise,
      resolve: deferred.resolve,
    }

    const append = (chunk: Buffer) => {
      term.output += chunk.toString("utf-8")
      const size = Buffer.byteLength(term.output, "utf-8")
      if (size <= term.limit) return
      term.output = Buffer.from(term.output, "utf-8")
        .subarray(size - term.limit)
        .toString("utf-8")
      term.truncated = true
    }

    proc.stdout?.on("data", (chunk: Buffer) => append(chunk))
    proc.stderr?.on("data", (chunk: Buffer) => append(chunk))
    proc.once("exit", (exitCode, signal) => {
      term.exit = { exitCode, signal }
      term.resolve({ exitCode, signal })
    })
    this.all.set(terminalId, term)
    return { terminalId }
  }

  async output(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const term = this.get(params.terminalId)
    return {
      output: term.output,
      truncated: term.truncated,
      ...(term.exit
        ? {
            exitStatus: {
              exitCode: term.exit.exitCode,
              signal: term.exit.signal,
            },
          }
        : {}),
    }
  }

  async wait(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    return this.get(params.terminalId).done
  }

  async kill(params: KillTerminalCommandRequest): Promise<KillTerminalCommandResponse> {
    const term = this.get(params.terminalId)
    await Shell.killTree(term.proc, { exited: () => term.proc.exitCode !== null })
    return {}
  }

  async release(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const term = this.get(params.terminalId)
    if (!term.exit) {
      await Shell.killTree(term.proc, { exited: () => term.proc.exitCode !== null })
    }
    this.all.delete(params.terminalId)
    return {}
  }

  async dispose() {
    await Promise.all(
      Array.from(this.all.entries(), async ([terminalId, term]) => {
        if (!term.exit) {
          await Shell.killTree(term.proc, { exited: () => term.proc.exitCode !== null })
        }
        this.all.delete(terminalId)
      }),
    )
  }

  private get(terminalId: string) {
    const term = this.all.get(terminalId)
    if (!term) {
      throw RequestError.resourceNotFound(terminalId)
    }
    return term
  }
}
