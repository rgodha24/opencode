import { useKeyboard, useRenderer } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { RouteProvider, useRoute } from "@tui/context/route"
import { createEffect } from "solid-js"
import { ThemeProvider, useTheme } from "@tui/context/theme"
import { Installation } from "@/installation"
import { Global } from "@/global"
import { DialogProvider, useDialog } from "@tui/ui/dialog"
import { SDKProvider } from "@tui/context/sdk"
import { SyncProvider } from "@tui/context/sync"
import { LocalProvider, useLocal } from "@tui/context/local"
import { DialogModel } from "@tui/component/dialog-model"
import { CommandProvider, useCommandDialog } from "@tui/component/dialog-command"
import { DialogAgent } from "@tui/component/dialog-agent"
import { KeybindProvider, useKeybind } from "@tui/context/keybind"
import { Session } from "@tui/routes/session"

export const OpencodeSession = ({
  sessionID,
  width,
  height,
}: {
  sessionID: () => string
  width: () => number
  height: () => number
}) => {
  return (
    <RouteProvider sessionId={sessionID}>
      <ThemeProvider>
        <SDKProvider>
          <SyncProvider>
            <LocalProvider>
              <KeybindProvider>
                <DialogProvider>
                  <CommandProvider>
                    <App width={width} height={height} />
                  </CommandProvider>
                </DialogProvider>
              </KeybindProvider>
            </LocalProvider>
          </SyncProvider>
        </SDKProvider>
      </ThemeProvider>
    </RouteProvider>
  )
}

function App({ width, height }: { width: () => number; height: () => number }) {
  const route = useRoute()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const command = useCommandDialog()
  const keybind = useKeybind()

  useKeyboard(async (evt) => {
    if (keybind.match("agent_cycle", evt)) {
      local.agent.move(1)
      return
    }
    if (keybind.match("agent_cycle_reverse", evt)) {
      local.agent.move(-1)
    }

    if (evt.meta && evt.name === "t") {
      renderer.toggleDebugOverlay()
      return
    }

    if (evt.meta && evt.name === "d") {
      renderer.console.toggle()
      return
    }
  })

  createEffect(() => {
    console.log(JSON.stringify(route.data))
  })

  command.register(() => [
    {
      title: "Switch model",
      value: "model.list",
      keybind: "model_list",
      category: "Agent",
      onSelect: () => {
        dialog.replace(() => <DialogModel />)
      },
    },
    {
      title: "Switch agent",
      value: "agent.list",
      keybind: "agent_list",
      category: "Agent",
      onSelect: () => {
        dialog.replace(() => <DialogAgent />)
      },
    },
  ])

  const { currentTheme } = useTheme()

  return (
    <box width={width()} height={height()} backgroundColor={currentTheme().background}>
      <box flexDirection="column" flexGrow={1}>
        <Session />
      </box>
      <box
        height={1}
        backgroundColor={currentTheme().backgroundPanel}
        flexDirection="row"
        justifyContent="space-between"
        flexShrink={0}
      >
        <box flexDirection="row">
          <box flexDirection="row" backgroundColor={currentTheme().backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={currentTheme().textMuted}>open</text>
            <text attributes={TextAttributes.BOLD}>code </text>
            <text fg={currentTheme().textMuted}>v{Installation.VERSION}</text>
          </box>
          <box paddingLeft={1} paddingRight={1}>
            <text fg={currentTheme().textMuted}>{process.cwd().replace(Global.Path.home, "~")}</text>
          </box>
        </box>
        <box flexDirection="row" flexShrink={0}>
          <text fg={currentTheme().textMuted} paddingRight={1}>
            tab
          </text>
          <text fg={local.agent.color(local.agent.current().name)}>┃</text>
          <text bg={local.agent.color(local.agent.current().name)} fg={currentTheme().background} wrap={false}>
            <span style={{ bold: true }}>{local.agent.current().name.toUpperCase()}</span>
            <span> AGENT </span>
          </text>
        </box>
      </box>
    </box>
  )
}
