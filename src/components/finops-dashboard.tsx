
"use client";

import { useState, useEffect } from "react";
import { Loader2, DollarSign, PieChart, Building2, RefreshCw, AlertCircle, Calendar, Home } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label"; // Check if this exists, if not use native label or div

// Initial Dates
const getFirstOfMonth = () => {
    const now = new Date();
    // Return YYYY-MM-DD format strictly for input value
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
};
const getToday = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

type ServiceCost = {
    name: string;
    cost: number;
};

type AccountSummary = {
    name: string;
    id: string;
    total: number;
    topService: string;
};

type FinOpsResponse = {
    reportType: string;
    totalCurrency?: string;
    totalCost: number;
    services: ServiceCost[];
    breakdownByAccount?: AccountSummary[];
    accountName?: string;
    accountId?: string;
};

export function FinOpsDashboard() {
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<FinOpsResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [selectedAccountId, setSelectedAccountId] = useState<string>("");
    const [startDate, setStartDate] = useState<string>(getFirstOfMonth());
    const [endDate, setEndDate] = useState<string>(getToday());

    // STABLE ACCOUNT LIST (Hardcoded to ensure Dropdown is always available)
    const accountsList = [
        // EKS
        { id: "111122223333", name: "EKS Dev / Default" },
        { id: "222233334444", name: "EKS UAT" },
        { id: "000339436598", name: "EKS Prod" },
        { id: "012966899965", name: "EKS Tooling" },
        // Helios
        { id: "850014722158", name: "Helios Dev" },
        { id: "863836597839", name: "Helios UAT" },
        { id: "484517523926", name: "Helios Prod" },
        // Digital
        { id: "343444108351", name: "Digital Ecommerce" },
        { id: "178558647998", name: "Digital Dev" },
        { id: "425981549652", name: "Digital UAT" },
        { id: "722677935098", name: "Digital Prod" },
        { id: "095812636847", name: "Ecommerce Tiendanimal" },
        { id: "496588051783", name: "IskayPet Ecommerce" },
        // Retail
        { id: "531709726950", name: "Retail Dev" },
        { id: "211125399788", name: "Retail UAT" },
        { id: "539960941758", name: "Retail Prod" },
        { id: "176692871045", name: "Animalis Dev" },
        { id: "006157029960", name: "Animalis Prod" },
        { id: "138724810358", name: "Clinicanimal" },
        // Data
        { id: "590222455071", name: "Data Dev" },
        { id: "615170114703", name: "IskayPet Data" },
        { id: "307516957806", name: "Infra" },
        { id: "801185562308", name: "SAP" },
        { id: "194193179595", name: "Sistemas Tiendanimal" }
    ];

    const fetchData = async () => {
        if (!selectedAccountId) {
            setError("Please select an account first.");
            return;
        }

        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.append("accountId", selectedAccountId || "all");
            if (startDate) params.append("startDate", startDate);
            if (endDate) params.append("endDate", endDate);

            const res = await fetch(`/api/finops/costs?${params.toString()}`);
            if (!res.ok) throw new Error("Failed to fetch costs");

            const jsonData: FinOpsResponse = await res.json();
            setData(jsonData);

            // No need to setAccountsList anymore
        } catch (err) {
            setError("Error loading FinOps data.");
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    // Removed initial useEffect to prevent auto-fetch
    // Only manual trigger allowed

    // Allow manual trigger for everything else
    const handleUpdate = () => {
        fetchData();
    };

    const getPercentage = (cost: number, total: number) => {
        if (!total) return 0;
        return Math.min(100, (cost / total) * 100);
    };

    // Color palette helper for services
    const getServiceColor = (index: number) => {
        const colors = [
            "bg-blue-500", "bg-emerald-500", "bg-purple-500", "bg-amber-500",
            "bg-pink-500", "bg-cyan-500", "bg-indigo-500", "bg-rose-500"
        ];
        return colors[index % colors.length];
    };

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

    return (
        <div className="min-h-screen bg-slate-50/50 dark:bg-zinc-950/20 p-2 sm:p-6 space-y-8">
            {/* Header & Navigation */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b pb-6">
                <div>
                    <Link href="/" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary mb-2 transition-colors">
                        <Home className="w-4 h-4 mr-1.5" />
                        Back to Portal
                    </Link>
                    <h1 className="text-4xl font-extrabold tracking-tight bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 bg-clip-text text-transparent">
                        FinOps Explorer
                    </h1>
                    <p className="text-muted-foreground mt-1 text-lg">
                        AWS Cost Intelligence & Optimization
                    </p>
                </div>

                {data && (
                    <div className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 text-emerald-600 rounded-full border border-emerald-500/20 shadow-sm animate-in fade-in slide-in-from-right">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        <span className="text-sm font-semibold">Live Data Active</span>
                    </div>
                )}
            </div>

            {/* CONTROL PANEL (Floating Glass Effect) */}
            <div className="sticky top-4 z-10 mx-auto max-w-5xl rounded-2xl border bg-background/80 shadow-lg backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 p-1">
                <div className="flex flex-col md:flex-row gap-2 p-2">
                    {/* Date Inputs */}
                    <div className="flex flex-1 items-center gap-2 bg-muted/40 p-2 rounded-xl border border-transparent focus-within:border-primary/20 transition-all">
                        <div className="grid place-items-center w-8 h-8 rounded-lg bg-background shadow-sm text-muted-foreground">
                            <Calendar className="w-4 h-4" />
                        </div>
                        <div className="flex flex-1 items-center gap-2">
                            <div className="grid gap-0.5 flex-1">
                                <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">From</label>
                                <input
                                    type="date"
                                    className="bg-transparent border-none p-0 h-auto text-sm font-semibold focus:ring-0 w-full"
                                    value={startDate}
                                    max={endDate}
                                    onChange={(e) => setStartDate(e.target.value)}
                                />
                            </div>
                            <span className="text-muted-foreground/50">→</span>
                            <div className="grid gap-0.5 flex-1">
                                <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">To</label>
                                <input
                                    type="date"
                                    className="bg-transparent border-none p-0 h-auto text-sm font-semibold focus:ring-0 w-full"
                                    value={endDate}
                                    min={startDate}
                                    onChange={(e) => setEndDate(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Account Select */}
                    <div className="flex-[2] flex items-center gap-2 bg-muted/40 p-2 rounded-xl border border-transparent focus-within:border-primary/20 transition-all">
                        <div className="grid place-items-center w-8 h-8 rounded-lg bg-background shadow-sm text-muted-foreground">
                            <Building2 className="w-4 h-4" />
                        </div>
                        <div className="grid gap-0.5 flex-1">
                            <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Target Account</label>
                            <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                                <SelectTrigger className="border-0 bg-transparent p-0 h-auto focus:ring-0 text-sm font-semibold shadow-none">
                                    <SelectValue placeholder="Select an account..." />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all" className="font-semibold text-primary">
                                        <span className="flex items-center">
                                            <span className="w-2 h-2 rounded-full bg-primary mr-2" />
                                            Global Consolidated View
                                        </span>
                                    </SelectItem>
                                    <div className="my-1 h-px bg-muted" />
                                    {accountsList.map((acc) => (
                                        <SelectItem key={acc.id} value={acc.id} className="text-muted-foreground focus:text-foreground">
                                            {acc.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    {/* Action Button */}
                    <Button
                        size="lg"
                        onClick={handleUpdate}
                        disabled={loading}
                        className="h-auto px-8 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-md transition-all hover:scale-[1.02] hover:shadow-lg"
                    >
                        {loading ? (
                            <RefreshCw className="h-5 w-5 animate-spin" />
                        ) : (
                            <span className="flex items-center font-bold">
                                Visualize
                                <PieChart className="ml-2 h-4 w-4" />
                            </span>
                        )}
                    </Button>
                </div>
            </div>

            {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 flex items-center gap-3 text-red-600 animate-in slide-in-from-top-2">
                    <AlertCircle className="h-5 w-5" />
                    <span className="font-medium">{error}</span>
                </div>
            )}

            {!data && !loading && !error && (
                <div className="h-[400px] flex flex-col items-center justify-center text-center opacity-0 animate-in fade-in duration-700 delay-100 fill-mode-forwards">
                    <div className="w-24 h-24 mb-6 rounded-3xl bg-gradient-to-tr from-blue-100 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 flex items-center justify-center">
                        <DollarSign className="w-12 h-12 text-blue-500/50" />
                    </div>
                    <h3 className="text-2xl font-bold text-foreground">Ready to Analyze</h3>
                    <p className="text-muted-foreground w-full max-w-sm mt-2">
                        Select an account and date range above to retrieve the latest cost metrics from AWS Cost Explorer.
                    </p>
                </div>
            )}

            {data && (
                <div className="space-y-8 animate-in fade-in slide-in-from-bottom-8 duration-500">

                    {/* KPI GRID */}
                    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                        {/* KPI 1: Total Cost */}
                        <div className="relative overflow-hidden rounded-2xl border bg-card p-6 shadow-sm transition-all hover:shadow-md group">
                            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-muted-foreground">Total Spend</p>
                                    <div className="mt-2 text-3xl font-bold text-foreground tracking-tight">
                                        ${data.totalCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                    </div>
                                    <div className="mt-1 flex items-center text-xs text-muted-foreground">
                                        <div className="w-2 h-2 rounded-full bg-emerald-500 mr-1.5" />
                                        {selectedAccountId === 'all' ? 'Consolidated' : 'Single Account'}
                                    </div>
                                </div>
                                <div className="p-3 bg-indigo-100 dark:bg-indigo-900/30 rounded-xl text-indigo-600 dark:text-indigo-400">
                                    <DollarSign className="w-6 h-6" />
                                </div>
                            </div>
                        </div>

                        {/* KPI 2: Top Service */}
                        <div className="relative overflow-hidden rounded-2xl border bg-card p-6 shadow-sm transition-all hover:shadow-md group">
                            <div className="absolute inset-0 bg-gradient-to-br from-rose-500/5 to-orange-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                            <div className="flex items-center justify-between">
                                <div className="overflow-hidden pr-2">
                                    <p className="text-sm font-medium text-muted-foreground">Top Service</p>
                                    <div className="mt-2 text-2xl font-bold text-foreground tracking-tight truncate">
                                        {data.services[0] ? formatServiceName(data.services[0].name) : "None"}
                                    </div>
                                    <div className="mt-1 text-xs text-rose-500 font-medium">
                                        ${data.services[0]?.cost?.toLocaleString() || '0'} (High Impact)
                                    </div>
                                </div>
                                <div className="p-3 bg-rose-100 dark:bg-rose-900/30 rounded-xl text-rose-600 dark:text-rose-400 shrink-0">
                                    <Building2 className="w-6 h-6" />
                                </div>
                            </div>
                        </div>

                        {/* KPI 3: Account Count/ID */}
                        <div className="relative overflow-hidden rounded-2xl border bg-card p-6 shadow-sm transition-all hover:shadow-md group">
                            <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/5 to-blue-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-muted-foreground">
                                        {selectedAccountId === 'all' ? 'Accounts Active' : 'Account ID'}
                                    </p>
                                    <div className="mt-2 text-2xl font-bold text-foreground tracking-tight">
                                        {selectedAccountId === 'all' ? (data.breakdownByAccount?.length || 0) : data.accountId?.slice(-8) || "N/A"}
                                        {selectedAccountId !== 'all' && <span className="text-muted-foreground text-sm font-normal">...</span>}
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {selectedAccountId === 'all' ? 'Processing in Batch' : 'Direct Lookup'}
                                    </p>
                                </div>
                                <div className="p-3 bg-cyan-100 dark:bg-cyan-900/30 rounded-xl text-cyan-600 dark:text-cyan-400">
                                    <Building2 className="w-6 h-6" />
                                </div>
                            </div>
                        </div>

                        {/* KPI 4: Date Range */}
                        <div className="relative overflow-hidden rounded-2xl border bg-card p-6 shadow-sm transition-all hover:shadow-md group">
                            <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-teal-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-muted-foreground">Reporting Period</p>
                                    <div className="mt-2 text-lg font-bold text-foreground tracking-tight">
                                        {new Date(startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                        <span className="text-muted-foreground mx-1">→</span>
                                        {new Date(endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                    </div>
                                    <p className="mt-1 text-xs text-emerald-600 font-medium">
                                        Verified Window
                                    </p>
                                </div>
                                <div className="p-3 bg-emerald-100 dark:bg-emerald-900/30 rounded-xl text-emerald-600 dark:text-emerald-400">
                                    <Calendar className="w-6 h-6" />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* MAIN CONTENT AREA */}
                    <div className="grid gap-8 lg:grid-cols-3">

                        {/* LEFT: Service Visualization */}
                        <Card className="lg:col-span-2 border-none shadow-lg bg-card/50 backdrop-blur-sm overflow-hidden">
                            <CardHeader className="border-b bg-muted/20">
                                <div className="flex justify-between items-center">
                                    <div className="space-y-1">
                                        <CardTitle className="text-xl">Cost Breakdown by Service</CardTitle>
                                        <CardDescription>Primary cost drivers for the selected scope</CardDescription>
                                    </div>
                                    <Button variant="outline" size="sm" className="bg-background/50">
                                        <RefreshCw className="w-3 h-3 mr-2 text-muted-foreground" />
                                        Refresh
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="p-0">
                                <div className="max-h-[500px] overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent">
                                    {data.services.map((item, idx) => (
                                        <div key={item.name} className="group relative">
                                            <div className="flex items-end justify-between mb-2 text-sm">
                                                <div className="flex items-center gap-2 font-medium">
                                                    <div className={`w-3 h-3 rounded-md ${getServiceColor(idx)} shadow-sm`} />
                                                    {formatServiceName(item.name)}
                                                </div>
                                                <div className="text-right">
                                                    <div className="font-bold text-base">${item.cost.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                                                    <div className="text-xs text-muted-foreground">{getPercentage(item.cost, data.totalCost).toFixed(1)}% of total</div>
                                                </div>
                                            </div>
                                            <div className="h-3 w-full bg-muted/50 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full ${getServiceColor(idx)} rounded-full shadow-lg transition-all duration-1000 ease-out group-hover:brightness-110`}
                                                    style={{ width: `${getPercentage(item.cost, data.totalCost)}%` }}
                                                />
                                            </div>
                                        </div>
                                    ))}
                                    {data.services.length === 0 && (
                                        <div className="flex items-center justify-center h-40 text-muted-foreground italic">
                                            No service data available for this period.
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>

                        {/* RIGHT: Top Accounts or Detail */}
                        <div className="space-y-6">
                            {selectedAccountId === 'all' ? (
                                <Card className="border-none shadow-lg bg-card/50 backdrop-blur-sm h-full flex flex-col">
                                    <CardHeader className="border-b bg-muted/20 pb-4">
                                        <CardTitle className="text-lg">Cost by Account</CardTitle>
                                        <CardDescription>Ranked by contribution</CardDescription>
                                    </CardHeader>
                                    <CardContent className="flex-1 p-0 overflow-hidden">
                                        <div className="max-h-[500px] overflow-y-auto">
                                            {data.breakdownByAccount?.sort((a, b) => b.total - a.total).map((acc, i) => (
                                                <div
                                                    key={acc.id}
                                                    onClick={() => setSelectedAccountId(acc.id)}
                                                    className="flex items-center gap-3 p-4 border-b last:border-0 hover:bg-muted/50 transition-colors cursor-pointer group"
                                                >
                                                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 font-bold text-xs ring-4 ring-background">
                                                        {i + 1}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-medium truncate group-hover:text-primary transition-colors">{acc.name}</div>
                                                        <div className="text-xs text-muted-foreground truncate">Top: {acc.topService}</div>
                                                    </div>
                                                    <div className="text-right">
                                                        <div className="font-bold text-sm">${acc.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                                                        <div className="text-[10px] text-muted-foreground">{getPercentage(acc.total, data.totalCost).toFixed(0)}%</div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </CardContent>
                                </Card>
                            ) : (
                                <Card className="border-none shadow-lg bg-gradient-to-br from-blue-600 to-indigo-700 text-white">
                                    <CardHeader>
                                        <CardTitle className="text-white">Account Snapshot</CardTitle>
                                        <CardDescription className="text-blue-100">
                                            Quick focus view
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent className="space-y-6">
                                        <div className="space-y-1">
                                            <div className="text-xs uppercase tracking-widest opacity-70">Account Name</div>
                                            <div className="text-2xl font-bold">{accountsList.find(a => a.id === data.accountId)?.name || data.accountName || "Unknown"}</div>
                                        </div>
                                        <div className="space-y-1">
                                            <div className="text-xs uppercase tracking-widest opacity-70">Account ID</div>
                                            <div className="font-mono text-lg bg-white/10 p-2 rounded inline-block">
                                                {data.accountId}
                                            </div>
                                        </div>
                                        <div className="pt-4 border-t border-white/20">
                                            <Button
                                                variant="secondary"
                                                className="w-full bg-white text-blue-600 hover:bg-blue-50 border-none"
                                                onClick={() => setSelectedAccountId('all')}
                                            >
                                                Return to Global View
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    </div>

                    {/* NEW SECTION: Top Services Detailed List */}
                    <div className="grid gap-6">
                        <Card className="border-none shadow-lg bg-card/50 backdrop-blur-sm">
                            <CardHeader className="border-b bg-muted/20 pb-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <CardTitle className="text-lg">Top Cost Drivers</CardTitle>
                                        <CardDescription>Detailed breakdown of highest spending services</CardDescription>
                                    </div>
                                    <Button variant="ghost" size="sm" className="hidden sm:flex">
                                        Export CSV
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="p-0">
                                <div className="relative w-full overflow-auto">
                                    <table className="w-full caption-bottom text-sm text-left">
                                        <thead className="[&_tr]:border-b">
                                            <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                                                <th className="h-10 px-4 align-middle font-medium text-muted-foreground w-12 text-center">#</th>
                                                <th className="h-10 px-4 align-middle font-medium text-muted-foreground">Service Name</th>
                                                <th className="h-10 px-4 align-middle font-medium text-muted-foreground text-right">Cost ($)</th>
                                                <th className="h-10 px-4 align-middle font-medium text-muted-foreground text-right">% Impact</th>
                                                <th className="h-10 px-4 align-middle font-medium text-muted-foreground text-center w-24">Trend</th>
                                            </tr>
                                        </thead>
                                        <tbody className="[&_tr:last-child]:border-0">
                                            {data.services.slice(0, 10).map((svc, idx) => (
                                                <tr key={idx} className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                                                    <td className="p-4 align-middle text-center font-mono text-xs text-muted-foreground">{idx + 1}</td>
                                                    <td className="p-4 align-middle font-medium">{formatServiceName(svc.name)}</td>
                                                    <td className="p-4 align-middle text-right font-bold">${svc.cost.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                                                    <td className="p-4 align-middle text-right text-muted-foreground">{getPercentage(svc.cost, data.totalCost).toFixed(1)}%</td>
                                                    <td className="p-4 align-middle">
                                                        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                                                            <div
                                                                className={`h-full rounded-full ${getServiceColor(idx)}`}
                                                                style={{ width: `${getPercentage(svc.cost, data.totalCost)}%` }}
                                                            />
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                            {data.services.length === 0 && (
                                                <tr>
                                                    <td colSpan={5} className="p-4 text-center text-muted-foreground">No service data available.</td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}
        </div>
    );
};
