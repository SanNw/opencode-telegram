import test from "node:test"
import assert from "node:assert/strict"
import { detectLanguage, language, t, type Language } from "./i18n.js"
test("server rendering does not inherit Node navigator's host locale", () => {
  assert.equal(typeof window, "undefined")
  assert.equal(language, "en")
})
test("system language matching covers all six languages and regional tags", () => {
  for (const [input, expected] of [["en-US", "en"], ["pt-BR", "pt"], ["es-MX", "es"], ["zh-Hant-TW", "zh"], ["fr-CA", "fr"], ["hi-IN", "hi"]]) assert.equal(detectLanguage([input!]), expected)
  assert.equal(detectLanguage(["de-DE", "pt-PT"]), "pt")
  assert.equal(detectLanguage(["de-DE"]), "en")
})
test("navigation, search and theme labels have translations; unknown content stays intact", () => {
  for (const locale of ["pt", "es", "zh", "fr", "hi"] as Language[]) {
    for (const label of ["Home", "Projects", "Settings", "Search models", "Light", "Dark", "Recovery Key"]) assert.notEqual(t(label, locale), label)
    assert.equal(t("private user content", locale), "private user content")
  }
  assert.equal(t("Home", "en"), "Home")
})
