import { useState } from "react"
import { language, t } from "../i18n.js"
import { setThemePreference, themePreference, type ThemePreference } from "../theme.js"
import { Icon } from "./Icon.js"

export function AppearanceSettings() {
  const [theme, setTheme] = useState(themePreference)
  const names = { en: "English", pt: "Português", es: "Español", zh: "中文", fr: "Français", hi: "हिन्दी" }
  return <section className="card mb control-surface">
    <strong>{t("Appearance")}</strong>
    <div className="control-form mt">
      <fieldset className="theme-selector">
        <legend>{t("Theme")}</legend>
        <div className="theme-options">{([["system", "System"], ["light", "Light"], ["dark", "Dark"]] as const).map(([value, label]) => <label className={`theme-choice ${theme === value ? "theme-choice--selected" : ""}`} key={value}>
          <input className="sr-only" type="radio" name="app-theme" value={value} checked={theme === value} onChange={() => { setTheme(value); setThemePreference(value as ThemePreference) }} />
          <span className={`theme-preview theme-preview--${value}`} aria-hidden="true"><span className="theme-preview__bar" /><span className="theme-preview__card"><span /><span /></span></span>
          <span className="theme-choice__label"><span>{t(label)}</span><span className="theme-choice__check" aria-hidden="true">{theme === value && <Icon name="check" />}</span></span>
        </label>)}</div>
      </fieldset>
      <p className="tiny muted">{t("Language")}: {names[language]} · {t("Automatic")}</p>
    </div>
  </section>
}
