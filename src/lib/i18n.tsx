"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Locale = "es" | "en" | "fr" | "pt";

export const LOCALES: { value: Locale; label: string; flag: string }[] = [
  { value: "es", label: "Español", flag: "🇪🇸" },
  { value: "en", label: "English", flag: "🇬🇧" },
  { value: "fr", label: "Français", flag: "🇫🇷" },
  { value: "pt", label: "Português", flag: "🇵🇹" },
];

const DEFAULT_LOCALE: Locale = "es";

type Translations = Record<string, string>;
type AllTranslations = Record<Locale, Translations>;

// Lazy-loaded translation files
const translationModules: Record<Locale, () => Promise<{ default: Translations }>> = {
  es: () => import("@/i18n/es.json"),
  en: () => import("@/i18n/en.json"),
  fr: () => import("@/i18n/fr.json"),
  pt: () => import("@/i18n/pt.json"),
};

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, fallback?: string) => string;
  ready: boolean;
};

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key, fallback) => fallback || key,
  ready: false,
});

export function useI18n() {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [translations, setTranslations] = useState<Translations>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("locale") as Locale | null;
    if (stored && LOCALES.some((l) => l.value === stored)) {
      setLocaleState(stored);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    translationModules[locale]()
      .then((mod) => {
        if (!cancelled) {
          setTranslations(mod.default || mod);
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => { cancelled = true; };
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    localStorage.setItem("locale", next);
  }, []);

  const t = useCallback(
    (key: string, fallback?: string): string => {
      return translations[key] || fallback || key;
    },
    [translations]
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t, ready }}>
      {children}
    </I18nContext.Provider>
  );
}
