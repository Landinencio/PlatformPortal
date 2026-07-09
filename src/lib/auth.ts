import { NextAuthOptions } from "next-auth"
import AzureADProvider from "next-auth/providers/azure-ad"
import { normalizeAzureRoles, resolveAppRole, roleFromTokenData } from "@/lib/rbac";
import { trackUserActivity } from "@/lib/user-activity";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

export const authOptions: NextAuthOptions = {
    providers: [
        AzureADProvider({
            clientId: process.env.AZURE_AD_CLIENT_ID || "",
            clientSecret: process.env.AZURE_AD_CLIENT_SECRET || "",
            tenantId: process.env.AZURE_AD_TENANT_ID || "",
        }),
    ],
    // Session expires after 30 minutes (1800 seconds)
    session: {
        strategy: "jwt",
        maxAge: 30 * 60, // 30 minutes
    },
    jwt: {
        maxAge: 30 * 60, // 30 minutes
    },
    callbacks: {
        async jwt({ token, account, profile }) {
            const existingRoles = normalizeAzureRoles(token.roles);
            const profileRoles =
                isRecord(profile) ? normalizeAzureRoles(profile.roles) : [];
            const roles = [...new Set([...existingRoles, ...profileRoles])];

            token.roles = roles;
            token.appRole = resolveAppRole(roles);

            if (isRecord(profile) && typeof profile.oid === "string") {
                token.oid = profile.oid;
            }

            if (account && profile) {
                const profileRecord = isRecord(profile) ? profile : {};
                const loginEmail =
                    (typeof profileRecord.email === "string" && profileRecord.email) ||
                    (typeof profileRecord.preferred_username === "string" && profileRecord.preferred_username) ||
                    token.email ||
                    "unknown@unknown.local";
                const loginName =
                    (typeof profileRecord.name === "string" && profileRecord.name) ||
                    token.name ||
                    loginEmail.split("@")[0];
                const authSub =
                    (typeof profileRecord.sub === "string" && profileRecord.sub) ||
                    token.sub ||
                    null;

                console.log("[auth] Azure login", {
                    email: loginEmail,
                    appRole: token.appRole,
                    roles,
                });

                try {
                    await trackUserActivity({
                        eventType: "login",
                        userEmail: loginEmail,
                        userName: loginName,
                        userRole: token.appRole,
                        authSub,
                        metadata: {
                            provider: account.provider,
                            providerAccountId: account.providerAccountId,
                            roles,
                        },
                    });
                } catch (error) {
                    console.error("Failed to store login activity:", error);
                }
            }

            return token
        },
        async session({ session, token }) {
            const appRole = roleFromTokenData({
                appRole: token.appRole,
                roles: token.roles,
            });

            session.user.roles = normalizeAzureRoles(token.roles);
            session.user.appRole = appRole;
            if (typeof token.oid === "string") {
                session.user.oid = token.oid;
            }

            return session
        },
    },
}
