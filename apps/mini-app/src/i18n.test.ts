import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { detectLanguage, language, t, tf, stateLabel, translationCatalog, type Language } from "./i18n.js"
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
test("every application catalog entry covers all five translated languages and preserves placeholders", () => {
  const placeholders = (value: string) => [...value.matchAll(/\{\w+\}/g)].map(([key]) => key).sort()
  for (const [key, values] of Object.entries(translationCatalog)) {
    assert.equal(values.length, 5, key)
    for (const value of values) {
      assert.ok(value.trim(), key)
      assert.deepEqual(placeholders(value), placeholders(key), key)
    }
  }
})
test("interpolation preserves literal user content and translates known display states only", () => {
  for (const locale of ["pt", "es", "zh", "fr", "hi"] as Language[]) {
    const name = "private {name} $& <script>"
    assert.ok(tf("Delete {name}?", { name }, locale).includes(name))
    assert.notEqual(stateLabel("completed", locale), "completed")
    assert.equal(stateLabel("custom-agent-name", locale), "custom-agent-name")
    assert.equal(t("private model output", locale), "private model output")
  }
  assert.equal(tf("Delete {name}?", { name: "Session" }, "en"), "Delete Session?")
})
test("literal translation calls in production source cannot silently fall back to English", () => {
  const scan = (directory: URL) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory)
      if (entry.isDirectory()) scan(path)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test") && entry.name !== "i18n.ts") {
        for (const match of readFileSync(path, "utf8").matchAll(/\b(?:t|tf)\("((?:[^"\\]|\\.)*)"/g)) {
          const key = JSON.parse(`"${match[1]}"`) as string
          assert.ok(Object.hasOwn(translationCatalog, key), `${entry.name}: ${key}`)
        }
      }
    }
  }
  scan(new URL("../src/", import.meta.url))
})
