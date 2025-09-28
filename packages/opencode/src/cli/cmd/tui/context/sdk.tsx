import { createContext, useContext, type ParentProps } from "solid-js"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { useRouteData } from "./route"

function init({ clankerID, project }: { clankerID: number; project: string }) {
  console.log("Initializing SDK client with:", { clankerID, project })
  const client = createOpencodeClient({
    baseUrl: "http://localhost:3000",
    // @ts-ignore
    fetch: async (r: Request) => {
      const url = new URL(r.url)
      url.pathname = `/${project}/${clankerID}${url.pathname}`
      console.log("SDK fetch - original url:", r.url, "modified url:", url)
      const modifiedRequest = new Request(url.toString(), r)
      const resp = await fetch(modifiedRequest)
      console.log("response:", resp)
      return resp
    },
  })
  console.log("SDK client created:", client)
  return client
}

type SDKContext = ReturnType<typeof init>

const ctx = createContext<SDKContext | undefined>(undefined)

export function SDKProvider(props: ParentProps) {
  const route = useRouteData()
  console.log("SDKProvider route data:", route)
  const value = init({ clankerID: route.clankerID, project: route.project })
  console.log("SDKProvider initialized with:", { clankerID: route.clankerID, project: route.project })
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useSDK() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useSDK must be used within a SDKProvider")
  }
  return value
}
