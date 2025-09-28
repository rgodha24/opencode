import { createContext, useContext, type ParentProps } from "solid-js"

type Route =
  | {
      type: "home"
    }
  | {
      type: "session"
      sessionID: string
    }

function init(sessionId: string) {
  return {
    get data() {
      return {
        type: "session",
        sessionID: sessionId,
      }
    },
    navigate(route: Route) {
      console.log("navigate doesnt work bc of stuff", route)
    },
  }
}

export type RouteContext = ReturnType<typeof init>

const ctx = createContext<RouteContext>()

export function RouteProvider(props: ParentProps<{ sessionId: string }>) {
  const value = init(props.sessionId)
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

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
