import { describe, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { createOAuthRotatingFetch } from "../../src/auth/rotating-fetch"
import { MemorySecretsBackend, setSecretsBackend } from "../../src/auth/secrets"
import { withOAuthRecord } from "../../src/auth/context"

describe("OAuth subscription failover", () => {
  const providerID = "oauth-rotation-test"

  test("rotates on 429 (Retry-After) and succeeds with next account", async () => {
    setSecretsBackend(new MemorySecretsBackend())
    await Auth.remove(providerID)

    const a1 = await Auth.addOAuth(providerID, {
      refresh: "r1",
      access: "a1",
      expires: Date.now() + 60_000,
    })
    const a2 = await Auth.addOAuth(providerID, {
      refresh: "r2",
      access: "a2",
      expires: Date.now() + 60_000,
    })

    const baseFetch = async (_input: string, _init?: RequestInit) => {
      const auth = await Auth.get(providerID)
      expect(auth?.type).toBe("oauth")
      if (!auth || auth.type !== "oauth") return new Response("no auth", { status: 500 })

      if (auth.refresh === "r1") {
        return new Response("rate limited", {
          status: 429,
          headers: {
            "Retry-After": "1",
          },
        })
      }

      return new Response("ok", { status: 200 })
    }

    const fetchWithFailover = createOAuthRotatingFetch(baseFetch, { providerID })
    const response = await fetchWithFailover("https://example.com", { method: "POST", body: "{}" })

    expect(response.status).toBe(200)

    const order = await Auth.OAuthPool.orderedIDs(providerID)
    expect(order[0]).toBe(a2.recordID)
    expect(order[1]).toBe(a1.recordID)
  })

  test("updates the correct OAuth record by refresh token without record context", async () => {
    setSecretsBackend(new MemorySecretsBackend())
    await Auth.remove(providerID)

    const a1 = await Auth.addOAuth(providerID, {
      refresh: "r1",
      access: "a1",
      expires: Date.now() + 60_000,
    })
    const a2 = await Auth.addOAuth(providerID, {
      refresh: "r2",
      access: "a2",
      expires: Date.now() + 60_000,
    })

    await Auth.set(providerID, {
      type: "oauth",
      refresh: "r1",
      access: "updated-a1",
      expires: Date.now() + 60_000,
    })

    const record1 = await withOAuthRecord(providerID, a1.recordID, async () => Auth.get(providerID))
    const record2 = await withOAuthRecord(providerID, a2.recordID, async () => Auth.get(providerID))

    expect(record1?.type).toBe("oauth")
    expect(record1 && record1.type === "oauth" ? record1.access : "").toBe("updated-a1")

    expect(record2?.type).toBe("oauth")
    expect(record2 && record2.type === "oauth" ? record2.access : "").toBe("a2")
  })

  test("throws when all accounts are on cooldown to allow cross-provider failover", async () => {
    setSecretsBackend(new MemorySecretsBackend())
    await Auth.remove(providerID)

    const a1 = await Auth.addOAuth(providerID, {
      refresh: "r1",
      access: "a1",
      expires: Date.now() + 60_000,
    })
    const a2 = await Auth.addOAuth(providerID, {
      refresh: "r2",
      access: "a2",
      expires: Date.now() + 60_000,
    })

    // Set both accounts on cooldown
    await Auth.OAuthPool.recordOutcome({
      providerID,
      recordID: a1.recordID,
      statusCode: 429,
      ok: false,
      cooldownUntil: Date.now() + 60_000,
    })
    await Auth.OAuthPool.recordOutcome({
      providerID,
      recordID: a2.recordID,
      statusCode: 429,
      ok: false,
      cooldownUntil: Date.now() + 60_000,
    })

    const baseFetch = async (_input: string, _init?: RequestInit) =>
      new Response("should not be called", { status: 200 })

    const fetchWithFailover = createOAuthRotatingFetch(baseFetch, { providerID })

    // Should throw an error so cross-provider failover can kick in
    let thrownError: Error | null = null
    try {
      await fetchWithFailover("https://example.com", { method: "POST", body: "{}" })
    } catch (e) {
      thrownError = e as Error
    }

    expect(thrownError).not.toBeNull()
    expect(thrownError?.message).toContain("All OAuth accounts")
    expect(thrownError?.message).toContain("cooldown")
    expect((thrownError as any)?.status).toBe(429)
    expect((thrownError as any)?.isAllAccountsOnCooldown).toBe(true)
  })

  test("retries once on 401/403 by forcing refresh, then succeeds", async () => {
    setSecretsBackend(new MemorySecretsBackend())
    await Auth.remove(providerID)

    const a1 = await Auth.addOAuth(providerID, {
      refresh: "r1",
      access: "bad",
      expires: Date.now() + 60_000,
    })
    await Auth.addOAuth(providerID, {
      refresh: "r2",
      access: "ok",
      expires: Date.now() + 60_000,
    })

    const baseFetch = async (_input: string, _init?: RequestInit) => {
      const auth = await Auth.get(providerID)
      expect(auth?.type).toBe("oauth")
      if (!auth || auth.type !== "oauth") return new Response("no auth", { status: 500 })

      // Simulate plugin refresh behavior: when access is cleared/expired,
      // it refreshes and persists via Auth.set().
      if (!auth.access) {
        await Auth.set(providerID, {
          type: "oauth",
          refresh: auth.refresh,
          access: `refreshed-${auth.refresh}`,
          expires: Date.now() + 60_000,
        })
        return new Response("ok", { status: 200 })
      }

      if (auth.access === "bad") {
        return new Response("unauthorized", { status: 401 })
      }

      return new Response("ok", { status: 200 })
    }

    const fetchWithFailover = createOAuthRotatingFetch(baseFetch, { providerID })
    const response = await fetchWithFailover("https://example.com", { method: "POST", body: "{}" })
    expect(response.status).toBe(200)

    const record1 = await withOAuthRecord(providerID, a1.recordID, async () => Auth.get(providerID))
    expect(record1?.type).toBe("oauth")
    expect(record1 && record1.type === "oauth" ? record1.access : "").toBe("refreshed-r1")
  })
})
