import { cmd } from "@/cli/cmd/cmd"
import { render } from "@opentui/solid"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { ClankerApp } from "./clanker"

export const TuiCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    yargs
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("prompt", {
        alias: ["p"],
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("port", {
        type: "number",
        describe: "port to listen on",
        default: 0,
      })
      .option("hostname", {
        alias: ["h"],
        type: "string",
        describe: "hostname to listen on",
        default: "127.0.0.1",
      }),
  handler: async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: () => Config.get(),
    })
    await render(() => <ClankerApp />, {
      useKittyKeyboard: true,
    })
  },
})
