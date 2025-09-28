const TOKYONIGHT_THEME = {
  primary: {
    dark: "#82aaff",
    light: "#2e7de9",
  },
  secondary: {
    dark: "#c099ff",
    light: "#9854f1",
  },
  accent: {
    dark: "#ff966c",
    light: "#b15c00",
  },
  error: {
    dark: "#ff757f",
    light: "#f52a65",
  },
  warning: {
    dark: "#ff966c",
    light: "#b15c00",
  },
  success: {
    dark: "#c3e88d",
    light: "#587539",
  },
  info: {
    dark: "#82aaff",
    light: "#2e7de9",
  },
  text: {
    dark: "#c8d3f5",
    light: "#3760bf",
  },
  textMuted: {
    dark: "#828bb8",
    light: "#8990a3",
  },
  background: {
    dark: "#1a1b26",
    light: "#e1e2e7",
  },
  backgroundPanel: {
    dark: "#1e2030",
    light: "#d5d6db",
  },
  backgroundElement: {
    dark: "#222436",
    light: "#c8c9ce",
  },
  border: {
    dark: "#737aa2",
    light: "#737a8c",
  },
  borderActive: {
    dark: "#9099b2",
    light: "#5a607d",
  },
  borderSubtle: {
    dark: "#545c7e",
    light: "#9699a8",
  },
  diffAdded: {
    dark: "#4fd6be",
    light: "#1e725c",
  },
  diffRemoved: {
    dark: "#c53b53",
    light: "#c53b53",
  },
  diffContext: {
    dark: "#828bb8",
    light: "#7086b5",
  },
  diffHunkHeader: {
    dark: "#828bb8",
    light: "#7086b5",
  },
  diffHighlightAdded: {
    dark: "#b8db87",
    light: "#4db380",
  },
  diffHighlightRemoved: {
    dark: "#e26a75",
    light: "#f52a65",
  },
  diffAddedBg: {
    dark: "#20303b",
    light: "#d5e5d5",
  },
  diffRemovedBg: {
    dark: "#37222c",
    light: "#f7d8db",
  },
  diffContextBg: {
    dark: "#1e2030",
    light: "#d5d6db",
  },
  diffLineNumber: {
    dark: "#222436",
    light: "#c8c9ce",
  },
  diffAddedLineNumberBg: {
    dark: "#1b2b34",
    light: "#c5d5c5",
  },
  diffRemovedLineNumberBg: {
    dark: "#2d1f26",
    light: "#e7c8cb",
  },
  markdownText: {
    dark: "#c8d3f5",
    light: "#3760bf",
  },
  markdownHeading: {
    dark: "#c099ff",
    light: "#9854f1",
  },
  markdownLink: {
    dark: "#82aaff",
    light: "#2e7de9",
  },
  markdownLinkText: {
    dark: "#86e1fc",
    light: "#007197",
  },
  markdownCode: {
    dark: "#c3e88d",
    light: "#587539",
  },
  markdownBlockQuote: {
    dark: "#ffc777",
    light: "#8c6c3e",
  },
  markdownEmph: {
    dark: "#ffc777",
    light: "#8c6c3e",
  },
  markdownStrong: {
    dark: "#ff966c",
    light: "#b15c00",
  },
  markdownHorizontalRule: {
    dark: "#828bb8",
    light: "#8990a3",
  },
  markdownListItem: {
    dark: "#82aaff",
    light: "#2e7de9",
  },
  markdownListEnumeration: {
    dark: "#86e1fc",
    light: "#007197",
  },
  markdownImage: {
    dark: "#82aaff",
    light: "#2e7de9",
  },
  markdownImageText: {
    dark: "#86e1fc",
    light: "#007197",
  },
  markdownCodeBlock: {
    dark: "#c8d3f5",
    light: "#3760bf",
  },
  syntaxComment: {
    dark: "#828bb8",
    light: "#8990a3",
  },
  syntaxKeyword: {
    dark: "#c099ff",
    light: "#9854f1",
  },
  syntaxFunction: {
    dark: "#82aaff",
    light: "#2e7de9",
  },
  syntaxVariable: {
    dark: "#ff757f",
    light: "#f52a65",
  },
  syntaxString: {
    dark: "#c3e88d",
    light: "#587539",
  },
  syntaxNumber: {
    dark: "#ff966c",
    light: "#b15c00",
  },
  syntaxType: {
    dark: "#ffc777",
    light: "#8c6c3e",
  },
  syntaxOperator: {
    dark: "#86e1fc",
    light: "#007197",
  },
  syntaxPunctuation: {
    dark: "#c8d3f5",
    light: "#3760bf",
  },
} as const

type Theme = {
  primary: string
  secondary: string
  accent: string
  error: string
  warning: string
  success: string
  info: string
  text: string
  textMuted: string
  background: string
  backgroundPanel: string
  backgroundElement: string
  border: string
  borderActive: string
  borderSubtle: string
  diffAdded: string
  diffRemoved: string
  diffContext: string
  diffHunkHeader: string
  diffHighlightAdded: string
  diffHighlightRemoved: string
  diffAddedBg: string
  diffRemovedBg: string
  diffContextBg: string
  diffLineNumber: string
  diffAddedLineNumberBg: string
  diffRemovedLineNumberBg: string
  markdownText: string
  markdownHeading: {}
  markdownLink: string
  markdownLinkText: string
  markdownCode: string
  markdownBlockQuote: string
  markdownEmph: string
  markdownStrong: string
  markdownHorizontalRule: string
  markdownListItem: string
  markdownListEnumeration: {}
  markdownImage: string
  markdownImageText: string
  markdownCodeBlock: string
  syntaxComment: string
  syntaxKeyword: string
  syntaxFunction: string
  syntaxVariable: string
  syntaxString: string
  syntaxNumber: string
  syntaxType: string
  syntaxOperator: string
  syntaxPunctuation: string
}

import { createContext, useContext, createSignal, createEffect, onMount } from "solid-js"
import { Storage } from "@/storage/storage"

export const Theme = Object.entries(TOKYONIGHT_THEME).reduce((acc, [key, value]) => {
  acc[key as keyof Theme] = value.dark
  return acc
}, {} as Theme)

type ThemeMode = "dark" | "light" | "auto"

interface ThemeContextValue {
  mode: () => ThemeMode
  setMode: (mode: ThemeMode) => void
  currentTheme: () => Theme
  isDark: () => boolean
}

const ThemeContext = createContext<ThemeContextValue>()

export function ThemeProvider(props: { children: any }) {
  const [mode, setMode] = createSignal<ThemeMode>("dark")

  // Load saved theme preference
  onMount(async () => {
    try {
      const saved = await Storage.read<ThemeMode>(["theme-mode"]).catch(() => null)
      if (saved && ["dark", "light", "auto"].includes(saved)) {
        setMode(saved)
      }
    } catch {
      // Fallback to default if storage fails
    }
  })

  // Save theme preference when it changes
  createEffect(async () => {
    const currentMode = mode()
    try {
      await Storage.write(["theme-mode"], currentMode)
    } catch {
      // Ignore storage errors
    }
  })

  // For terminal environment, we'll assume dark mode by default
  // since most terminals have dark backgrounds
  const isDark = () => {
    const currentMode = mode()
    if (currentMode === "auto") {
      // In terminal context, default to dark for auto mode
      return true
    }
    return currentMode === "dark"
  }

  const currentTheme = () => {
    const dark = isDark()
    return Object.entries(TOKYONIGHT_THEME).reduce((acc, [key, value]) => {
      acc[key as keyof Theme] = dark ? value.dark : value.light
      return acc
    }, {} as Theme)
  }

  const value: ThemeContextValue = {
    mode,
    setMode,
    currentTheme,
    isDark,
  }

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }
  return context
}
