import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { FailoverPool } from "../../src/failover/pool"
import path from "path"
import { Global } from "../../src/global"
import fs from "fs/promises"

const filepath = path.join(Global.Path.data, "failover.json")

describe("FailoverPool", () => {
  beforeEach(async () => {
    await fs.unlink(filepath).catch(() => {})
  })

  afterEach(async () => {
    await fs.unlink(filepath).catch(() => {})
  })

  test("records outcome and tracks cooldown", async () => {
    await FailoverPool.recordOutcome({
      providerID: "test-provider",
      modelID: "test-model",
      statusCode: 429,
      ok: false,
      cooldownUntil: Date.now() + 5000,
    })

    const available = await FailoverPool.isAvailable("test-provider", "test-model")
    expect(available).toBe(false)
  })

  test("provider becomes available after cooldown expires", async () => {
    await FailoverPool.recordOutcome({
      providerID: "test-provider-2",
      modelID: "test-model",
      statusCode: 429,
      ok: false,
      cooldownUntil: Date.now() - 1000,
    })

    const available = await FailoverPool.isAvailable("test-provider-2", "test-model")
    expect(available).toBe(true)
  })

  test("success clears cooldown", async () => {
    await FailoverPool.recordOutcome({
      providerID: "test-provider-3",
      modelID: "test-model",
      statusCode: 429,
      ok: false,
      cooldownUntil: Date.now() + 5000,
    })

    let available = await FailoverPool.isAvailable("test-provider-3", "test-model")
    expect(available).toBe(false)

    await FailoverPool.recordOutcome({
      providerID: "test-provider-3",
      modelID: "test-model",
      statusCode: 200,
      ok: true,
    })

    available = await FailoverPool.isAvailable("test-provider-3", "test-model")
    expect(available).toBe(true)
  })

  test("tracks success and failure counts", async () => {
    await FailoverPool.recordOutcome({
      providerID: "test-provider-4",
      modelID: "test-model",
      statusCode: 200,
      ok: true,
    })

    await FailoverPool.recordOutcome({
      providerID: "test-provider-4",
      modelID: "test-model",
      statusCode: 200,
      ok: true,
    })

    await FailoverPool.recordOutcome({
      providerID: "test-provider-4",
      modelID: "test-model",
      statusCode: 429,
      ok: false,
    })

    const health = await FailoverPool.getHealth("test-provider-4", "test-model")
    expect(health.successCount).toBe(2)
    expect(health.failureCount).toBe(1)
  })

  test("new provider is available by default", async () => {
    const available = await FailoverPool.isAvailable("new-provider", "new-model")
    expect(available).toBe(true)
  })
})
