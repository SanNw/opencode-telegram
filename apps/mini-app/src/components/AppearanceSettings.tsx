import { useState } from "react"
import { language, t } from "../i18n.js"
import { setThemePreference, themePreference, type ThemePreference } from "../theme.js"

export function AppearanceSettings() {
  const [theme, setTheme] = useState(themePreference)
  const names = { en: "English", pt: "Português", es: "Español", zh: "中文", fr: "Français", hi: "हिन्दी" }
  return <section className="card mb control-surface">
    <strong>{t("Appearance")}</strong>
    <div className="control-form mt">
      <label htmlFor="app-theme">{t("Theme")}</label>
      <select id="app-theme" className="input" value={theme} onChange={(event) => {
        const value = event.target.value as ThemePreference
        setTheme(value); setThemePreference(value)
      }}><option value="system">{t("System")}</option><option value="light">{t("Light")}</option><option value="dark">{t("Dark")}</option></select>
      <p className="tiny muted">{t("Language")}: {names[language]} · {t("Automatic")}</p>
    </div>
  </section>
}
