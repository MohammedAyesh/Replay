import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useGetMe, useUpdateLocale, getGetMeQueryKey } from "@workspace/api-client-react";
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

  const prevMeIdRef = useRef<number | undefined>(undefined);

  const { data: me } = useGetMe({
    query: {
      retry: false,
      staleTime: 5 * 60 * 1000,
      queryKey: getGetMeQueryKey(),
    },
  });

  const { mutate: persistLocale } = useUpdateLocale();

  useEffect(() => {
    if (!me) return;

    const isNewIdentity = prevMeIdRef.current !== me.id;
    if (!isNewIdentity) return;
    prevMeIdRef.current = me.id;

    const serverLocale = me.preferredLocale;
    if (serverLocale === "ar" || serverLocale === "en") {
      localStorage.setItem(STORAGE_KEY, serverLocale);
      setLocaleState(serverLocale);
      return;
    }

    if (!me.isGuest) {
      const localLocale = localStorage.getItem(STORAGE_KEY);
      if (localLocale === "ar" || localLocale === "en") {
        persistLocale({ data: { locale: localLocale } });
      }
    }
  }, [me]);

  const setLocale = (l: Locale) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLocaleState(l);

    if (me && !me.isGuest) {
      persistLocale({ data: { locale: l } });
    }
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
