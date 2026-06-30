import { createContext, useContext, useEffect, useState } from "react";
import type { Locale, Strings } from "./strings";
import { strings } from "./strings";

const STORAGE_KEY = "soccerwatch_locale";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: "en",
  setLocale: () => {},
});

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "ar" ? "ar" : "en";
  });

  const setLocale = (l: Locale) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLocaleState(l);
  };

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  }, [locale]);

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

export function useTranslation(): { t: Strings; locale: Locale; setLocale: (l: Locale) => void } {
  const { locale, setLocale } = useLocale();
  return { t: strings[locale] as Strings, locale, setLocale };
}
