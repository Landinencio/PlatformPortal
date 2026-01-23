"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface CostTrendChartProps {
    currentPeriodData: { date: string; cost: number }[];
    previousPeriodData: { date: string; cost: number }[];
}

export function CostTrendChart({ currentPeriodData, previousPeriodData }: CostTrendChartProps) {

    // For now, we'll create a simple comparison of current vs previous period
    // This will be enhanced when we get daily breakdown from backend
    const data = [
        {
            period: 'Previous Period',
            cost: previousPeriodData.reduce((sum, d) => sum + d.cost, 0)
        },
        {
            period: 'Current Period',
            cost: currentPeriodData.reduce((sum, d) => sum + d.cost, 0)
        }
    ];

    const CustomTooltip = ({ active, payload }: any) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-background border rounded-lg shadow-lg p-3">
                    <p className="font-semibold">{payload[0].payload.period}</p>
                    <p className="text-primary font-bold">
                        ${payload[0].value.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </p>
                </div>
            );
        }
        return null;
    };

    return (
        <Card className="border-none shadow-lg">
            <CardHeader>
                <CardTitle>Cost Trend Comparison</CardTitle>
                <CardDescription>
                    Current period vs Previous period
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={data} margin={{ top: 10, right: 30, left: 20, bottom: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="period" className="text-xs" />
                        <YAxis
                            tickFormatter={(value) => `$${value.toLocaleString()}`}
                            className="text-xs"
                        />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend />
                        <Line
                            type="monotone"
                            dataKey="cost"
                            stroke="hsl(var(--primary))"
                            strokeWidth={3}
                            dot={{ fill: 'hsl(var(--primary))', r: 6 }}
                            activeDot={{ r: 8 }}
                            name="Total Cost ($)"
                        />
                    </LineChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}
