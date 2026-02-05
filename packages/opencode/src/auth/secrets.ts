import path from "path"
import { Global } from "../global"

export type SecretsBackend = {
  get(input: { service: string; name: string }): Promise<string | null>
  set(input: { service: string; name: string; value: string }): Promise<void>
  delete(input: { service: string; name: string }): Promise<boolean>
}

export class FileSecretsBackend implements SecretsBackend {
  readonly #dir: string

  constructor(dir?: string) {
    this.#dir = dir ?? path.join(Global.Path.data, "secrets")
  }

  #path(service: string, name: string): string {
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")
    return path.join(this.#dir, `${safe(service)}_${safe(name)}.json`)
  }

  async get(input: { service: string; name: string }): Promise<string | null> {
    const file = Bun.file(this.#path(input.service, input.name))
    const data = await file.json().catch(() => null)
    return data?.value ?? null
  }

  async set(input: { service: string; name: string; value: string }): Promise<void> {
    const fs = await import("fs/promises")
    await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 })
    const filepath = this.#path(input.service, input.name)
    await Bun.write(filepath, JSON.stringify({ value: input.value }))
    await fs.chmod(filepath, 0o600)
  }

  async delete(input: { service: string; name: string }): Promise<boolean> {
    const fs = await import("fs/promises")
    return fs
      .unlink(this.#path(input.service, input.name))
      .then(() => true)
      .catch(() => false)
  }
}

let backend: SecretsBackend | undefined

export function getSecretsBackend(): SecretsBackend {
  backend ??= new FileSecretsBackend()
  return backend
}

export function setSecretsBackend(next: SecretsBackend): void {
  backend = next
}

export class MemorySecretsBackend implements SecretsBackend {
  readonly #store = new Map<string, string>()

  #key(service: string, name: string): string {
    return `${service}\u0000${name}`
  }

  async get(input: { service: string; name: string }): Promise<string | null> {
    return this.#store.get(this.#key(input.service, input.name)) ?? null
  }

  async set(input: { service: string; name: string; value: string }): Promise<void> {
    this.#store.set(this.#key(input.service, input.name), input.value)
  }

  async delete(input: { service: string; name: string }): Promise<boolean> {
    return this.#store.delete(this.#key(input.service, input.name))
  }
}
