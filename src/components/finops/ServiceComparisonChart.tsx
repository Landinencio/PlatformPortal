"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AccountSummary } from "@/types/finops";

interface ServiceComparisonChartProps {
    accounts: AccountSummary[];
    viewMode: 'service' | 'account';
}

export function ServiceComparisonChart({ accounts, viewMode }: ServiceComparisonChartProps) {

    const formatServiceName = (name: string) => {
        return name
            .replace("Amazon Elastic Compute Cloud - Compute", "EC2 - Compute")
            .replace("Amazon Elastic Compute Cloud", "EC2")
            .replace("Amazon Elastic Container Service for Kubernetes", "EKS")
            .replace("Amazon Simple Storage Service", "S3")
            .replace("Amazon Relational Database Service", "RDS")
            .replace("Amazon Virtual Private Cloud", "VPC")
            .replace("Amazon Elastic Load Balancing", "ELB")
            .replace("Amazon CloudWatch", "CloudWatch")
            .replace(/^Amazon /, "");
    };

    const prepareData = () => {
        if (viewMode === 'account') {
            return accounts
                .slice(0, 10)
                .map(acc => ({
                    name: acc.accountName.length > 20 ? acc.accountName.substring(0, 20) + '...' : acc.accountName,
                    cost: parseFloat(acc.totalCost.toFixed(2)),
                    fullName: acc.accountName
                }));
        } else {
            // Aggregate by service across all accounts
            const serviceMap: { [key: string]: number } = {};
            accounts.forEach(acc => {
                acc.services.forEach(svc => {
                    if (!serviceMap[svc.name]) {
                        serviceMap[svc.name] = 0;
                    }
                    serviceMap[svc.name] += svc.cost;
                });
            });

            return Object.entries(serviceMap)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([name, cost]) => ({
                    name: formatServiceName(name).length > 20
                        ? formatServiceName(name).substring(0, 20) + '...'
                        : formatServiceName(name),
                    cost: parseFloat(cost.toFixed(2)),
                    fullName: formatServiceName(name)
                }));
        }
    };

    const data = prepareData();

    const CustomTooltip = ({ active, payload }: any) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-background border rounded-lg shadow-lg p-3">
                    <p className="font-semibold">{payload[0].payload.fullName}</p>
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
                <CardTitle>Top 10 {viewMode === 'service' ? 'Services' : 'Accounts'} by Cost</CardTitle>
                <CardDescription>
                    Comparative analysis of highest spenders
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ResponsiveContainer width="100%" height={400}>
                    <BarChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis
                            dataKey="name"
                            angle={-45}
                            textAnchor="end"
                            height={100}
                            className="text-xs"
                        />
                        <YAxis
                            tickFormatter={(value) => `$${value.toLocaleString()}`}
                            className="text-xs"
                        />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend />
                        <Bar
                            dataKey="cost"
                            fill="hsl(var(--primary))"
                            radius={[8, 8, 0, 0]}
                            name="Cost ($)"
                        />
                    </BarChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}
