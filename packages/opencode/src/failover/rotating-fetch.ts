import { FailoverPool } from "./pool"
import { withFailoverProvider } from "./context"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000

function parseRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after") ?? response.headers.get("Retry-After")
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000
  const dateMs = Date.parse(value)
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
  return undefined
}

async function drainResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {}
}

export type FailoverChainEntry = {
  provider: string
  model: string
  account?: string // OAuth account label to pin to (omit for auto-rotation)
}

export type FailoverFetchFactory = (
  providerID: string,
  modelID: string,
) => Promise<(input: any, init?: any) => Promise<Response>>

export function createFailoverRotatingFetch(
  chain: FailoverChainEntry[],
  getFetch: FailoverFetchFactory,
  opts?: { maxAttempts?: number },
): (input: any, init?: any) => Promise<Response> {
  const maxAttempts = Math.min(opts?.maxAttempts ?? chain.length, chain.length)

  return async (input: any, init?: any) => {
    let lastError: unknown
    let lastResponse: Response | undefined

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const entry = chain[attempt]

      if (!(await FailoverPool.isAvailable(entry.provider, entry.model))) {
        continue
      }

      if (attempt > 0 && lastResponse?.status === 429) {
        const prevEntry = chain[attempt - 1]
        Bus.publish(TuiEvent.ToastShow, {
          message: `Switched from ${prevEntry.provider} to ${entry.provider}`,
          variant: "info",
          duration: 3000,
        })
      }

      try {
        const fetchFn = await getFetch(entry.provider, entry.model)
        const response = await withFailoverProvider(entry.provider, entry.model, () => fetchFn(input, init))

        if (response.ok) {
          await FailoverPool.recordOutcome({
            providerID: entry.provider,
            modelID: entry.model,
            statusCode: response.status,
            ok: true,
          })
          return response
        }

        lastResponse = response

        if (response.status === 429) {
          const cooldownMs = parseRetryAfterMs(response) ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS
          await FailoverPool.recordOutcome({
            providerID: entry.provider,
            modelID: entry.model,
            statusCode: response.status,
            ok: false,
            cooldownUntil: Date.now() + cooldownMs,
          })
          await drainResponse(response)
          continue
        }

        await FailoverPool.recordOutcome({
          providerID: entry.provider,
          modelID: entry.model,
          statusCode: response.status,
          ok: false,
        })
        return response
      } catch (e) {
        lastError = e
        await FailoverPool.recordOutcome({
          providerID: entry.provider,
          modelID: entry.model,
          statusCode: 0,
          ok: false,
        })
      }
    }

    if (lastError) throw lastError
    if (lastResponse) return lastResponse
    throw new Error("All providers in failover chain exhausted or on cooldown")
  }
}
