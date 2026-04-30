export * as ConfigACP from "./acp"

import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

const Adapter = Schema.Struct({
  command: Schema.optional(Schema.String).annotate({
    description: "Command used to launch the ACP adapter over stdio",
  }),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Environment variables passed to the ACP adapter process",
  }),
})

export const Info = Schema.StructWithRest(
  Schema.Struct({
    codex: Schema.optional(Adapter),
    "claude-code": Schema.optional(Adapter),
    cursor: Schema.optional(Adapter),
  }),
  [Schema.Record(Schema.String, Adapter)],
)
  .annotate({ identifier: "ACPConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Adapter = Schema.Schema.Type<typeof Adapter>
export type Info = Schema.Schema.Type<typeof Info>
