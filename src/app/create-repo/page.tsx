"use client"

import { useSession } from "next-auth/react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { GitLabRepoForm } from "@/components/gitlab-repo-form"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function CreateRepoPage() {
    const { data: session } = useSession()

    return (
        <main className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <div className="w-full max-w-2xl space-y-4">
                <div className="flex items-center space-x-2 mb-6">
                    <Link href="/">
                        <Button variant="ghost" className="pl-0 hover:bg-transparent hover:text-primary">
                            <ArrowLeft className="mr-2 h-4 w-4" />
                            Back to Dashboard
                        </Button>
                    </Link>
                </div>

                <div className="text-center mb-8">
                    <div className="flex justify-center mb-4">
                        <img src="/logo.svg" alt="IskayPet Logo" className="h-12" />
                    </div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">
                        Create Repository
                    </h1>
                    <p className="text-muted-foreground mt-2">
                        Provision a new GitLab repository with Jira tracking.
                    </p>
                </div>

                <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
                    <div className="h-1 bg-primary" />
                    <div className="p-6 md:p-8">
                        <GitLabRepoForm />
                    </div>
                </div>
            </div>
        </main>
    )
}
