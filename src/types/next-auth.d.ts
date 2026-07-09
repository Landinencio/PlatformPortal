import { AppRole } from "@/lib/rbac";
import { DefaultSession } from "next-auth";

declare module "next-auth" {
    interface Session {
        user: DefaultSession["user"] & {
            roles: string[];
            appRole: AppRole;
            oid?: string;
        };
    }
}

declare module "next-auth/jwt" {
    interface JWT {
        roles?: string[];
        appRole?: AppRole;
        oid?: string;
    }
}
