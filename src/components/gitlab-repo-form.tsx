"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { useState } from "react"

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
import { Loader2 } from "lucide-react"

const formSchema = z.object({
    name: z.string().min(2, {
        message: "Repository name must be at least 2 characters.",
    }).regex(/^[a-zA-Z0-9-_]+$/, {
        message: "Repository name can only contain letters, numbers, dashes and underscores.",
    }),
    description: z.string().optional(),
    namespace_id: z.string().min(1, { message: "Namespace ID is required." }),
    template: z.string().min(1, { message: "Please select a template." }),
})

export function GitLabRepoForm() {
    const [isLoading, setIsLoading] = useState(false)
    const [success, setSuccess] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            name: "",
            description: "",
            namespace_id: "",
            template: "",
        },
    })

    async function onSubmit(values: z.infer<typeof formSchema>) {
        setIsLoading(true)
        setSuccess(null)
        setError(null)

        try {
            const response = await fetch("/api/create-repo", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(values),
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || "Something went wrong")
            }

            setSuccess("Repository create request sent to n8n!")
            form.reset()
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create repository")
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Repository Name</FormLabel>
                            <FormControl>
                                <Input placeholder="my-service-api" {...field} />
                            </FormControl>
                            <FormDescription>
                                Unqiue name for the new repository.
                            </FormDescription>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="namespace_id"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Group ID or Subgroup ID</FormLabel>
                            <FormControl>
                                <Input placeholder="123456" {...field} />
                            </FormControl>
                            <FormDescription>
                                The GitLab Group ID where the repo will be created.
                            </FormDescription>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="template"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Template</FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value}>
                                <FormControl>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select a repository template" />
                                    </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                    <SelectItem value="go-microservices">Go Microservices</SelectItem>
                                    <SelectItem value="frontend-headless">Frontend Headless</SelectItem>
                                    <SelectItem value="springboot-microservices">Springboot Microservices</SelectItem>
                                    <SelectItem value="fastapi-microservices">FastAPI Microservices</SelectItem>
                                    <SelectItem value="springboot-library">Springboot Library</SelectItem>
                                </SelectContent>
                            </Select>
                            <FormDescription>
                                This will scaffold the repository with the chosen stack.
                            </FormDescription>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="description"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Description (Optional)</FormLabel>
                            <FormControl>
                                <Input placeholder="Service purpose..." {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />

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
                    Create Repository
                </Button>
            </form>
        </Form>
    )
}
