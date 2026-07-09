import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, PiggyBank, Receipt, ShieldCheck, TrendingDown } from "lucide-react";
import type { SavingsPlansData } from "@/types/finops";

interface SavingsPlansCardProps {
    data: SavingsPlansData;
}

export function SavingsPlansCard({ data }: SavingsPlansCardProps) {
    if (!data) {
        return null; // Hide if no SP data
    }

    const formatUsd = (value: number, compact = false) =>
        `$${value.toLocaleString('en-US', compact ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const formatPct = (value: number) => `${value.toFixed(1)}%`;
    const formatDate = (value: string | null | undefined) => {
        if (!value) {
            return "Sin fecha";
        }

        return new Intl.DateTimeFormat("es-ES", {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: "UTC",
        }).format(new Date(`${value}T00:00:00Z`));
    };
    const toInclusiveEndDate = (endExclusive: string) => {
        const date = new Date(`${endExclusive}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() - 1);
        return date.toISOString().split("T")[0];
    };

    const commitment = data.commitment ?? null;
    const inventoryAvailable = Boolean(commitment?.inventoryAvailable);
    const utilizationAvailable = Boolean(commitment?.utilizationAvailable && commitment?.utilization);
    const hasCommitmentSummary = Boolean(commitment && (inventoryAvailable || utilizationAvailable));
    const commitmentDiagnostics = [
        commitment?.inventoryError?.trim(),
        commitment?.utilizationError?.trim(),
    ].filter((message, index, list): message is string => Boolean(message) && list.indexOf(message) === index);
    const totalCoverage = data.totalCoverage || 0;
    const totalSavings = data.totalSavings || 0;
    const selectedAccountCount = data.selectedAccountCount || (data.byAccount || []).length;
    const visibleAccountCount = data.visibleAccountCount || (data.byAccount || []).length;
    const coveredAccountCount = data.coveredAccountCount || (data.byAccount || []).filter((account) => account.hasCoverage).length;
    const allVisibleAccounts = data.byAccount || [];
    const accountsWithSP = allVisibleAccounts.filter((account) => account.hasCoverage);
    const accountsWithoutSP = allVisibleAccounts.filter((account) => !account.hasCoverage);
    const totalOnDemandEquivalent = totalCoverage + totalSavings;
    const totalVisibleAccountCost = allVisibleAccounts.reduce((sum, account) => sum + account.totalCost, 0);
    const overallCoveragePct = totalVisibleAccountCost > 0 ? (totalCoverage / totalVisibleAccountCost) * 100 : 0;
    const accountsWithoutSPCount = Math.max(0, visibleAccountCount - coveredAccountCount);
    const shouldRender = hasCommitmentSummary || selectedAccountCount > 0 || visibleAccountCount > 0;

    if (!shouldRender) {
        return null;
    }

    return (
        <Card className="border-none shadow-lg">
            <CardHeader className="border-b bg-emerald-50/50 dark:bg-emerald-950/20">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <PiggyBank className="h-5 w-5 text-emerald-600" />
                        <CardTitle>Savings Plans</CardTitle>
                    </div>
                    <div className="text-right">
                        <div className="text-2xl font-bold text-emerald-600">
                            {formatUsd(totalSavings)}
                        </div>
                        <div className="text-xs text-muted-foreground">Ahorrado en este periodo</div>
                    </div>
                </div>
                <CardDescription>
                    {coveredAccountCount > 0
                        ? `Hay ahorro visible en ${coveredAccountCount} de ${selectedAccountCount} cuentas seleccionadas. El uso cubierto por Savings Plans te habria costado ${formatUsd(totalOnDemandEquivalent)} a precio on-demand, y con Savings Plans ha costado ${formatUsd(totalCoverage)}.`
                        : selectedAccountCount > 0
                            ? `No hay consumo cubierto por Savings Plans en las ${selectedAccountCount} cuentas seleccionadas para este rango.`
                            : "No hay cuentas visibles en el rango actual para Savings Plans."}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 p-5">
                {!commitment && (
                    <div className="rounded-2xl border border-amber-200/80 bg-amber-50/80 p-4 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
                        <div className="flex items-start gap-3">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                            <div>
                                <div className="font-semibold">Inventario vivo de Savings Plans no disponible</div>
                                <div className="mt-1 leading-6 text-amber-900/80 dark:text-amber-100/80">
                                    Esta vista si esta calculando el ahorro del periodo desde CUR, pero no ha podido recuperar desde la API de AWS el compromiso activo, la fecha de vencimiento o el saldo sin usar del periodo.
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {commitment && !inventoryAvailable && (
                    <div className="rounded-2xl border border-amber-200/80 bg-amber-50/80 p-4 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
                        <div className="flex items-start gap-3">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                            <div>
                                <div className="font-semibold">
                                    {utilizationAvailable
                                        ? "Inventario vivo de Savings Plans no disponible"
                                        : "AWS no ha devuelto detalle vivo de Savings Plans"}
                                </div>
                                <div className="mt-1 leading-6 text-amber-900/80 dark:text-amber-100/80">
                                    {utilizationAvailable
                                        ? "La vista si puede calcular el aprovechamiento del periodo, pero no ha conseguido leer desde AWS el inventario activo, el proximo vencimiento o el compromiso horario total."
                                        : "Esta vista si esta calculando el ahorro del periodo desde CUR, pero no ha podido recuperar desde la API de AWS el compromiso activo, la fecha de vencimiento o el saldo sin usar del periodo."}
                                </div>
                                {commitmentDiagnostics.length > 0 && (
                                    <div className="mt-2 text-xs leading-5 text-amber-950/80 dark:text-amber-100/80">
                                        AWS ha respondido: {commitmentDiagnostics.join(" | ")}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {commitment && hasCommitmentSummary && (
                    <div className="rounded-3xl border border-emerald-200/70 bg-gradient-to-r from-emerald-50 via-white to-emerald-50/70 p-4 shadow-sm dark:border-emerald-900/50 dark:from-emerald-950/20 dark:via-background dark:to-emerald-950/10">
                        <div className="flex flex-col gap-4">
                            <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                                <div>
                                    <div className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-300">
                                        Estado actual de la organizacion
                                    </div>
                                    <div className="mt-1 text-lg font-semibold text-foreground">
                                        {inventoryAvailable
                                            ? `Hoy tienes ${commitment.activePlans} Savings Plans activos con un compromiso aproximado de ${formatUsd(commitment.hourlyCommitment ?? 0)}/h.`
                                            : utilizationAvailable
                                                ? "AWS no esta devolviendo el inventario vivo del plan, pero si el aprovechamiento agregado del compromiso en este periodo."
                                                : "No se ha podido recuperar el detalle vivo de Savings Plans desde AWS."}
                                    </div>
                                    <div className="mt-2 text-sm leading-6 text-muted-foreground">
                                        {inventoryAvailable
                                            ? "Esta franja resume lo que sigue vivo ahora mismo en AWS. El detalle inferior sigue enseñando el ahorro del periodo y de las cuentas visibles."
                                            : "El detalle inferior sigue calculando el ahorro por cuenta desde CUR, y aqui arriba veras solo lo que AWS si ha podido devolver en tiempo real."}
                                    </div>
                                </div>
                                {(commitment.planTypes.length > 0 || commitment.paymentOptions.length > 0) && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        {commitment.planTypes.map((planType) => (
                                            <Badge key={planType} className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300">
                                                {planType}
                                            </Badge>
                                        ))}
                                        {commitment.paymentOptions.map((paymentOption) => (
                                            <Badge key={paymentOption} variant="outline" className="border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
                                                {paymentOption}
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                {inventoryAvailable ? (
                                    <>
                                        <div className="rounded-2xl border bg-background/80 p-4">
                                            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Planes activos hoy</div>
                                            <div className="mt-2 text-2xl font-bold">{commitment.activePlans}</div>
                                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                                Inventario activo a fecha de {formatDate(commitment.asOfDate)}.
                                            </p>
                                        </div>
                                        <div className="rounded-2xl border bg-background/80 p-4">
                                            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Compromiso aprox. al mes</div>
                                            <div className="mt-2 text-2xl font-bold">{formatUsd(commitment.estimatedMonthlyCommitment ?? 0, true)}</div>
                                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                                Referencia rapida basada en {formatUsd(commitment.hourlyCommitment ?? 0)}/h de compromiso total.
                                            </p>
                                        </div>
                                        <div className="rounded-2xl border bg-background/80 p-4">
                                            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Proximo vencimiento</div>
                                            <div className="mt-2 text-2xl font-bold">
                                                {commitment.nextExpirationDays != null ? `${commitment.nextExpirationDays} dias` : "N/D"}
                                            </div>
                                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                                {commitment.nextExpirationDate
                                                    ? `El plan mas cercano vence el ${formatDate(commitment.nextExpirationDate)}.`
                                                    : "AWS no ha devuelto una fecha de fin visible."}
                                            </p>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="rounded-2xl border bg-background/80 p-4">
                                            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Compromiso usado en periodo</div>
                                            <div className="mt-2 text-2xl font-bold">
                                                {commitment.utilization ? formatUsd(commitment.utilization.usedCommitment, true) : "N/D"}
                                            </div>
                                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                                Parte del compromiso que si se ha consumido en el rango seleccionado.
                                            </p>
                                        </div>
                                        <div className="rounded-2xl border bg-background/80 p-4">
                                            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Compromiso sin usar</div>
                                            <div className="mt-2 text-2xl font-bold">
                                                {commitment.utilization ? formatUsd(commitment.utilization.unusedCommitment, true) : "N/D"}
                                            </div>
                                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                                Lo que ha quedado sin aprovechar dentro del periodo consultado.
                                            </p>
                                        </div>
                                        <div className="rounded-2xl border bg-background/80 p-4">
                                            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Ahorro neto del periodo</div>
                                            <div className="mt-2 text-2xl font-bold">
                                                {commitment.utilization ? formatUsd(commitment.utilization.netSavings, true) : "N/D"}
                                            </div>
                                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                                Estimacion agregada que devuelve Cost Explorer para el rango seleccionado.
                                            </p>
                                        </div>
                                    </>
                                )}
                                <div className="rounded-2xl border bg-background/80 p-4">
                                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Aprovechamiento del periodo</div>
                                    <div className="mt-2 text-2xl font-bold">
                                        {commitment.utilization ? formatPct(commitment.utilization.utilizationPercentage) : "N/D"}
                                    </div>
                                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                        {commitment.utilization
                                            ? `Quedaron ${formatUsd(commitment.utilization.unusedCommitment, true)} sin usar entre ${formatDate(commitment.utilization.start)} y ${formatDate(toInclusiveEndDate(commitment.utilization.endExclusive))}.`
                                            : "No se ha podido recuperar la utilizacion de Savings Plans para este rango."}
                                    </p>
                                </div>
                            </div>

                            {commitment.utilization && (
                                <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50/70 p-4 text-sm text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-100">
                                    <div className="font-semibold">Como leer lo que queda</div>
                                    <div className="mt-1 leading-6 text-emerald-900/80 dark:text-emerald-100/80">
                                        En el periodo analizado se consumio {formatUsd(commitment.utilization.usedCommitment)} de un compromiso total de {formatUsd(commitment.utilization.totalCommitment)}.
                                        Eso deja {formatUsd(commitment.utilization.unusedCommitment)} de compromiso sin aprovechar y un ahorro neto estimado de {formatUsd(commitment.utilization.netSavings)}.
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl border bg-background/80 p-4">
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            <ShieldCheck className="h-4 w-4 text-emerald-600" />
                            Uso cubierto
                        </div>
                        <div className="mt-2 text-2xl font-bold">{formatUsd(totalCoverage, true)}</div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Parte del gasto que si entro dentro de Savings Plans.
                        </p>
                    </div>
                    <div className="rounded-2xl border bg-background/80 p-4">
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            <Receipt className="h-4 w-4 text-amber-600" />
                            Coste sin Savings Plans
                        </div>
                        <div className="mt-2 text-2xl font-bold">{formatUsd(totalOnDemandEquivalent, true)}</div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Lo que habrias pagado por ese mismo uso si todo fuese on-demand.
                        </p>
                    </div>
                    <div className="rounded-2xl border bg-background/80 p-4">
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            <TrendingDown className="h-4 w-4 text-emerald-600" />
                            Cobertura media visible
                        </div>
                        <div className="mt-2 text-2xl font-bold">{formatPct(overallCoveragePct)}</div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Porcentaje del gasto total de estas cuentas que ha quedado protegido por Savings Plans.
                        </p>
                    </div>
                    <div className="rounded-2xl border bg-background/80 p-4">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cuentas con cobertura</div>
                        <div className="mt-2 text-2xl font-bold">{coveredAccountCount}/{selectedAccountCount}</div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {accountsWithoutSPCount > 0
                                ? `${accountsWithoutSPCount} cuentas no han consumido Savings Plans en este periodo.`
                                : "Todas las cuentas visibles han consumido Savings Plans en este periodo."}
                        </p>
                    </div>
                </div>

                <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50/70 p-4 text-sm text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-100">
                    <div className="font-semibold">Como leer esta tarjeta</div>
                    <div className="mt-1 leading-6 text-emerald-900/80 dark:text-emerald-100/80">
                        "Cobertura" indica cuanto del gasto total de una cuenta ha pasado por Savings Plans. "Ahorro" compara solo el uso cubierto:
                        cuanto habrias pagado en on-demand frente a lo que realmente ha costado con el plan aplicado.
                    </div>
                </div>

                {accountsWithoutSPCount > 0 && (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-800 dark:bg-slate-950/20">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div>
                                <div className="font-semibold text-foreground">Cuentas sin uso cubierto en este periodo</div>
                                <div className="mt-1 text-sm leading-6 text-muted-foreground">
                                    {accountsWithoutSPCount} de {selectedAccountCount} cuentas seleccionadas no han aplicado Savings Plans dentro del rango consultado.
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {accountsWithoutSP.slice(0, 8).map((account) => (
                                    <Badge key={account.accountId} variant="outline" className="border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-300">
                                        {account.accountName}
                                    </Badge>
                                ))}
                                {accountsWithoutSPCount > 8 && (
                                    <Badge variant="outline" className="border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-300">
                                        +{accountsWithoutSPCount - 8} mas
                                    </Badge>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {accountsWithSP.length > 0 ? (
                    <>
                        <div className="space-y-3">
                            {accountsWithSP
                                .sort((a, b) => b.savings - a.savings)
                                .map((account) => {
                                    const uncoveredSpend = Math.max(0, account.totalCost - account.spCoveredCost);

                                    return (
                                        <div key={account.accountId} className="rounded-2xl border bg-background/80 p-4 shadow-sm transition-colors hover:bg-muted/20">
                                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                                <div className="flex-1">
                                                    <div className="font-medium text-sm">
                                                        {account.accountName}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {account.accountId}
                                                    </div>
                                                    <div className="mt-2 inline-flex rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                                                        De cada $100 gastados, ~${Math.round(account.coveragePercentage)} pasan por SP
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <div className="text-lg font-bold text-emerald-600">
                                                        {formatUsd(account.savings, true)}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {formatPct(account.savingsPercentage)} de descuento sobre el uso cubierto
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="mt-4 grid gap-3 md:grid-cols-4">
                                                <div className="rounded-xl border bg-muted/20 p-3">
                                                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Gasto total</div>
                                                    <div className="mt-1 text-base font-bold">{formatUsd(account.totalCost, true)}</div>
                                                </div>
                                                <div className="rounded-xl border bg-muted/20 p-3">
                                                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Cubierto por SP</div>
                                                    <div className="mt-1 text-base font-bold text-emerald-600">{formatUsd(account.spCoveredCost, true)}</div>
                                                </div>
                                                <div className="rounded-xl border bg-muted/20 p-3">
                                                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sin SP habrias pagado</div>
                                                    <div className="mt-1 text-base font-bold">{formatUsd(account.onDemandCost, true)}</div>
                                                </div>
                                                <div className="rounded-xl border bg-muted/20 p-3">
                                                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Fuera de SP</div>
                                                    <div className="mt-1 text-base font-bold">{formatUsd(uncoveredSpend, true)}</div>
                                                </div>
                                            </div>

                                            <div className="mt-4 space-y-2">
                                                <div className="flex items-center justify-between text-xs">
                                                    <span className="font-medium text-foreground">
                                                        Cobertura del gasto total de la cuenta
                                                    </span>
                                                    <span className="text-muted-foreground">
                                                        {formatPct(account.coveragePercentage)} cubierto
                                                    </span>
                                                </div>
                                                <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                                                    <div
                                                        className="h-full bg-emerald-500 transition-all duration-500"
                                                        style={{ width: `${Math.min(account.coveragePercentage, 100)}%` }}
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between text-xs text-muted-foreground">
                                                    <span>Con SP: {formatUsd(account.spCoveredCost, true)}</span>
                                                    <span>Fuera de SP: {formatUsd(uncoveredSpend, true)}</span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                        </div>
                    </>
                ) : (
                    <div className="rounded-2xl border border-dashed bg-muted/10 p-6 text-sm text-muted-foreground">
                        No se ha detectado uso cubierto por Savings Plans en las cuentas visibles dentro del rango seleccionado.
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
