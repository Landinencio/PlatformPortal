"use client";

import { useI18n, LOCALES, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function LanguageSelector({ collapsed = false }: { collapsed?: boolean }) {
  const { locale, setLocale } = useI18n();

  if (collapsed) {
    return (
      <div className="flex items-center justify-center gap-1">
        {LOCALES.map((l) => (
          <button
            key={l.value}
            onClick={() => setLocale(l.value)}
            className={cn(
              "w-7 h-7 rounded-lg text-sm transition-all",
              locale === l.value
                ? "bg-primary/15 ring-1 ring-primary/30 scale-110"
                : "opacity-50 hover:opacity-100 hover:bg-muted/50"
            )}
            title={l.label}
          >
            {l.flag}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1">
      {LOCALES.map((l) => (
        <button
          key={l.value}
          onClick={() => setLocale(l.value)}
          className={cn(
            "flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-all",
            locale === l.value
              ? "bg-primary/12 text-foreground font-medium ring-1 ring-primary/25"
              : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/40"
          )}
        >
          <span>{l.flag}</span>
        </button>
      ))}
    </div>
  );
}
