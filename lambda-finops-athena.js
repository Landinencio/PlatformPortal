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
                '933315498976', '656056379995', '000339436598', '012966899965',
                '850014722158', '863836597839', '484517523926', '343444108351',
                '178558647998', '425981549652', '722677935098', '095812636847',
                '496588051783', '531709726950', '211125399788', '539960941758',
                '176692871045', '006157029960', '138724810358', '590222455071',
                '615170114703', '307516957806', '801185562308', '194193179595'
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

        // Savings Plans query
        const savingsPlansQuery = `
SELECT 
  line_item_usage_account_id as account_id,
  SUM(savings_plan_savings_plan_effective_cost) as sp_covered_cost,
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

        // Account name mapping
        const accountNames = {
            '933315498976': 'EKS Dev / Default', '656056379995': 'EKS UAT', '000339436598': 'EKS Prod',
            '012966899965': 'EKS Tooling', '850014722158': 'Helios Dev', '863836597839': 'Helios UAT',
            '484517523926': 'Helios Prod', '343444108351': 'Digital Ecommerce', '178558647998': 'Digital Dev',
            '425981549652': 'Digital UAT', '722677935098': 'Digital Prod', '095812636847': 'Ecommerce Tiendanimal',
            '496588051783': 'IskayPet Ecommerce', '531709726950': 'Retail Dev', '211125399788': 'Retail UAT',
            '539960941758': 'Retail Prod', '176692871045': 'Animalis Dev', '006157029960': 'Animalis Prod',
            '138724810358': 'Clinicanimal', '590222455071': 'Data Dev', '615170114703': 'IskayPet Data',
            '307516957806': 'Infra', '801185562308': 'SAP', '194193179595': 'Sistemas Tiendanimal'
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
                commitment: savingsPlansCommitment,
                byAccount: savingsPlansResults.map(r => {
                    // Find the matching account from main query to get real total cost
                    const accountData = accounts.find(acc => acc.accountId === r.account_id);
                    const realTotalCost = accountData ? accountData.totalCost : r.total_cost;

                    return {
                        accountId: r.account_id,
                        accountName: accountNames[r.account_id] || r.account_id,
                        spCoveredCost: parseFloat(r.sp_covered_cost.toFixed(2)),
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
        total_cost: parseFloat(row.Data[2]?.VarCharValue || '0'),
        line_items: parseInt(row.Data[3]?.VarCharValue || '0', 10)
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
