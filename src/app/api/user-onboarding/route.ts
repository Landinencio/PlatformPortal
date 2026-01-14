import { NextResponse } from 'next/server'
import { getServerSession } from "next-auth/next"

export async function POST(req: Request) {
    try {
        const session = await getServerSession()

        // Optional: Protect route
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await req.json()
        const webhookUrl = process.env.N8N_ONBOARDING_WEBHOOK

        if (!webhookUrl) {
            return NextResponse.json({ error: 'Webhook URL not configured' }, { status: 500 })
        }

        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })

        if (!res.ok) {
            throw new Error(`n8n responded with ${res.status}`)
        }

        const data = await res.json()
        return NextResponse.json(data)
    } catch (error) {
        console.error('Proxy Error:', error)
        return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
    }
}
