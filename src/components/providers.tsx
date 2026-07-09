"use client"

import { Suspense } from "react";
import { SessionProvider } from "next-auth/react"
import { ActivityTracker } from "@/components/admin/activity-tracker";
import { ToastProvider } from "@/components/ui/toast";
import { I18nProvider } from "@/lib/i18n";
import { ReloginOrchestrator } from "@/components/session/relogin-orchestrator";
import { HttpInterceptor } from "@/components/session/http-interceptor";
import { GuardiaSesion } from "@/components/session/guardia-sesion";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <SessionProvider refetchInterval={300} refetchOnWindowFocus>
            <I18nProvider>
                <ToastProvider>
                    {/* Montaje único del endurecimiento de sesión (session-nav-hardening):
                        el ReloginOrchestrator (punto de entrada único al re-login) envuelve
                        al HttpInterceptor y a la GuardiaSesion. Va dentro de I18nProvider y
                        ToastProvider para disponer de `t` y `toast`, y dentro del
                        SessionProvider para `useSession`. El Suspense aísla el
                        `useSearchParams` del orquestador sin envolver a `children`. */}
                    <Suspense fallback={null}>
                        <ReloginOrchestrator>
                            <HttpInterceptor />
                            <GuardiaSesion />
                        </ReloginOrchestrator>
                    </Suspense>
                    {children}
                </ToastProvider>
            </I18nProvider>
            <Suspense fallback={null}>
                <ActivityTracker />
            </Suspense>
        </SessionProvider>
    );
}
