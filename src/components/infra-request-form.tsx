"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { useState, useEffect } from "react"
import { useSearchParams } from "next/navigation"

import { Button } from "@/components/ui/button"
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader2 } from "lucide-react"

// Team to Repo Mapping
const TEAM_REPO_MAPPING = {
    "Digital": "oms",
    "Helios": "helios",
    "Retail": "ikp-ret-pe-comerzzia",
    "Commerce": "digital-ecommerce",
    "Clusters": "eks",
    "Tooling": "shared-general"
}

// Zod Schema with refinements
const formSchema = z.object({
    team: z.enum(["Digital", "Helios", "Retail", "Commerce", "Clusters", "Tooling"], {
        required_error: "Please select a team.",
    }),
    target_environments: z.array(z.string()).refine((value) => value.length > 0, {
        message: "Select at least one environment.",
    }),
    resource_type: z.enum(["s3", "rds", "lambda", "iam_role"], {
        required_error: "Please select a resource type.",
    }),
    // S3 Fields
    bucket_name: z.string().optional(),
    // RDS Fields
    identifier: z.string().optional(),
    db_name: z.string().optional(),
    size: z.enum(["small", "medium", "large"]).optional(),
    // Lambda Fields
    function_name: z.string().optional(),
    runtime: z.string().optional(),
    // IAM Role Fields
    role_name: z.string().optional(),
    namespace: z.string().optional(),
    enable_s3: z.boolean().default(false),
    enable_secrets: z.boolean().default(false),
    enable_sqs: z.boolean().default(false),
    enable_sns: z.boolean().default(false),
    enable_eventbridge: z.boolean().default(false),
    enable_rds: z.boolean().default(false),
}).superRefine((data, ctx) => {
    if (data.resource_type === "s3") {
        if (!data.bucket_name || data.bucket_name.length < 3) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Bucket name is required and must be at least 3 chars",
                path: ["bucket_name"],
            })
        }
    }
    if (data.resource_type === "rds") {
        if (!data.identifier) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Identifier is required", path: ["identifier"] })
        }
        if (!data.db_name) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DB Name is required", path: ["db_name"] })
        }
        if (!data.size) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Size is required", path: ["size"] })
        }
    }
    if (data.resource_type === "lambda") {
        if (!data.function_name) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Function name is required", path: ["function_name"] })
        }
        if (!data.runtime) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Runtime is required", path: ["runtime"] })
        }
    }
    if (data.resource_type === "iam_role") {
        if (!data.role_name) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Role Name is required", path: ["role_name"] })
        }
        if (!data.namespace) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Namespace is required", path: ["namespace"] })
        }
    }
})

export function InfraRequestForm() {
    const searchParams = useSearchParams()
    // @ts-ignore
    const defaultType = searchParams.get("type") as "s3" | "rds" | "lambda" | "iam_role" | null

    const [isLoading, setIsLoading] = useState(false)
    const [success, setSuccess] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            // @ts-ignore
            resource_type: defaultType || "s3",
            target_environments: [],
            size: "small",
            runtime: "python3.9",
            enable_s3: false,
            enable_secrets: false,
            enable_sqs: false,
            enable_sns: false,
            enable_eventbridge: false,
            enable_rds: false
        },
    })

    const resourceType = form.watch("resource_type")

    // Update form if URL param changes
    useEffect(() => {
        if (defaultType) {
            form.setValue("resource_type", defaultType)
        }
    }, [defaultType, form])

    // Auto-set environment for Tooling team
    const team = form.watch("team")
    useEffect(() => {
        if (team === "Tooling") {
            form.setValue("target_environments", ["tooling"])
        } else {
            const currentEnvs = form.getValues("target_environments")
            if (currentEnvs.length === 1 && currentEnvs[0] === "tooling") {
                form.setValue("target_environments", [])
            }
        }
    }, [team, form])

    async function onSubmit(values: z.infer<typeof formSchema>) {
        setIsLoading(true)
        setSuccess(null)
        setError(null)

        const payload = {
            ...values,
            repo_name: TEAM_REPO_MAPPING[values.team]
        }

        try {
            const response = await fetch("/api/create-infra", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || "Something went wrong")
            }

            setSuccess("Infrastructure request sent to n8n successfully!")
            // Keep team but reset other fields
            form.reset({
                team: values.team,
                target_environments: [],
                resource_type: values.resource_type,
                enable_s3: false,
                enable_secrets: false,
                enable_sqs: false,
                enable_sns: false,
                enable_eventbridge: false,
                enable_rds: false
            })
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to send request")
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <FormField
                    control={form.control}
                    name="team"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Team / Project Area</FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value}>
                                <FormControl>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select your team" />
                                    </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                    {Object.keys(TEAM_REPO_MAPPING).map((team) => (
                                        <SelectItem key={team} value={team}>{team}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <FormDescription>
                                Maps to the underlying Terraform repository (e.g. {field.value ? TEAM_REPO_MAPPING[field.value as keyof typeof TEAM_REPO_MAPPING] : "..."}).
                            </FormDescription>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="target_environments"
                    render={() => {
                        const selectedTeam = form.watch("team")
                        if (selectedTeam === "Tooling") {
                            return <></>
                        }
                        return (
                            <FormItem>
                                <div className="mb-4">
                                    <FormLabel className="text-base">Target Environments</FormLabel>
                                    <FormDescription>
                                        Select the environments where this resource should be created.
                                    </FormDescription>
                                </div>
                                <div className="flex gap-4">
                                    {["dev", "uat", "prod"].map((env) => (
                                        <FormField
                                            key={env}
                                            control={form.control}
                                            name="target_environments"
                                            render={({ field }) => {
                                                return (
                                                    <FormItem
                                                        key={env}
                                                        className="flex flex-row items-start space-x-3 space-y-0"
                                                    >
                                                        <FormControl>
                                                            <Checkbox
                                                                checked={field.value?.includes(env)}
                                                                onCheckedChange={(checked: boolean | string) => {
                                                                    return checked
                                                                        ? field.onChange([...field.value, env])
                                                                        : field.onChange(
                                                                            field.value?.filter(
                                                                                (value) => value !== env
                                                                            )
                                                                        )
                                                                }}
                                                            />
                                                        </FormControl>
                                                        <FormLabel className="font-normal uppercase">
                                                            {env}
                                                        </FormLabel>
                                                    </FormItem>
                                                )
                                            }}
                                        />
                                    ))}
                                </div>
                                <FormMessage />
                            </FormItem>
                        )
                    }}
                />

                <FormField
                    control={form.control}
                    name="resource_type"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Resource Type</FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                                <FormControl>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select resource type" />
                                    </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                    <SelectItem value="s3">S3 Bucket</SelectItem>
                                    <SelectItem value="rds">RDS Database (Postgres)</SelectItem>
                                    <SelectItem value="lambda">Lambda Function</SelectItem>
                                    <SelectItem value="iam_role">🔐 Create IAM Role</SelectItem>
                                </SelectContent>
                            </Select>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                {/* S3 Fields */}
                {resourceType === "s3" && (
                    <div className="space-y-4 border-l-2 border-primary/50 pl-4 py-2">
                        <FormField
                            control={form.control}
                            name="bucket_name"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Bucket Name</FormLabel>
                                    <FormControl>
                                        <Input placeholder="my-app-assets" {...field} />
                                    </FormControl>
                                    <FormDescription>
                                        Unique name for the S3 bucket.
                                    </FormDescription>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                    </div>
                )}

                {/* RDS Fields */}
                {resourceType === "rds" && (
                    <div className="space-y-4 border-l-2 border-primary/50 pl-4 py-2">
                        <FormField
                            control={form.control}
                            name="identifier"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>RDS Identifier</FormLabel>
                                    <FormControl>
                                        <Input placeholder="my-service-db" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="db_name"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Database Name</FormLabel>
                                    <FormControl>
                                        <Input placeholder="myservicedb" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="size"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Size</FormLabel>
                                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                                        <FormControl>
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select size" />
                                            </SelectTrigger>
                                        </FormControl>
                                        <SelectContent>
                                            <SelectItem value="small">Small (Micro)</SelectItem>
                                            <SelectItem value="medium">Medium</SelectItem>
                                            <SelectItem value="large">Large</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                    </div>
                )}

                {/* Lambda Fields */}
                {resourceType === "lambda" && (
                    <div className="space-y-4 border-l-2 border-primary/50 pl-4 py-2">
                        <FormField
                            control={form.control}
                            name="function_name"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Function Name</FormLabel>
                                    <FormControl>
                                        <Input placeholder="process-orders" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="runtime"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Runtime</FormLabel>
                                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                                        <FormControl>
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select runtime" />
                                            </SelectTrigger>
                                        </FormControl>
                                        <SelectContent>
                                            <SelectItem value="python3.9">Python 3.9</SelectItem>
                                            <SelectItem value="nodejs18.x">Node.js 18.x</SelectItem>
                                            <SelectItem value="go1.x">Go 1.x</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                    </div>
                )}

                {/* IAM Role Fields */}
                {resourceType === "iam_role" && (
                    <div className="space-y-4 border-l-2 border-primary/50 pl-4 py-2">
                        <div className="bg-muted p-3 rounded-md mb-4 text-sm text-muted-foreground">
                            <strong>IRSA Role:</strong> This will create an IAM Role trustable by a Kubernetes Service Account in the specified namespace.
                        </div>
                        <FormField
                            control={form.control}
                            name="role_name"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Role Name</FormLabel>
                                    <FormControl>
                                        <Input placeholder="iskaypet-my-service-access" {...field} />
                                    </FormControl>
                                    <FormDescription>
                                        Recommended format: iskaypet-&lt;service&gt;-access
                                    </FormDescription>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="namespace"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Kubernetes Namespace</FormLabel>
                                    <FormControl>
                                        <Input placeholder="e.g. loyalty, logistics, payments" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <div className="pt-2">
                            <FormLabel className="text-base">Permissions</FormLabel>
                            <FormDescription className="mb-3">
                                Select standard policies to attach to this role.
                            </FormDescription>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <FormField
                                    control={form.control}
                                    name="enable_s3"
                                    render={({ field }) => (
                                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 p-3 border rounded-md bg-card">
                                            <FormControl>
                                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                                            </FormControl>
                                            <div className="space-y-1 leading-none">
                                                <FormLabel>S3 Full Access</FormLabel>
                                            </div>
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="enable_secrets"
                                    render={({ field }) => (
                                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 p-3 border rounded-md bg-card">
                                            <FormControl>
                                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                                            </FormControl>
                                            <div className="space-y-1 leading-none">
                                                <FormLabel>SecretsManager RW</FormLabel>
                                            </div>
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="enable_sqs"
                                    render={({ field }) => (
                                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 p-3 border rounded-md bg-card">
                                            <FormControl>
                                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                                            </FormControl>
                                            <div className="space-y-1 leading-none">
                                                <FormLabel>SQS Full Access</FormLabel>
                                            </div>
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="enable_sns"
                                    render={({ field }) => (
                                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 p-3 border rounded-md bg-card">
                                            <FormControl>
                                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                                            </FormControl>
                                            <div className="space-y-1 leading-none">
                                                <FormLabel>SNS Full Access</FormLabel>
                                            </div>
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="enable_eventbridge"
                                    render={({ field }) => (
                                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 p-3 border rounded-md bg-card">
                                            <FormControl>
                                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                                            </FormControl>
                                            <div className="space-y-1 leading-none">
                                                <FormLabel>EventBridge Full Access</FormLabel>
                                            </div>
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="enable_rds"
                                    render={({ field }) => (
                                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 p-3 border rounded-md bg-card">
                                            <FormControl>
                                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                                            </FormControl>
                                            <div className="space-y-1 leading-none">
                                                <FormLabel>RDS Full Access</FormLabel>
                                            </div>
                                        </FormItem>
                                    )}
                                />
                            </div>
                        </div>

                    </div>
                )}


                {success && (
                    <div className="p-4 rounded-md bg-green-50 text-green-900 border border-green-200">
                        {success}
                    </div>
                )}

                {error && (
                    <div className="p-4 rounded-md bg-red-50 text-red-900 border border-red-200">
                        {error}
                    </div>
                )}

                <Button type="submit" disabled={isLoading} className="w-full bg-primary hover:bg-primary/90">
                    {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Submit Request
                </Button>
            </form>
        </Form>
    )
}
