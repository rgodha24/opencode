import { RGBA } from "@opentui/core"
import { useRenderer, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, createEffect, For, createMemo } from "solid-js"
import path from "path"
import { $ } from "bun"

import { OpencodeSession } from "./session"
import { useTheme } from "./context/theme"
import { Instance } from "@/project/instance"

export type Clanker = {
  id: number
  title: string
  status: "running" | "waiting" | "merged"
  contextusage: number
  cost: number
  pr_number?: number
  sessionID: string
}

export type ClankerHistoryEntry = {
  timestamp: number
  status: "running" | "waiting" | "merged"
}

const getStatusColors = (theme: any) => ({
  merged: RGBA.fromHex(theme.success),
  waiting: RGBA.fromHex(theme.warning),
  running: RGBA.fromHex(theme.primary),
})
const CLANKER_WIDTH = 40 - 2

// Initialize project with upstream before TUI starts
async function initializeProject() {
  const projectName = path.basename(Instance.project.worktree)

  try {
    // Get git remote origin URL
    const upstream = await $`git remote get-url origin`
      .cwd(Instance.project.worktree)
      .quiet()
      .nothrow()
      .text()
      .then((text) => text.trim())

    if (upstream) {
      // Create/open project via API call
      await fetch("http://localhost:3000/projects/" + projectName + "/open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ upstream }),
      })
    }
  } catch (error) {
    console.error("Failed to initialize project:", error)
  }
}

export const ClankerApp = () => {
  const renderer = useRenderer()
  const theme = useTheme()
  const [projectName] = createSignal(path.basename(Instance.project.worktree))
  const [clankers, setClankers] = createSignal<Clanker[]>([]) // Start with empty array - no clankers
  const [selectedClankerId, setSelectedClankerId] = createSignal<number>()

  // Initialize project on component mount
  createEffect(() => {
    initializeProject()
  })

  const selectedClankerIndex = createMemo(() => {
    const id = selectedClankerId()
    return id !== undefined ? clankers().findIndex((clanker) => clanker.id === id) : -1
  })

  useKeyboard((key) => {
    if (key.name === "d" && key.ctrl) {
      renderer.console.toggle()
    }
    if (key.name === "o" && key.ctrl) {
      renderer.toggleDebugOverlay()
    }
    if (key.name === "j" && (key.option || key.meta)) {
      console.log(selectedClankerIndex(), "option+j")
      const index = selectedClankerIndex()
      if (index !== -1) {
        if (index < clankers().length - 1) setSelectedClankerId(clankers()[index + 1]!.id)
      } else {
        setSelectedClankerId(clankers()[0]?.id)
      }
    }
    if (key.name === "k" && (key.option || key.meta)) {
      console.log(selectedClankerIndex(), "option+k")
      const index = selectedClankerIndex()
      if (index !== -1) {
        if (index > 0) setSelectedClankerId(clankers()[index - 1]!.id)
      } else {
        setSelectedClankerId(clankers()[clankers().length - 1]?.id)
      }
    }
  })

  return (
    <box
      style={{
        height: "100%",
        width: "100%",
        flexDirection: "column",
        backgroundColor: RGBA.fromHex(theme.currentTheme().backgroundElement),
      }}
      paddingLeft={1}
    >
      <box height={8} paddingTop={1} paddingRight={1} flexDirection="row" gap={2}>
        <ascii_font
          text={selectedClankerId() ? `CLANKER ${selectedClankerId()}` : "CLANKERS"}
          style={{ font: "block", fg: RGBA.fromHex(theme.currentTheme().text) }}
        />
        <ascii_font text="/" style={{ font: "block", fg: RGBA.fromHex(theme.currentTheme().textMuted) }} />
        <ascii_font
          text="/"
          style={{ font: "block", fg: RGBA.fromHex(theme.currentTheme().textMuted) }}
          marginLeft={-3}
        />
        <ascii_font text={projectName()} style={{ font: "block", fg: RGBA.fromHex(theme.currentTheme().primary) }} />
      </box>
      <box height="100%" flexDirection="row">
        <box width={CLANKER_WIDTH + 2} flexDirection="column">
          <For each={clankers()}>
            {(clanker) => (
              <Clanker
                clanker={clanker}
                selectedClankerId={selectedClankerId()}
                setSelectedClankerId={setSelectedClankerId}
              />
            )}
          </For>
          <box flexGrow={1} width="100%" onMouseDown={() => setSelectedClankerId(undefined)} />
          <box
            height={3}
            flexDirection="column"
            borderStyle="single"
            borderColor={RGBA.fromHex(theme.currentTheme().borderSubtle)}
            border
            paddingLeft={1}
          >
            <text content="main" style={{ fg: RGBA.fromHex(theme.currentTheme().success) }} />
          </box>
        </box>
        <box flexDirection="column" flexGrow={1}>
          <box
            flexGrow={1}
            borderStyle="single"
            borderColor={RGBA.fromHex(theme.currentTheme().borderSubtle)}
            border
            paddingLeft={0}
          >
            <Chat selectedClankerId={selectedClankerId} clankers={clankers()} project={projectName()} />
          </box>
          <ClankersStatusWrapper clankers={clankers()} />
        </box>
      </box>
    </box>
  )
}

function Clanker(props: {
  clanker: Clanker
  selectedClankerId: number | undefined
  setSelectedClankerId: (id: number | undefined) => void
}) {
  const theme = useTheme()
  const statusColors = getStatusColors(theme.currentTheme())
  const isSelected = () => props.selectedClankerId === props.clanker.id

  return (
    <box
      flexDirection="column"
      onMouseDown={() => props.setSelectedClankerId(props.clanker.id)}
      height={5}
      style={{
        backgroundColor: isSelected() ? RGBA.fromHex(theme.currentTheme().backgroundPanel) : "transparent",
        padding: 1,
      }}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text
          content={"clanker " + props.clanker.id.toString()}
          style={{ fg: RGBA.fromHex(theme.currentTheme().textMuted) }}
        />
        <text content={props.clanker.status} style={{ fg: statusColors[props.clanker.status] }} />
      </box>
      <box flexDirection="row" justifyContent="space-between" height={1} maxHeight={1}>
        <text
          content={props.clanker.title.slice(0, CLANKER_WIDTH - 2)}
          height={1}
          maxHeight={1}
          style={{ fg: RGBA.fromHex(theme.currentTheme().text) }}
        />
      </box>
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text
          content={"$" + props.clanker.cost.toFixed(2)}
          style={{ fg: RGBA.fromHex(theme.currentTheme().textMuted) }}
        />
        <text
          content={props.clanker.contextusage.toFixed(2) + "%"}
          style={{ fg: RGBA.fromHex(theme.currentTheme().textMuted) }}
        />
      </box>
    </box>
  )
}

function Chat(props: { selectedClankerId: () => number | undefined; clankers: Clanker[]; project: string }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()

  const sessionID = () => {
    const id = props.selectedClankerId()
    return id !== undefined ? props.clankers.find((x) => x.id === id)?.sessionID : undefined
  }

  return (
    <box flexDirection="column" height="100%">
      <box
        flexGrow={1}
        style={{
          backgroundColor: RGBA.fromHex(theme.currentTheme().backgroundPanel),
          padding: 0,
          marginBottom: 0,
        }}
      >
        {(() => {
          const currentSessionID = sessionID()
          return props.selectedClankerId() && currentSessionID ? (
            <OpencodeSession
              sessionID={() => currentSessionID}
              width={() => dimensions().width - (CLANKER_WIDTH + 2) - 2 - 2} // terminal width - left panel - border - padding
              height={() => dimensions().height - 8 - 1 - 1} // terminal height - header - margins
              clankerID={props.selectedClankerId()!}
              project={props.project}
            />
          ) : null
        })()}
      </box>
    </box>
  )
}

function ClankersStatusWrapper(props: { clankers: Clanker[] }) {
  const activeClankers = () => props.clankers.filter((c) => c.status === "running" || c.status === "waiting")

  if (activeClankers().length === 0) {
    return null
  }

  return <ClankersStatus clankers={props.clankers} />
}

function ClankersStatus(props: { clankers: Clanker[] }) {
  const theme = useTheme()
  const statusColors = getStatusColors(theme.currentTheme())
  const [history, setHistory] = createSignal<Record<number, string[]>>({})
  const dimensions = useTerminalDimensions()

  const activeClankers = () => props.clankers.filter((c) => c.status === "running" || c.status === "waiting")
  const boxHeight = () => activeClankers().length

  // Terminal width (195) - left panel (40) - dot (1) - ID (4) - colon+space (2) - off by 3 fix
  const historyWidth = () => dimensions().width - (CLANKER_WIDTH + 2) - 1 - 4 - 2 - 3

  // Update history every second
  createEffect(() => {
    const interval = setInterval(() => {
      setHistory((prev) => {
        const updated = { ...prev }

        activeClankers().forEach((clanker) => {
          if (!updated[clanker.id]) updated[clanker.id] = Array.from({ length: 240 }, () => " ")

          // max 240 seconds. we dont rly care about inneficiency of the popping off the front of the array here bc its one every second anyways and computers are fast
          updated[clanker.id]!.push(clanker?.status === "running" ? "█" : " ")
          updated[clanker.id] = updated[clanker.id]!.slice(-240)
        })
        return updated
      })
    }, 1000)

    return () => clearInterval(interval)
  })

  if (activeClankers().length === 0) {
    return null
  }

  return (
    <box flexDirection="column" height={boxHeight()} paddingLeft={1}>
      <For each={activeClankers()}>
        {(clanker) => (
          <box flexDirection="row">
            <text content="●" style={{ fg: statusColors[clanker.status] }} paddingRight={1} />
            <text content={`${clanker.id}:`} style={{ fg: statusColors[clanker.status] }} width={6} />
            <ClankerHistory
              history={history()[clanker.id] || Array.from({ length: 240 }, () => " ")}
              width={historyWidth()}
            />
          </box>
        )}
      </For>
    </box>
  )
}

function ClankerHistory(props: { history: string[]; width: number }) {
  const theme = useTheme()
  const maxHistorySeconds = () => Math.max(1, props.width)

  return (
    <text
      content={props.history.join("").slice(-maxHistorySeconds())}
      style={{
        bg: RGBA.fromHex(theme.currentTheme().borderSubtle),
        fg: RGBA.fromHex(theme.currentTheme().primary),
      }}
    />
  )
}
