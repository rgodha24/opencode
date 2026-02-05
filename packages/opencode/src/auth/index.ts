import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import z from "zod"
import { ulid } from "ulid"
import { getOAuthRecordID } from "./context"
import { getSecretsBackend } from "./secrets"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export namespace Auth {
  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  const SERVICE = "opencode"
  const filepath = path.join(Global.Path.data, "auth.json")

  const OAuthSecret = z
    .object({
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
    })
    .strict()
  type OAuthSecret = z.infer<typeof OAuthSecret>

  const Health = z
    .object({
      cooldownUntil: z.number().optional(),
      lastStatusCode: z.number().optional(),
      lastErrorAt: z.number().optional(),
      successCount: z.number().default(0),
      failureCount: z.number().default(0),
    })
    .strict()
    .default(() => ({ successCount: 0, failureCount: 0 }))

  export const OAuthRecordMeta = z
    .object({
      id: z.string(),
      namespace: z.string().default("default"),
      label: z.string().optional(),
      enterpriseUrl: z.string().optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
      health: Health,
    })
    .strict()
  export type OAuthRecordMeta = z.infer<typeof OAuthRecordMeta>

  const OAuthProvider = z
    .object({
      type: z.literal("oauth"),
      active: z.record(z.string(), z.string()).default({}),
      order: z.record(z.string(), z.array(z.string())).default({}),
      records: z.array(OAuthRecordMeta).default([]),
    })
    .strict()
  type OAuthProvider = z.infer<typeof OAuthProvider>

  const ApiProvider = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .strict()

  const WellKnownProvider = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .strict()

  const ProviderEntry = z.union([OAuthProvider, ApiProvider, WellKnownProvider])
  type ProviderEntry = z.infer<typeof ProviderEntry>

  const StoreFile = z
    .object({
      version: z.literal(2),
      providers: z.record(z.string(), ProviderEntry).default({}),
    })
    .strict()
  type StoreFile = z.infer<typeof StoreFile>

  function secretName(parts: string[]): string {
    return parts.map((p) => encodeURIComponent(p)).join(":")
  }

  function apiSecretName(providerID: string): string {
    return secretName(["api", providerID])
  }

  function wellknownSecretName(providerID: string): string {
    return secretName(["wellknown", providerID])
  }

  function oauthSecretName(input: { providerID: string; namespace: string; recordID: string }): string {
    return secretName(["oauth", input.providerID, input.namespace, input.recordID])
  }

  async function ensureDataDir(): Promise<void> {
    await fs.mkdir(path.dirname(filepath), { recursive: true })
  }

  async function writeStoreFile(store: StoreFile): Promise<void> {
    await ensureDataDir()
    const tempPath = `${filepath}.tmp`
    const tempFile = Bun.file(tempPath)
    await Bun.write(tempFile, JSON.stringify(store, null, 2))
    await fs.rename(tempPath, filepath)
    await fs.chmod(filepath, 0o600).catch(() => {})
  }

  async function loadStoreFile(): Promise<StoreFile> {
    const file = Bun.file(filepath)
    const raw = await file.json().catch(() => undefined)

    const parsed = StoreFile.safeParse(raw)
    if (parsed.success) return parsed.data

    const legacyParsed = z.record(z.string(), Info).safeParse(raw)
    if (legacyParsed.success) {
      let secrets: ReturnType<typeof getSecretsBackend> | undefined
      const now = Date.now()
      const next: StoreFile = { version: 2, providers: {} }

      for (const [providerID, info] of Object.entries(legacyParsed.data)) {
        if (info.type === "api") {
          next.providers[providerID] = { type: "api", key: info.key }
          continue
        }

        if (info.type === "wellknown") {
          next.providers[providerID] = { type: "wellknown", key: info.key, token: info.token }
          continue
        }

        const recordID = ulid()
        secrets ??= getSecretsBackend()
        await secrets.set({
          service: SERVICE,
          name: oauthSecretName({ providerID, namespace: "default", recordID }),
          value: JSON.stringify({
            refresh: info.refresh,
            access: info.access,
            expires: info.expires,
          } satisfies OAuthSecret),
        })
        next.providers[providerID] = {
          type: "oauth",
          active: { default: recordID },
          order: { default: [recordID] },
          records: [
            {
              id: recordID,
              namespace: "default",
              label: "default",
              enterpriseUrl: info.enterpriseUrl,
              createdAt: now,
              updatedAt: now,
              health: { successCount: 0, failureCount: 0 },
            },
          ],
        }
      }

      await writeStoreFile(next)
      return next
    }

    return { version: 2, providers: {} }
  }

  function ensureOAuthProvider(store: StoreFile, providerID: string): OAuthProvider {
    const existing = store.providers[providerID]
    if (existing && existing.type === "oauth") return existing

    const next: OAuthProvider = {
      type: "oauth",
      active: {},
      order: {},
      records: [],
    }
    store.providers[providerID] = next
    return next
  }

  function findOAuthRecord(provider: OAuthProvider, recordID: string): OAuthRecordMeta | undefined {
    return provider.records.find((r) => r.id === recordID)
  }

  function normalizeOrder(ids: string[], order: string[]): string[] {
    const ordered: string[] = []
    for (const id of order) {
      if (ids.includes(id) && !ordered.includes(id)) ordered.push(id)
    }
    for (const id of ids) {
      if (!ordered.includes(id)) ordered.push(id)
    }
    return ordered
  }

  function recordIDsForNamespace(provider: OAuthProvider, namespace: string): string[] {
    const ids = provider.records.filter((r) => r.namespace === namespace).map((r) => r.id)
    const order = provider.order[namespace] ?? []
    return normalizeOrder(ids, order)
  }

  async function getOAuthSecret(input: {
    providerID: string
    namespace: string
    recordID: string
  }): Promise<OAuthSecret | undefined> {
    const secrets = getSecretsBackend()
    const raw = await secrets.get({ service: SERVICE, name: oauthSecretName(input) })
    if (!raw) return undefined
    const json = JSON.parse(raw) as unknown
    const parsed = OAuthSecret.safeParse(json)
    return parsed.success ? parsed.data : undefined
  }

  async function setOAuthSecret(input: {
    providerID: string
    namespace: string
    recordID: string
    secret: OAuthSecret
  }): Promise<void> {
    const secrets = getSecretsBackend()
    await secrets.set({
      service: SERVICE,
      name: oauthSecretName(input),
      value: JSON.stringify(input.secret),
    })
  }

  async function findOAuthRecordIDByRefreshToken(input: {
    providerID: string
    namespace: string
    refresh: string
    provider: OAuthProvider
  }): Promise<string | undefined> {
    for (const record of input.provider.records) {
      if (record.namespace !== input.namespace) continue
      const secret = await getOAuthSecret({
        providerID: input.providerID,
        namespace: input.namespace,
        recordID: record.id,
      })
      if (!secret) continue
      if (secret.refresh === input.refresh) return record.id
    }
    return undefined
  }

  export async function get(providerID: string) {
    const store = await loadStoreFile()
    const entry = store.providers[providerID]
    if (!entry) return undefined

    if (entry.type === "api") {
      return { type: "api" as const, key: entry.key }
    }

    if (entry.type === "wellknown") {
      return { type: "wellknown" as const, key: entry.key, token: entry.token }
    }

    const namespace = "default"
    const contextID = getOAuthRecordID(providerID)
    const active = contextID ?? entry.active[namespace]
    const ordered = recordIDsForNamespace(entry, namespace)
    const recordID = active && ordered.includes(active) ? active : ordered[0]
    if (!recordID) return undefined

    const meta = findOAuthRecord(entry, recordID)
    const secret = await getOAuthSecret({ providerID, namespace, recordID })
    if (!secret) return undefined
    return {
      type: "oauth" as const,
      refresh: secret.refresh,
      access: secret.access,
      expires: secret.expires,
      enterpriseUrl: meta?.enterpriseUrl,
    }
  }

  export async function all(): Promise<Record<string, Info>> {
    const store = await loadStoreFile()
    const out: Record<string, Info> = {}

    for (const providerID of Object.keys(store.providers)) {
      const info = await get(providerID)
      if (!info) continue
      out[providerID] = info
    }

    return out
  }

  export async function set(key: string, info: Info) {
    const store = await loadStoreFile()

    if (info.type === "api") {
      store.providers[key] = { type: "api" as const, key: info.key }
      await writeStoreFile(store)
      return
    }

    if (info.type === "wellknown") {
      store.providers[key] = { type: "wellknown" as const, key: info.key, token: info.token }
      await writeStoreFile(store)
      return
    }

    const namespace = "default"
    const provider = ensureOAuthProvider(store, key)
    const recordID =
      getOAuthRecordID(key) ??
      (await findOAuthRecordIDByRefreshToken({ providerID: key, namespace, refresh: info.refresh, provider })) ??
      provider.active[namespace] ??
      recordIDsForNamespace(provider, namespace)[0] ??
      ulid()

    const now = Date.now()
    const existing = findOAuthRecord(provider, recordID)
    if (!existing) {
      provider.records.push({
        id: recordID,
        namespace,
        label: "default",
        enterpriseUrl: info.enterpriseUrl,
        createdAt: now,
        updatedAt: now,
        health: { successCount: 0, failureCount: 0 },
      })
      provider.order[namespace] = [...(provider.order[namespace] ?? []), recordID]
    } else {
      existing.updatedAt = now
      existing.enterpriseUrl = info.enterpriseUrl
    }
    provider.active[namespace] = recordID

    await setOAuthSecret({
      providerID: key,
      namespace,
      recordID,
      secret: { refresh: info.refresh, access: info.access, expires: info.expires },
    })

    await writeStoreFile(store)
  }

  export async function remove(key: string) {
    const store = await loadStoreFile()
    const existing = store.providers[key]
    if (!existing) return

    if (existing.type === "api") {
      delete store.providers[key]
      await writeStoreFile(store)
      return
    }

    if (existing.type === "wellknown") {
      delete store.providers[key]
      await writeStoreFile(store)
      return
    }

    const secrets = getSecretsBackend()
    for (const record of existing.records) {
      await secrets
        .delete({
          service: SERVICE,
          name: oauthSecretName({ providerID: key, namespace: record.namespace, recordID: record.id }),
        })
        .catch(() => false)
    }
    delete store.providers[key]
    await writeStoreFile(store)
  }

  export async function addOAuth(
    providerID: string,
    input: Omit<z.infer<typeof Oauth>, "type"> & { namespace?: string; label?: string },
  ) {
    const namespace = (input.namespace ?? "default").trim() || "default"
    const store = await loadStoreFile()

    const provider = ensureOAuthProvider(store, providerID)
    const now = Date.now()
    const existingRecordID = await findOAuthRecordIDByRefreshToken({
      providerID,
      namespace,
      refresh: input.refresh,
      provider,
    })

    if (existingRecordID) {
      const existing = findOAuthRecord(provider, existingRecordID)
      if (existing) {
        existing.updatedAt = now
        existing.enterpriseUrl = input.enterpriseUrl
        if (input.label) existing.label = input.label
      }
      const order = provider.order[namespace] ?? []
      if (!order.includes(existingRecordID)) {
        provider.order[namespace] = [...order, existingRecordID]
      }
      provider.active[namespace] = existingRecordID

      await setOAuthSecret({
        providerID,
        namespace,
        recordID: existingRecordID,
        secret: { refresh: input.refresh, access: input.access, expires: input.expires },
      })
      await writeStoreFile(store)
      return { providerID, namespace, recordID: existingRecordID }
    }

    const recordID = ulid()

    provider.records.push({
      id: recordID,
      namespace,
      label: input.label,
      enterpriseUrl: input.enterpriseUrl,
      createdAt: now,
      updatedAt: now,
      health: { successCount: 0, failureCount: 0 },
    })

    provider.order[namespace] = [...(provider.order[namespace] ?? []), recordID]
    provider.active[namespace] = recordID

    await setOAuthSecret({
      providerID,
      namespace,
      recordID,
      secret: { refresh: input.refresh, access: input.access, expires: input.expires },
    })
    await writeStoreFile(store)

    return { providerID, namespace, recordID }
  }

  export namespace OAuthPool {
    export async function snapshot(
      providerID: string,
      namespace = "default",
    ): Promise<{ records: OAuthRecordMeta[]; orderedIDs: string[] }> {
      const store = await loadStoreFile()
      const provider = store.providers[providerID]
      if (!provider || provider.type !== "oauth") return { records: [], orderedIDs: [] }

      const normalized = namespace.trim() || "default"
      const records = provider.records.filter((r) => r.namespace === normalized)

      // Check if any account is currently in cooldown
      const now = Date.now()
      const hasActiveCooldown = records.some((r) => r.health.cooldownUntil && r.health.cooldownUntil > now)

      // If no cooldowns active, prefer order by createdAt (first-added = preferred)
      // This ensures we always try the preferred account first when it's available
      const orderedIDs = hasActiveCooldown
        ? recordIDsForNamespace(provider, normalized)
        : records
            .slice()
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((r) => r.id)

      return { records, orderedIDs }
    }

    export async function list(providerID: string, namespace = "default"): Promise<OAuthRecordMeta[]> {
      return snapshot(providerID, namespace).then((x) => x.records)
    }

    export async function orderedIDs(providerID: string, namespace = "default"): Promise<string[]> {
      return snapshot(providerID, namespace).then((x) => x.orderedIDs)
    }

    export async function allOnCooldown(providerID: string, namespace = "default"): Promise<boolean> {
      const { records } = await snapshot(providerID, namespace)
      if (records.length === 0) return false // No OAuth accounts = not on cooldown (will use API key or fail differently)
      const now = Date.now()
      return records.every((r) => r.health.cooldownUntil && r.health.cooldownUntil > now)
    }

    export async function getRecordIDByLabel(
      providerID: string,
      label: string,
      namespace = "default",
    ): Promise<string | undefined> {
      const { records } = await snapshot(providerID, namespace)
      const record = records.find((r) => r.label === label)
      return record?.id
    }

    export async function moveToBack(providerID: string, namespace: string, recordID: string): Promise<void> {
      const store = await loadStoreFile()
      const provider = store.providers[providerID]
      if (!provider || provider.type !== "oauth") return
      const order = recordIDsForNamespace(provider, namespace)
      provider.order[namespace] = order.filter((x) => x !== recordID).concat(recordID)
      provider.active[namespace] = provider.order[namespace][0] ?? provider.active[namespace]
      await writeStoreFile(store)
    }

    export async function recordOutcome(input: {
      providerID: string
      recordID: string
      statusCode: number
      ok: boolean
      cooldownUntil?: number
    }): Promise<void> {
      const store = await loadStoreFile()
      const provider = store.providers[input.providerID]
      if (!provider || provider.type !== "oauth") return

      const record = findOAuthRecord(provider, input.recordID)
      if (!record) return

      const now = Date.now()
      const prevCooldown =
        record.health.cooldownUntil && record.health.cooldownUntil > now ? record.health.cooldownUntil : undefined
      const cooldownUntil = input.ok ? undefined : (input.cooldownUntil ?? prevCooldown)

      record.health = {
        ...record.health,
        cooldownUntil,
        lastStatusCode: input.statusCode,
        lastErrorAt: input.ok ? undefined : now,
        successCount: record.health.successCount + (input.ok ? 1 : 0),
        failureCount: record.health.failureCount + (input.ok ? 0 : 1),
      }
      record.updatedAt = now
      await writeStoreFile(store)
    }

    export async function markAccessExpired(providerID: string, namespace: string, recordID: string): Promise<void> {
      const existing = await getOAuthSecret({ providerID, namespace, recordID })
      if (!existing) return
      await setOAuthSecret({
        providerID,
        namespace,
        recordID,
        secret: { ...existing, access: "", expires: 0 },
      })
    }
  }
}
