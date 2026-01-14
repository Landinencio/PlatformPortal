import { NextResponse } from 'next/server'
import { getServerSession } from "next-auth/next"

export async function POST(req: Request) {
    const session = await getServerSession()

    // Optional: Protect route
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
        const { message, conversationId } = await req.json()

        // Configuration
        const GRAFANA_STACK_URL = process.env.GRAFANA_STACK_URL
        const GRAFANA_TOKEN = process.env.GRAFANA_TOKEN
        const GRAFANA_COOKIE = process.env.GRAFANA_COOKIE

        // --- MOCK MODE (If credentials are missing) ---
        if (!GRAFANA_STACK_URL || (!GRAFANA_TOKEN && !GRAFANA_COOKIE)) {
            console.warn("Grafana credentials missing. Using MOCK mode.")

            // Artificial delay
            await new Promise(resolve => setTimeout(resolve, 1500))

            return NextResponse.json({
                message: `[MOCK] I received your message: "${message}". \n\nI can't access real logs yet because **GRAFANA_TOKEN** (or COOKIE) is not configured. \n\nOnce configured, I will be able to query logs from your stack.`,
                conversationId: conversationId || "mock-conv-123"
            })
        }

        // Prepare Headers
        const headers: HeadersInit = {
            "Content-Type": "application/json"
        }
        if (GRAFANA_TOKEN) {
            headers["Authorization"] = `Bearer ${GRAFANA_TOKEN}`
        } else if (GRAFANA_COOKIE) {
            headers["Cookie"] = `grafana_session=${GRAFANA_COOKIE}`
        }

        // --- REAL MODE ---
        // 1. Create/Continue Chat (Sending the prompt)
        const createChatUrl = `${GRAFANA_STACK_URL}/api/plugins/grafana-assistant-app/resources/api/v1/assistant/chats`

        console.log(`Sending prompt to Grafana: ${message}`)

        const payload: any = { prompt: message }
        if (conversationId) {
            payload.chatId = conversationId
        }

        const createRes = await fetch(createChatUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload)
        })

        if (!createRes.ok) {
            const errText = await createRes.text()
            console.error("Grafana Create Chat Error:", errText)
            return NextResponse.json({ error: `Grafana API Error: ${createRes.status} - ${errText}` }, { status: createRes.status })
        }

        const createData = await createRes.json()
        const chatId = createData.data?.chatId

        if (!chatId) {
            return NextResponse.json({ error: "Failed to get chatId from Grafana" }, { status: 502 })
        }

        // 2. Poll for Response
        // The assistant processes the request asynchronously. We need to poll until we get a response.
        const getChatUrl = `${GRAFANA_STACK_URL}/api/plugins/grafana-assistant-app/resources/api/v1/chats/${chatId}`
        let attempts = 0
        const maxAttempts = 10 // 20 seconds timeout approx
        let lastMessage = null

        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 2000)) // Wait 2s
            attempts++

            const pollRes = await fetch(getChatUrl, {
                headers: headers
            })

            if (!pollRes.ok) continue

            const chatData = await pollRes.json()
            const messages = chatData.messages || []

            // Find the last assistant message
            const assistantMessages = messages.filter((m: any) => m.role === 'assistant')

            if (assistantMessages.length > 0) {
                // Check if it's the response to our current prompt (simplistic check: is it new?)
                // In a real implementation, we'd check timestamps or IDs.
                // For now, take the last one.
                const latestMsg = assistantMessages[assistantMessages.length - 1]

                // If content is present, we assume success. 
                // Sometimes assistant messages stream or update. We wait for a "complete" state if available, 
                // but checking for text existence is a good start.
                if (latestMsg.content && latestMsg.content.length > 0) {
                    // Extract text from content array
                    const textContent = latestMsg.content.find((c: any) => c.type === 'text')?.text

                    if (textContent) {
                        lastMessage = textContent
                        break // We got an answer
                    }
                }
            }
        }

        if (!lastMessage) {
            return NextResponse.json({ message: "I'm thinking... (Timed out, please check back later)", conversationId: chatId })
        }

        return NextResponse.json({
            message: lastMessage,
            conversationId: chatId
        })

    } catch (error) {
        console.error('Grafana Chat Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
