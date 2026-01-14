"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Bot, MessageSquare, X, Send, User, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

interface Message {
    id: string
    role: "user" | "assistant"
    content: string
}

export function GlobalChat() {
    const [isOpen, setIsOpen] = useState(false)
    const [messages, setMessages] = useState<Message[]>([
        { id: "1", role: "assistant", content: "Hello! I'm your Grafana Assistant. Ask me anything about your logs or metrics." }
    ])
    const [input, setInput] = useState("")
    const [loading, setLoading] = useState(false)
    const [conversationId, setConversationId] = useState<string | null>(null)
    const messagesEndRef = useRef<HTMLDivElement>(null)

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }

    useEffect(() => {
        scrollToBottom()
    }, [messages, isOpen])

    const handleSend = async () => {
        if (!input.trim()) return

        const userMsg: Message = { id: Date.now().toString(), role: "user", content: input }
        setMessages(prev => [...prev, userMsg])
        setInput("")
        setLoading(true)

        try {
            const res = await fetch("/api/grafana-chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: userMsg.content,
                    conversationId
                })
            })

            const data = await res.json()

            if (data.error) {
                setMessages(prev => [...prev, { id: Date.now().toString(), role: "assistant", content: `Error: ${data.error}` }])
            } else {
                setMessages(prev => [...prev, { id: Date.now().toString(), role: "assistant", content: data.message || data.content || "I didn't get a response." }])
            }

            if (data.conversationId) setConversationId(data.conversationId)

        } catch (err) {
            setMessages(prev => [...prev, { id: Date.now().toString(), role: "assistant", content: "Sorry, I encountered a connection error." }])
        } finally {
            setLoading(false)
        }
    }

    return (
        <>
            {/* Floating Toggle Button */}
            <div className={cn("fixed bottom-6 right-6 z-50 transition-all duration-300", isOpen ? "translate-y-4 opacity-0 pointer-events-none" : "translate-y-0 opacity-100")}>
                <Button
                    onClick={() => setIsOpen(true)}
                    size="lg"
                    className="rounded-full w-14 h-14 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 shadow-lg"
                >
                    <Bot className="w-8 h-8 text-white" />
                </Button>
            </div>

            {/* Chat Window */}
            <div className={cn(
                "fixed bottom-6 right-6 z-50 w-[90vw] md:w-[400px] transition-all duration-300 transform origin-bottom-right",
                isOpen ? "scale-100 opacity-100" : "scale-90 opacity-0 pointer-events-none translate-y-10"
            )}>
                <Card className="h-[600px] flex flex-col shadow-2xl border-orange-200">
                    <CardHeader className="bg-gradient-to-r from-orange-500 to-amber-500 text-white rounded-t-xl p-4 flex flex-row items-center justify-between shrink-0">
                        <div className="flex items-center gap-2">
                            <Bot className="w-6 h-6" />
                            <CardTitle className="text-lg">Grafana Assistant</CardTitle>
                        </div>
                        <Button variant="ghost" size="icon" onClick={() => setIsOpen(false)} className="text-white hover:bg-white/20 rounded-full h-8 w-8">
                            <ChevronDown className="w-5 h-5" />
                        </Button>
                    </CardHeader>

                    <CardContent className="flex-1 flex flex-col p-0 overflow-hidden bg-slate-50">
                        {/* Messages Area */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-4">
                            {messages.map((msg) => (
                                <div key={msg.id} className={cn("flex gap-2 max-w-[85%]", msg.role === "user" ? "ml-auto flex-row-reverse" : "")}>
                                    <div className={cn("w-8 h-8 rounded-full flex items-center justify-center shrink-0", msg.role === "user" ? "bg-slate-200" : "bg-orange-100")}>
                                        {msg.role === "user" ? <User className="w-5 h-5 text-slate-600" /> : <Bot className="w-5 h-5 text-orange-600" />}
                                    </div>
                                    <div className={cn("p-3 text-sm rounded-lg whitespace-pre-wrap shadow-sm",
                                        msg.role === "user" ? "bg-white border text-slate-800 rounded-tr-none" : "bg-orange-50 border border-orange-100 text-slate-800 rounded-tl-none"
                                    )}>
                                        {msg.content}
                                    </div>
                                </div>
                            ))}
                            {loading && (
                                <div className="flex gap-2 max-w-[85%]">
                                    <div className="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                                        <Bot className="w-5 h-5 text-orange-600" />
                                    </div>
                                    <div className="p-3 text-sm bg-orange-50 border border-orange-100 rounded-lg rounded-tl-none flex items-center gap-1">
                                        <span className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                        <span className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                        <span className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Input Area */}
                        <div className="p-4 bg-white border-t border-slate-200 shrink-0">
                            <form
                                onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                                className="flex gap-2"
                            >
                                <Input
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    placeholder="Check errors in n8n..."
                                    disabled={loading}
                                    className="focus-visible:ring-orange-500"
                                />
                                <Button type="submit" size="icon" disabled={loading || !input.trim()} className="bg-orange-500 hover:bg-orange-600">
                                    <Send className="w-4 h-4" />
                                </Button>
                            </form>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </>
    )
}
