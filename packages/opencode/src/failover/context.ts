import { AsyncLocalStorage } from "node:async_hooks"

type Store = {
  providerID: string
  modelID: string
}

const storage = new AsyncLocalStorage<Store>()

export function getActiveFailoverProvider(): Store | undefined {
  return storage.getStore()
}

export async function withFailoverProvider<T>(providerID: string, modelID: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ providerID, modelID }, fn)
}
