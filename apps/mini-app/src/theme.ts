export type Theme = "light" | "dark"
export type ThemePreference = Theme | "system"
export function themePreference(): ThemePreference {
  try { const value = localStorage.getItem("opencode-telegram-theme"); return value === "light" || value === "dark" ? value : "system" } catch { return "system" }
}
export function setThemePreference(value: ThemePreference): void {
  try { localStorage.setItem("opencode-telegram-theme", value) } catch { /* Preference still applies in this session. */ }
  applyTheme(value)
}
function applyTheme(preference = themePreference()): void {
  const theme: Theme = preference === "system" ? matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark" : preference
  document.documentElement.dataset.theme = theme
  const app = window.Telegram?.WebApp
  app?.setHeaderColor?.(theme === "light" ? "#f3f6fb" : "#0b1020")
  app?.setBackgroundColor?.(theme === "light" ? "#f3f6fb" : "#0b1020")
}
export function initializeTheme(): () => void {
  const media = matchMedia("(prefers-color-scheme: light)")
  const apply = () => applyTheme()
  apply()
  media.addEventListener("change", apply)
  return () => media.removeEventListener("change", apply)
}
