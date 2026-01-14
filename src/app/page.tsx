"use client"

import { useSession } from "next-auth/react"
import { LoginButton } from "@/components/login-button"
import { LogoutButton } from "@/components/logout-button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { GitBranch, Database, HardDrive, Zap, Lock, Cloud, Shield, Users, DollarSign } from "lucide-react"
import Link from "next/link"
import { cn } from "@/lib/utils"

export default function Home() {
  const { data: session } = useSession()

  const features = [
    {
      title: "Create Repository",
      description: "Scaffold a new GitLab project with Jira integration.",
      icon: GitBranch,
      href: "/create-repo",
      active: true,
    },
    {
      title: "Request Infrastructure",
      description: "Provision cloud resources (S3, RDS, Lambda) via Terraform.",
      icon: Cloud,
      href: "/create-infra",
      active: true,
    },
    {
      title: "Create IAM Role",
      description: "Request a new AWS IAM Role with specific permissions.",
      icon: Shield,
      href: "/create-infra?type=iam_role",
      active: true,
    },
    {
      title: "User Onboarding",
      description: "Request access to enterprise applications (ArgoCD, SonarQube, AWS).",
      icon: Users,
      href: "/user-onboarding",
      active: true,
    },
    {
      title: "FinOps Cost Explorer",
      description: "Analyze AWS cloud spend efficiency globally or per account.",
      icon: DollarSign,
      href: "/finops",
      active: true,
    },
  ]

  return (
    <main className="min-h-screen bg-slate-50 flex flex-col items-center p-8 md:p-24">
      <div className="w-full max-w-5xl space-y-8">
        {/* Header Section */}
        <div className="text-center space-y-4">
          <div className="flex justify-center mb-6">
            <img src="/logo.svg" alt="IskayPet Logo" className="h-16" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-slate-900">
            Platform Engineering Portal
          </h1>

          {!session ? (
            <div className="mt-8 flex justify-center">
              <Card className="w-full max-w-md bg-white border-slate-200 shadow-md">
                <CardHeader>
                  <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Lock className="w-6 h-6 text-primary" />
                  </div>
                  <CardTitle>Welcome Back</CardTitle>
                  <CardDescription>
                    Please sign in with your corporate account to access the self-service portal.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <LoginButton />
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex justify-between items-center max-w-2xl mx-auto">
                <p className="text-xl text-slate-600">
                  Welcome, <span className="font-semibold text-primary">{session.user?.name?.split(" ")[0]}!</span>
                </p>
                <LogoutButton />
              </div>
              <p className="text-slate-500 max-w-2xl mx-auto pt-2">
                Select a service below to get started. We are constantly adding new capabilities to help you ship faster.
              </p>
            </div>
          )}
        </div>

        {/* Dashboard Grid */}
        {session && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6 mt-12">
            {features.map((feature, index) => (
              <Link
                key={index}
                href={feature.active ? feature.href : "#"}
                className={cn(
                  "block transition-all duration-200",
                  feature.active ? "hover:scale-105 cursor-pointer" : "cursor-not-allowed opacity-60 grayscale-[0.5]"
                )}
              >
                <Card className="h-full border-border/50 hover:border-primary/50 hover:shadow-md transition-all duration-300 bg-card">
                  <CardHeader className="flex flex-row items-center space-y-0 pb-2">
                    <div className={cn("p-3 rounded-lg mr-4 bg-primary/10")}>
                      <feature.icon className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{feature.title}</CardTitle>
                      {!feature.active && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 mt-1 inline-block">
                          Coming Soon
                        </span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <CardDescription className="text-base">
                      {feature.description}
                    </CardDescription>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
