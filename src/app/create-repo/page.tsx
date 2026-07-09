"use client"

import { GitLabRepoForm } from "@/components/gitlab-repo-form"

export default function CreateRepoPage() {
    return (
        <main className="min-h-screen flex items-center justify-center p-4">
            <div className="w-full max-w-2xl space-y-4">
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
