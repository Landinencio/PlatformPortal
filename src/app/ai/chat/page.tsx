import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { PlatformChat } from "@/components/ai/platform-chat";
import { Home, Bot } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// Only these users can access the AI chat (beta)
const ALLOWED_USERS = [
  "ruben.landin@iskaypet.com",
];

export default async function AIChatPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/");
  }

  const userEmail = session.user?.email?.toLowerCase() || "";
  
  if (!ALLOWED_USERS.includes(userEmail)) {
    redirect("/?forbidden=beta");
  }

  return (
    <div className="container mx-auto py-6">
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2">
              <Home className="w-4 h-4" />
              Home
            </Button>
          </Link>
          <span className="text-muted-foreground">/</span>
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-blue-500" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">El Becario</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-600 font-medium">BETA</span>
          </div>
        </div>
        <p className="text-muted-foreground mt-1">
          Tu becario SRE con acceso a GitLab, Grafana, métricas DORA y más.
        </p>
      </div>

      {/* Chat */}
      <PlatformChat />
    </div>
  );
}
