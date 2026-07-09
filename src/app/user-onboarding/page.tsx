"use client"

import { useState } from "react"
import { useSession } from "next-auth/react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { Check, Shield, Server, Box, Cloud, Activity } from "lucide-react"

// Types
type AppType = "argocd" | "sonarqube" | "grafana" | "platform" | "aws"

interface GroupOption {
    id: string
    name: string
}

// Configuration
const APP_GROUPS: Record<AppType, GroupOption[]> = {
    argocd: [
        { id: "10e6a424-9175-4943-8882-47c18b0dffcf", name: "ArgoCD User Access" }
    ],
    sonarqube: [], // Filled below
    grafana: [],   // Filled below
    platform: [],  // Filled below
    aws: []        // Filled below
}

const COMMON_DEV_GROUPS: GroupOption[] = [
    { id: "6ddb1477-9517-4ee1-b73e-cb0f9eb05b40", name: "ClienteunicoAccess" },
    { id: "f745f9de-121e-4a9d-a0fb-11621e80babc", name: "AnaliticaEcommerce" },
    { id: "e9086517-91b1-412f-b5d4-41a47b30db28", name: "BackofficeDevelopers" },
    { id: "4b4075e0-c8a5-427b-a69d-b4a1c4a9c843", name: "CXDevelopers" },
    { id: "e0e1c47e-4119-44cc-a259-e851126ba071", name: "ConversionDevelopers" },
    { id: "24926194-4120-4dfe-ab85-119e2f9d7bba", name: "DataDevelopers" },
    { id: "d1c630fb-d9ec-4e4a-9387-864a8c8fd16a", name: "MiddlewareBIDevelopers" },
    { id: "14bb08e6-7be1-4cb6-b6ed-e9f26cdb611d", name: "OMSDevelopers" },
    { id: "f86824ed-d0ac-4fd8-a12c-a1fd4077c455", name: "ProfitabilityDevelopers" },
    { id: "694da113-a0d5-4754-b0fd-90f34da30196", name: "RetailDevelopers" },
    { id: "b09c90a9-2682-48ca-a0cb-6b2b262a790a", name: "TakeoverDevelopers" },
]

const AWS_EXTRA_GROUPS: GroupOption[] = [
    { id: "6e589f3c-7c2b-4ecc-a084-5bc614d29d8a", name: "CocktailDevelopers" },
    { id: "50be1c7f-052e-4fcb-8c6d-a8f15cf8a250", name: "MakingScienceSFCC" },
]

// Populate groups
APP_GROUPS.sonarqube = COMMON_DEV_GROUPS
APP_GROUPS.grafana = COMMON_DEV_GROUPS
APP_GROUPS.platform = COMMON_DEV_GROUPS
APP_GROUPS.aws = [...COMMON_DEV_GROUPS, ...AWS_EXTRA_GROUPS]

export default function UserOnboardingPage() {
    const { data: session } = useSession()
    const [selectedApp, setSelectedApp] = useState<AppType | null>(null)
    const [selectedGroupId, setSelectedGroupId] = useState<string>("")
    const [loading, setLoading] = useState(false)
    const [success, setSuccess] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const [email, setEmail] = useState<string>("")

    // Initialize email from session
    if (session?.user?.email && !email) {
        setEmail(session.user.email)
    }

    const handleAppSelect = (app: AppType) => {
        setSelectedApp(app)
        setSuccess(false)
        setError(null)

        // Auto-select group if there is only one option (e.g. ArgoCD)
        if (APP_GROUPS[app].length === 1) {
            setSelectedGroupId(APP_GROUPS[app][0].id)
        } else {
            setSelectedGroupId("")
        }
    }

    const handleSubmit = async () => {
        if (!selectedApp || !selectedGroupId || !email) return

        setLoading(true)
        setError(null)

        try {
            const res = await fetch("/api/user-onboarding", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    user_email: email,
                    target_group_id: selectedGroupId,
                    app_name: selectedApp,
                    group_name: APP_GROUPS[selectedApp].find(g => g.id === selectedGroupId)?.name
                })
            })

            if (!res.ok) throw new Error("Failed to submit request")

            setSuccess(true)
        } catch (err) {
            setError("Something went wrong. Please try again.")
        } finally {
            setLoading(false)
        }
    }

    const apps = [
        { id: "argocd", label: "ArgoCD", icon: Box },
        { id: "sonarqube", label: "SonarQube", icon: Activity },
        { id: "grafana", label: "Grafana Tooling", icon: Activity },
        { id: "platform", label: "Platform Portal", icon: Server },
        { id: "aws", label: "AWS Access", icon: Cloud },
    ] as const

    return (
        <main className="min-h-screen p-8 md:p-24 flex justify-center">
            <Card className="w-full max-w-3xl">
                <CardHeader>
                    <CardTitle className="text-2xl flex items-center gap-2">
                        <Shield className="w-6 h-6 text-primary" />
                        Request Access
                    </CardTitle>
                    <CardDescription>
                        Gain access to enterprise tools by joining the specific Azure AD group for your team.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-8">

                    {/* User Info (Editable) */}
                    <div className="grid gap-2">
                        <Label>Requesting for (Email)</Label>
                        <Input
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="user@iskaypet.com"
                            className="bg-background"
                        />
                    </div>

                    {/* App Selector */}
                    <div className="space-y-3">
                        <Label>Select Application</Label>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                            {apps.map((app) => (
                                <div
                                    key={app.id}
                                    onClick={() => handleAppSelect(app.id as AppType)}
                                    className={cn(
                                        "cursor-pointer border rounded-lg p-4 flex flex-col items-center gap-2 transition-all hover:shadow-md hover:border-primary/50",
                                        selectedApp === app.id
                                            ? "border-primary ring-1 ring-primary bg-primary/5"
                                            : "border-border bg-card"
                                    )}
                                >
                                    <app.icon className={cn("w-8 h-8", selectedApp === app.id ? "text-primary" : "text-muted-foreground")} />
                                    <span className={cn("text-sm font-medium", selectedApp === app.id ? "text-primary" : "text-foreground")}>{app.label}</span>
                                    {selectedApp === app.id && <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-primary" />}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Group Selector */}
                    {selectedApp && (
                        <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                            <Label>Select Team / Role</Label>
                            {APP_GROUPS[selectedApp].length === 1 ? (
                                // Single Option (Read Only view)
                                <div className="p-3 border rounded-md bg-muted text-sm text-foreground font-medium flex justify-between items-center">
                                    {APP_GROUPS[selectedApp][0].name}
                                    <Check className="w-4 h-4 text-green-600" />
                                </div>
                            ) : (
                                // Dropdown for multiple options
                                <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select your team" />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-[300px]">
                                        {APP_GROUPS[selectedApp].map((group) => (
                                            <SelectItem key={group.id} value={group.id}>
                                                {group.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                    )}

                    {/* Submit Action */}
                    <div className="pt-4">
                        {success ? (
                            <div className="p-4 bg-success/10 border border-success/30 rounded-lg flex items-center gap-3 text-foreground animate-in zoom-in">
                                <Check className="w-5 h-5" />
                                <div>
                                    <p className="font-semibold">Request Submitted!</p>
                                    <p className="text-sm text-muted-foreground">You have been added to the group successfully.</p>
                                </div>
                                <Button variant="outline" size="sm" className="ml-auto" onClick={() => { setSuccess(false); setSelectedApp(null); }}>
                                    New Request
                                </Button>
                            </div>
                        ) : (
                            <Button
                                className="w-full"
                                size="lg"
                                disabled={!selectedApp || !selectedGroupId || loading}
                                onClick={handleSubmit}
                            >
                                {loading ? "Processing..." : "Grant Access"}
                            </Button>
                        )}

                        {error && (
                            <p className="text-sm text-danger mt-2 text-center">{error}</p>
                        )}
                    </div>

                </CardContent>
            </Card>
        </main>
    )
}
