import { NextAuthOptions } from "next-auth"
import AzureADProvider from "next-auth/providers/azure-ad"

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
        async session({ session, token }) {
            // Pass the user ID or other claims to the session
            return session
        },
    },
}
