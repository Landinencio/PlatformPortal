"use client";

import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export function LoginButton() {
    const { t } = useI18n();
    return (
        <Button
            size="lg"
            onClick={() => signIn("azure-ad", { callbackUrl: "/" })}
            className="px-8 py-6 text-lg shadow-lg hover:scale-105 transition-transform duration-200 bg-primary text-primary-foreground hover:bg-primary/90"
        >
            {t("app.login.button")}
        </Button>
    );
}
