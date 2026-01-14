"use client";

import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function LoginButton() {
    return (
        <Button
            size="lg"
            onClick={() => signIn("azure-ad", { callbackUrl: "/" })}
            className="px-8 py-6 text-lg shadow-lg hover:scale-105 transition-transform duration-200 bg-primary text-white hover:bg-orange-700"
        >
            Enter with SSO
        </Button>
    );
}
