import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import "./styles.css"
import { initializeLocale } from "./i18n.js"
import { initializeTheme } from "./theme.js"

initializeLocale()
const cleanupTheme = initializeTheme()
if (import.meta.hot) import.meta.hot.dispose(cleanupTheme)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

