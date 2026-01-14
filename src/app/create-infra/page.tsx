import { InfraRequestForm } from "@/components/infra-request-form"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function CreateInfraPage() {
    return (
        <main className="min-h-screen bg-slate-50 flex flex-col items-center p-8">
            <div className="w-full max-w-2xl space-y-6">
                <Link href="/">
                    <Button variant="ghost" className="pl-0 hover:bg-transparent hover:text-primary mb-6">
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Back to Dashboard
                    </Button>
                </Link>

                <div className="text-center space-y-2 mb-8">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Request Infrastructure</h1>
                    <p className="text-muted-foreground">
                        Provision cloud resources via Terraform automation.
                    </p>
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle>Resource Details</CardTitle>
                        <CardDescription>
                            Your request will be processed automatically via GitOps.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <InfraRequestForm />
                    </CardContent>
                </Card>
            </div>
        </main>
    )
}
