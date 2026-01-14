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
    /* 
    pages: {
        signIn: "/auth/signin", // Removed to use default or direct handling
    }, 
    */
    callbacks: {
        async session({ session, token }) {
            // Pass the user ID or other claims to the session
            return session
        },
    },
}
