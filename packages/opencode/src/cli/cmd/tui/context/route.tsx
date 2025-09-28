import { createContext, useContext, type ParentProps } from "solid-js"

type Route =
  | {
      type: "home"
    }
  | {
      type: "session"
      sessionID: string
    }

function init(sessionId: () => string, clankerID: number, project: string) {
  return {
    data() {
      return {
        type: "session" as const,
        sessionID: sessionId(),
        clankerID,
        project,
      }
    },
    navigate(route: Route) {
      console.log("navigate doesnt work bc of stuff", route)
    },
  }
}

export type RouteContext = ReturnType<typeof init>

const ctx = createContext<RouteContext | undefined>(undefined)

export function RouteProvider(props: ParentProps<{ sessionId: () => string; clankerID: number; project: string }>) {
  console.log("RouteProvider props:", {
    sessionId: props.sessionId(),
    clankerID: props.clankerID,
    project: props.project,
  })
  const value = init(props.sessionId, props.clankerID, props.project)
  console.log("RouteProvider initialized with data:", value.data())
  // @ts-ignore
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useRoute() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useRoute must be used within a RouteProvider")
  }
  return value
}

export function useRouteData() {
  const route = useRoute()
  return route.data()
}
