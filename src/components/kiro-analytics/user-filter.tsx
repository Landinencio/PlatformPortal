"use client";

import { useI18n } from "@/lib/i18n";
import { MultiSelect } from "@/components/ui/multi-select";

interface UserOption { id: string; label: string }

export function KiroUserFilter({
  users,
  selected,
  onChange,
}: {
  users: UserOption[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5 sm:max-w-md">
      <label className="text-xs font-medium text-muted-foreground">{t("kiroAnalytics.filter.user", "Filtrar por usuario")}</label>
      <MultiSelect
        options={users.map((u) => ({ value: u.id, label: u.label }))}
        selected={selected}
        onChange={onChange}
        placeholder={t("kiroAnalytics.filter.allUsers", "Todos los usuarios")}
        searchPlaceholder={t("kiroAnalytics.filter.search", "Buscar usuarios...")}
        emptyMessage={t("kiroAnalytics.filter.noMatch", "Sin coincidencias")}
      />
    </div>
  );
}
