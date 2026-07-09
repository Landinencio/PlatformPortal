"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function LogoutButton() {
    const { t } = useI18n();
    return (
        <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut({ callbackUrl: "/" })}
            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 flex items-center gap-2 transition-colors"
        >
            <LogOut className="w-4 h-4" />
            {t("app.logout")}
        </Button>
    );
}
