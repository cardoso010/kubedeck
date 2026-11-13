// UI language. Strings live in src/locales/<language>/, one file per area, merged in each
// language's index.ts; English is the source and every other language is typed against it,
// so a missing or extra key fails `tsc`. Backend errors stay in English: they come from
// Kubernetes, helm and the OS, which have no translations to match.
import { useEffect, useState } from "react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import ptBR from "./locales/pt-BR";
import es from "./locales/es";
import zhCN from "./locales/zh-CN";

export type LanguageId = "en" | "pt-BR" | "es" | "zh-CN";

/** Each language under its own name, so it can be found whatever the current language. */
export const LANGUAGES: { id: LanguageId; label: string }[] = [
  { id: "en", label: "English" },
  { id: "pt-BR", label: "Português (Brasil)" },
  { id: "es", label: "Español" },
  { id: "zh-CN", label: "简体中文" },
];

const KEY = "kubedeck.language";

/** The system language when it is one we have, else English. */
export function systemLanguage(): LanguageId {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const lower = tag.toLowerCase();
    if (lower.startsWith("pt")) return "pt-BR";
    if (lower.startsWith("es")) return "es";
    if (lower.startsWith("zh")) return "zh-CN";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

/** The saved choice, or null to follow the system. */
export function savedLanguage(): LanguageId | null {
  try {
    const value = localStorage.getItem(KEY);
    return LANGUAGES.some((l) => l.id === value) ? (value as LanguageId) : null;
  } catch {
    return null;
  }
}

const current = (): LanguageId => savedLanguage() ?? systemLanguage();

void i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, "pt-BR": { translation: ptBR }, es: { translation: es }, "zh-CN": { translation: zhCN } },
  lng: current(),
  fallbackLng: "en",
  // React already escapes what it renders.
  interpolation: { escapeValue: false },
  returnNull: false,
});
document.documentElement.lang = i18next.language;
i18next.on("languageChanged", (lng) => (document.documentElement.lang = lng));

/** The language choice; null follows the system. `setLanguage` applies it to every open window. */
export function useLanguage() {
  const [choice, setChoice] = useState<LanguageId | null>(savedLanguage);

  // Another window changed the language.
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      setChoice(savedLanguage());
      void i18next.changeLanguage(current());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const setLanguage = (next: LanguageId | null) => {
    setChoice(next);
    try {
      if (next) localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch {
      // Storage unavailable: the choice lasts for this window only.
    }
    void i18next.changeLanguage(next ?? systemLanguage());
  };

  return { language: choice, setLanguage };
}

export default i18next;
