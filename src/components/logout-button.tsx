"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

export function LogoutButton() {
    return (
        <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut({ callbackUrl: "/" })}
            className="text-slate-500 hover:text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors"
        >
            <LogOut className="w-4 h-4" />
            Sign Out
        </Button>
    );
}
