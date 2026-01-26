import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } from '@aws-sdk/client-athena';
// TODO: Enable when Lambda has @aws-sdk/client-savingsplans dependency
// import pkg from '@aws-sdk/client-savingsplans';
// const { SavingsPlansClient, DescribeSavingsPlansCommand } = pkg;

const athenaClient = new AthenaClient({ region: 'eu-west-1' });
// const savingsPlansClient = new SavingsPlansClient({ region: 'us-east-1' }); // Temporarily disabled

export const handler = async (event) => {
    try {
        // Parse input - handle both direct invocation and HTTP events
        let parsedBody;
        if (event.body) {
            // HTTP event (API Gateway, Function URL)
            parsedBody = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        } else {
            // Direct invocation (test event)
            parsedBody = event;
        }
        const query = parsedBody.query || {};
        const accountIds = query.accountIds || 'all';
        const startDate = query.startDate;
        const endDate = query.endDate;
        const includeTrends = query.includeTrends !== false;

        if (!startDate || !endDate) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'startDate and endDate required' })
            };
        }

        // Parse account IDs
        let accountIdList = [];
        if (accountIds === 'all') {
            accountIdList = [
                '111122223333', '222233334444', '333344445555', '444455556666',
                '555566667777', '666677778888', '777788889999', '888899990000',
                '999900001111', '000011112222', '111222333444', '222333444555',
                '333444555666', '444555666777', '555666777888', '666777888999',
                '777888999000', '888999000111', '999000111222', '100200300400',
                '200300400500', '300400500600', '400500600700', '500600700800'
            ];
        } else {
            accountIdList = accountIds.split(',').map(id => id.trim());
        }

        // Calculate previous period
        let prevStartDate, prevEndDate;
        if (includeTrends) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
            prevEndDate = new Date(start);
            prevEndDate.setDate(prevEndDate.getDate() - 1);
            prevStartDate = new Date(prevEndDate);
            prevStartDate.setDate(prevStartDate.getDate() - diffDays + 1);
            prevStartDate = prevStartDate.toISOString().split('T')[0];
            prevEndDate = prevEndDate.toISOString().split('T')[0];
        }

        const accountIdsStr = accountIdList.map(id => `'${id}'`).join(',');

        // Build SQL queries
        const currentQuery = `
SELECT 
  line_item_usage_account_id as account_id,
  line_item_product_code as service,
  SUM(line_item_unblended_cost) as cost
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${startDate}'
  AND line_item_usage_start_date < DATE '${endDate}'
  AND line_item_line_item_type IN ('Usage','Tax','Fee')
  AND line_item_usage_account_id IN (${accountIdsStr})
GROUP BY 1,2
ORDER BY 1,cost DESC;
`;

        const previousQuery = includeTrends ? `
SELECT 
  line_item_usage_account_id as account_id,
  line_item_product_code as service,
  SUM(line_item_unblended_cost) as cost
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${prevStartDate}'
  AND line_item_usage_start_date < DATE '${prevEndDate}'
  AND line_item_line_item_type IN ('Usage','Tax','Fee')
  AND line_item_usage_account_id IN (${accountIdsStr})
GROUP BY 1,2;
` : null;

        // Savings Plans query - Enhanced with savings calculation
        const savingsPlansQuery = `
SELECT 
  line_item_usage_account_id as account_id,
  SUM(savings_plan_savings_plan_effective_cost) as sp_covered_cost,
  SUM(pricing_public_on_demand_cost) as on_demand_cost,
  SUM(line_item_unblended_cost) as total_cost,
  COUNT(*) as line_items
FROM athenacurcfn_finnops.data
WHERE savings_plan_savings_plan_a_r_n IS NOT NULL
  AND line_item_usage_start_date >= DATE '${startDate}'
  AND line_item_usage_start_date < DATE '${endDate}'
  AND line_item_usage_account_id IN (${accountIdsStr})
GROUP BY 1
ORDER BY sp_covered_cost DESC;
`;

        // Execute queries
        const currentResults = await executeAthenaQuery(currentQuery);
        const previousResults = includeTrends ? await executeAthenaQuery(previousQuery) : [];
        const savingsPlansResults = await executeSavingsPlansQuery(savingsPlansQuery);

        // Get Savings Plans commitment info
        const savingsPlansCommitment = await getSavingsPlansCommitment();

        // TODO: Move to environment variable - AWS_ACCOUNT_NAMES
        // Format: JSON.parse(process.env.AWS_ACCOUNT_NAMES || '{}')
        // Example: {"123456789012": "Production", "987654321098": "Development"}
        const accountNames = {
            '111122223333': 'EKS Dev / Default', '222233334444': 'EKS UAT', '333344445555': 'EKS Prod',
            '444455556666': 'EKS Tooling', '555566667777': 'App Dev', '666677778888': 'App UAT',
            '777788889999': 'App Prod', '888899990000': 'Ecommerce', '999900001111': 'Dev',
            '000011112222': 'UAT', '111222333444': 'Production', '222333444555': 'Staging',
            '333444555666': 'Commerce', '444555666777': 'Retail Dev', '555666777888': 'Retail UAT',
            '666777888999': 'Retail Prod', '777888999000': 'Analytics Dev', '888999000111': 'Analytics Prod',
            '999000111222': 'Monitoring', '100200300400': 'Data Dev', '200300400500': 'Data Prod',
            '300400500600': 'Infrastructure', '400500600700': 'Platform', '500600700800': 'Systems'
        };

        // Transform data
        const accountMap = {}, prevAccountMap = {};
        currentResults.forEach(r => {
            if (!accountMap[r.account_id]) accountMap[r.account_id] = { services: {}, total: 0 };
            accountMap[r.account_id].services[r.service] = r.cost;
            accountMap[r.account_id].total += r.cost;
        });
        previousResults.forEach(r => {
            if (!prevAccountMap[r.account_id]) prevAccountMap[r.account_id] = { services: {} };
            prevAccountMap[r.account_id].services[r.service] = r.cost;
        });

        const accounts = [], allServices = {};
        let totalCost = 0, totalPrevCost = 0;

        Object.keys(accountMap).forEach(accId => {
            const current = accountMap[accId], previous = prevAccountMap[accId] || { services: {} };
            const services = [];

            Object.keys(current.services).forEach(svc => {
                const currentCost = current.services[svc], prevCost = previous.services[svc] || 0;
                const change = currentCost - prevCost, percentage = prevCost > 0 ? (change / prevCost) * 100 : 0;
                services.push({ name: svc, cost: parseFloat(currentCost.toFixed(2)), percentage: (currentCost / current.total) * 100, trend: { change: parseFloat(change.toFixed(2)), percentage: parseFloat(percentage.toFixed(2)) } });
                if (!allServices[svc]) allServices[svc] = { current: 0, previous: 0 };
                allServices[svc].current += currentCost; allServices[svc].previous += prevCost;
            });

            services.sort((a, b) => b.cost - a.cost);
            const topService = services[0] || { name: 'None', cost: 0 };
            const prevTotal = Object.values(previous.services).reduce((sum, c) => sum + c, 0);

            accounts.push({
                accountId: accId, accountName: accountNames[accId] || accId, totalCost: parseFloat(current.total.toFixed(2)),
                trend: { change: parseFloat((current.total - prevTotal).toFixed(2)), percentage: prevTotal > 0 ? parseFloat(((current.total - prevTotal) / prevTotal * 100).toFixed(2)) : 0 },
                topService: { name: topService.name, cost: parseFloat(topService.cost.toFixed(2)), percentage: parseFloat(((topService.cost / current.total) * 100).toFixed(2)) },
                services
            });

            totalCost += current.total; totalPrevCost += prevTotal;
        });

        const serviceChanges = Object.keys(allServices).map(svc => ({
            service: svc,
            change: parseFloat((allServices[svc].current - allServices[svc].previous).toFixed(2)),
            percentage: allServices[svc].previous > 0 ? parseFloat(((allServices[svc].current - allServices[svc].previous) / allServices[svc].previous * 100).toFixed(2)) : 0
        }));
        serviceChanges.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

        const globalServices = Object.keys(allServices).map(svc => ({ name: svc, cost: allServices[svc].current, prevCost: allServices[svc].previous })).sort((a, b) => b.cost - a.cost);
        const topGlobalService = globalServices[0] || { name: 'None', cost: 0, prevCost: 0 };

        const response = {
            executionTime: 0, dataScanned: '0 GB',
            dateRange: { start: startDate, end: endDate },
            summary: {
                totalCost: parseFloat(totalCost.toFixed(2)),
                accountCount: accounts.length,
                topService: {
                    name: topGlobalService.name,
                    cost: parseFloat(topGlobalService.cost.toFixed(2)),
                    trend: { change: parseFloat((topGlobalService.cost - topGlobalService.prevCost).toFixed(2)), percentage: topGlobalService.prevCost > 0 ? parseFloat(((topGlobalService.cost - topGlobalService.prevCost) / topGlobalService.prevCost * 100).toFixed(2)) : 0 }
                }
            },
            accounts: accounts.sort((a, b) => b.totalCost - a.totalCost),
            topMovers: { increases: serviceChanges.filter(s => s.change > 0).slice(0, 5), decreases: serviceChanges.filter(s => s.change < 0).slice(0, 5) },
            savingsPlans: {
                totalCoverage: parseFloat(savingsPlansResults.reduce((sum, r) => sum + r.sp_covered_cost, 0).toFixed(2)),
                totalSavings: parseFloat(savingsPlansResults.reduce((sum, r) => sum + (r.on_demand_cost - r.sp_covered_cost), 0).toFixed(2)),
                commitment: savingsPlansCommitment,
                byAccount: savingsPlansResults.map(r => {
                    // Find the matching account from main query to get real total cost
                    const accountData = accounts.find(acc => acc.accountId === r.account_id);
                    const realTotalCost = accountData ? accountData.totalCost : r.total_cost;
                    const savings = r.on_demand_cost - r.sp_covered_cost;

                    return {
                        accountId: r.account_id,
                        accountName: accountNames[r.account_id] || r.account_id,
                        spCoveredCost: parseFloat(r.sp_covered_cost.toFixed(2)),
                        onDemandCost: parseFloat(r.on_demand_cost.toFixed(2)),
                        savings: parseFloat(savings.toFixed(2)),
                        savingsPercentage: r.on_demand_cost > 0 ? parseFloat(((savings / r.on_demand_cost) * 100).toFixed(2)) : 0,
                        totalCost: realTotalCost,
                        coveragePercentage: realTotalCost > 0 ? parseFloat(((r.sp_covered_cost / realTotalCost) * 100).toFixed(2)) : 0,
                        lineItems: r.line_items
                    };
                })
            }
        };

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify(response)
        };

    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: error.message })
        };
    }
};

async function executeAthenaQuery(queryString) {
    // TODO: Move to environment variables
    // Database: process.env.ATHENA_DATABASE || 'your_database'
    // S3 Bucket: process.env.ATHENA_RESULTS_BUCKET || 's3://your-bucket/results/'
    const startCommand = new StartQueryExecutionCommand({
        QueryString: queryString,
        QueryExecutionContext: { Database: 'athenacurcfn_finnops' },
        ResultConfiguration: { OutputLocation: 's3://finnops-iskaypet/athena-query-results/' }
    });

    const startResult = await athenaClient.send(startCommand);
    const queryId = startResult.QueryExecutionId;

    let status = 'RUNNING';
    let attempts = 0;
    const maxAttempts = 60;

    while ((status === 'RUNNING' || status === 'QUEUED') && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));

        const statusCommand = new GetQueryExecutionCommand({ QueryExecutionId: queryId });
        const statusResult = await athenaClient.send(statusCommand);
        status = statusResult.QueryExecution.Status.State;
        attempts++;

        if (status === 'FAILED' || status === 'CANCELLED') {
            throw new Error(`Query failed: ${statusResult.QueryExecution.Status.StateChangeReason}`);
        }
    }

    if (status !== 'SUCCEEDED') {
        throw new Error('Query timeout');
    }

    const resultsCommand = new GetQueryResultsCommand({ QueryExecutionId: queryId });
    const resultsResult = await athenaClient.send(resultsCommand);
    const rows = resultsResult.ResultSet.Rows || [];

    if (rows.length <= 1) return [];

    return rows.slice(1).map(row => ({
        account_id: row.Data[0]?.VarCharValue || '',
        service: row.Data[1]?.VarCharValue || '',
        cost: parseFloat(row.Data[2]?.VarCharValue || '0')
    }));
}

async function executeSavingsPlansQuery(queryString) {
    const startCommand = new StartQueryExecutionCommand({
        QueryString: queryString,
        QueryExecutionContext: { Database: 'athenacurcfn_finnops' },
        ResultConfiguration: { OutputLocation: 's3://finnops-iskaypet/athena-query-results/' }
    });

    const startResult = await athenaClient.send(startCommand);
    const queryId = startResult.QueryExecutionId;

    let status = 'RUNNING';
    let attempts = 0;
    const maxAttempts = 60;

    while ((status === 'RUNNING' || status === 'QUEUED') && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));

        const statusCommand = new GetQueryExecutionCommand({ QueryExecutionId: queryId });
        const statusResult = await athenaClient.send(statusCommand);
        status = statusResult.QueryExecution.Status.State;
        attempts++;

        if (status === 'FAILED' || status === 'CANCELLED') {
            throw new Error(`Query failed: ${statusResult.QueryExecution.Status.StateChangeReason}`);
        }
    }

    if (status !== 'SUCCEEDED') {
        throw new Error('Query timeout');
    }

    const resultsCommand = new GetQueryResultsCommand({ QueryExecutionId: queryId });
    const resultsResult = await athenaClient.send(resultsCommand);
    const rows = resultsResult.ResultSet.Rows || [];

    if (rows.length <= 1) return [];

    return rows.slice(1).map(row => ({
        account_id: row.Data[0]?.VarCharValue || '',
        sp_covered_cost: parseFloat(row.Data[1]?.VarCharValue || '0'),
        on_demand_cost: parseFloat(row.Data[2]?.VarCharValue || '0'),
        total_cost: parseFloat(row.Data[3]?.VarCharValue || '0'),
        line_items: parseInt(row.Data[4]?.VarCharValue || '0', 10)
    }));
}

async function getSavingsPlansCommitment() {
    try {
        const command = new DescribeSavingsPlansCommand({
            savingsPlanIds: ['dae0756e-c1b1-465a-a5a0-c48a1927ddb5']
        });

        const response = await savingsPlansClient.send(command);

        if (!response.savingsPlans || response.savingsPlans.length === 0) {
            return null;
        }

        const sp = response.savingsPlans[0];

        // Calculate monthly commitment based on hourly commitment
        const hourlyCommitment = parseFloat(sp.commitment || 0);
        const hoursInMonth = 730; // Average hours in a month
        const monthlyCommitment = hourlyCommitment * hoursInMonth;

        return {
            savingsPlanId: sp.savingsPlanId,
            savingsPlanArn: sp.savingsPlanArn,
            hourlyCommitment: parseFloat(hourlyCommitment.toFixed(4)),
            monthlyCommitment: parseFloat(monthlyCommitment.toFixed(2)),
            paymentOption: sp.paymentOption,
            savingsPlanType: sp.savingsPlanType,
            startTime: sp.start,
            endTime: sp.end,
            state: sp.state,
            recurringPayment: parseFloat(sp.recurringPaymentAmount || 0),
            upfrontPayment: parseFloat(sp.upfrontPaymentAmount || 0)
        };
    } catch (error) {
        console.error('Error fetching Savings Plans commitment:', error);
        return null;
    }
}
