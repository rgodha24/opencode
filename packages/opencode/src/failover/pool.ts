import path from "path"
import { Global } from "../global"
import z from "zod"

export namespace FailoverPool {
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

  export type Health = z.infer<typeof Health>

  const StoreFile = z
    .object({
      version: z.literal(1),
      providers: z.record(z.string(), Health).default({}),
    })
    .strict()

  type StoreFile = z.infer<typeof StoreFile>

  const filepath = path.join(Global.Path.data, "failover.json")

  async function load(): Promise<StoreFile> {
    const file = Bun.file(filepath)
    const raw = await file.json().catch(() => undefined)
    const parsed = StoreFile.safeParse(raw)
    return parsed.success ? parsed.data : { version: 1, providers: {} }
  }

  async function save(store: StoreFile): Promise<void> {
    await Bun.write(filepath, JSON.stringify(store, null, 2))
  }

  function key(providerID: string, modelID: string): string {
    return `${providerID}/${modelID}`
  }

  export async function getHealth(providerID: string, modelID: string): Promise<Health> {
    const store = await load()
    return store.providers[key(providerID, modelID)] ?? { successCount: 0, failureCount: 0 }
  }

  export async function isAvailable(providerID: string, modelID: string): Promise<boolean> {
    const health = await getHealth(providerID, modelID)
    if (!health.cooldownUntil) return true
    return health.cooldownUntil <= Date.now()
  }

  export async function recordOutcome(input: {
    providerID: string
    modelID: string
    statusCode: number
    ok: boolean
    cooldownUntil?: number
  }): Promise<void> {
    const store = await load()
    const k = key(input.providerID, input.modelID)
    const existing = store.providers[k] ?? { successCount: 0, failureCount: 0 }
    const now = Date.now()

    const prevCooldown = existing.cooldownUntil && existing.cooldownUntil > now ? existing.cooldownUntil : undefined
    const cooldownUntil = input.ok ? undefined : (input.cooldownUntil ?? prevCooldown)

    store.providers[k] = {
      cooldownUntil,
      lastStatusCode: input.statusCode,
      lastErrorAt: input.ok ? undefined : now,
      successCount: existing.successCount + (input.ok ? 1 : 0),
      failureCount: existing.failureCount + (input.ok ? 0 : 1),
    }

    await save(store)
  }
}
