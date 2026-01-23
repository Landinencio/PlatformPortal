import { NextRequest, NextResponse } from "next/server";
import type { AthenaFinOpsResponse } from "@/types/finops";

const OLLAMA_API = "http://ollama.ollama.svc.cluster.local:11434";

export async function POST(request: NextRequest) {
    try {
        const body: AthenaFinOpsResponse = await request.json();

        // Build analysis prompt
        const prompt = buildAnalysisPrompt(body);

        // Call Ollama/DeepSeek
        const ollamaResponse = await fetch(`${OLLAMA_API}/api/generate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "deepseek-r1:8b",
                prompt: prompt,
                stream: false,
            }),
        });

        if (!ollamaResponse.ok) {
            throw new Error(`Ollama API returned ${ollamaResponse.status}`);
        }

        const aiResponse = await ollamaResponse.json();

        return NextResponse.json({
            analysis: aiResponse.response,
            model: "deepseek-r1:1.5b",
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Error calling Ollama:", error);
        return NextResponse.json(
            { error: "Failed to generate AI analysis" },
            { status: 500 }
        );
    }
}

function buildAnalysisPrompt(data: AthenaFinOpsResponse): string {
    const { summary, accounts, topMovers, dateRange } = data;

    return `Eres un experto en FinOps de AWS. Analiza estos datos de costos de AWS del periodo ${dateRange.start} al ${dateRange.end}.

DATOS GENERALES:
- Costo total: $${summary.totalCost}
- Número de cuentas: ${summary.accountCount}
- Servicio principal: ${summary.topService.name} ($${summary.topService.cost})
- Cambio vs periodo anterior: ${summary.topService.trend.percentage}%

TOP 5 AUMENTOS:
${topMovers.increases.map(m => `- ${m.service}: +$${m.change} (${m.percentage}%)`).join('\n')}

TOP 5 REDUCCIONES:
${topMovers.decreases.map(m => `- ${m.service}: $${m.change} (${m.percentage}%)`).join('\n')}

DESGLOSE POR CUENTA (Top 3):
${accounts.slice(0, 3).map(acc => `- ${acc.accountName}: $${acc.totalCost} (${acc.trend.percentage >= 0 ? '+' : ''}${acc.trend.percentage}%)`).join('\n')}

ANALIZA Y RESPONDE EN ESPAÑOL:

1. **🚨 ANOMALÍAS**: Identifica costos inusuales o aumentos preocupantes (>20%).
2. **📊 INSIGHTS**: Patrones importantes o tendencias relevantes.
3. **💡 RECOMENDACIONES**: 2-3 acciones concretas para optimizar costos.
4. **✅ POSITIVO**: Menciona optimizaciones exitosas si las hay.

Sé conciso, profesional y directo. Máximo 200 palabras.`;
}
