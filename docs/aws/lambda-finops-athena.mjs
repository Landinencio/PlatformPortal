import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } from '@aws-sdk/client-athena';
import { createRequire } from 'module';

const athenaClient = new AthenaClient({ region: 'eu-west-1' });
const require = createRequire(import.meta.url);

const STATIC_ACCOUNT_CATALOG = [
  { id: '999000111222', name: 'Clinicanimal', email: 'redacted@example.com' },
  { id: '100200300400', name: 'Data desarrollo', email: 'redacted@example.com' },
  { id: '999900001111', name: 'Digital Dev', email: 'redacted@example.com' },
  { id: '888899990000', name: 'Digital Ecommerce', email: 'redacted@example.com' },
  { id: '111222333444', name: 'Digital Prod', email: 'redacted@example.com' },
  { id: '000011112222', name: 'Digital UAT', email: 'redacted@example.com' },
  { id: '222333444555', name: 'Ecommerce Tiendanimal', email: 'sysadmin_aws@tiendanimal.es' },
  { id: '111122223333', name: 'EKS Dev', email: 'redacted@example.com' },
  { id: '333344445555', name: 'EKS Prod', email: 'redacted@example.com' },
  { id: '444455556666', name: 'EKS Tooling', email: 'redacted@example.com' },
  { id: '222233334444', name: 'EKS UAT', email: 'redacted@example.com' },
  { id: '666677778888', name: 'Helios UAT', email: 'redacted@example.com' },
  { id: '555566667777', name: 'HeliosDev', email: 'redacted@example.com' },
  { id: '777788889999', name: 'HeliosProd', email: 'redacted@example.com' },
  { id: '300400500600', name: 'infraestructura', email: 'redacted@example.com' },
  { id: '200300400500', name: 'Iskaypet Data', email: 'redacted@example.com' },
  { id: '333444555666', name: 'Iskaypet Ecommerce', email: 'redacted@example.com' },
  { id: '444555666777', name: 'Retail Dev', email: 'redacted@example.com' },
  { id: '666777888999', name: 'Retail Prod', email: 'redacted@example.com' },
  { id: '555666777888', name: 'RetailUAT', email: 'redacted@example.com' },
  { id: '600700800900', name: 'Root Iskaypet', email: 'redacted@example.com' },
  { id: '700800900100', name: 'Sandbox Backoffice', email: 'redacted@example.com' },
  { id: '800900100200', name: 'Sandbox Data', email: 'redacted@example.com' },
  { id: '900100200300', name: 'Sandbox Digital', email: 'redacted@example.com' },
  { id: '100300500700', name: 'Sandbox Infra&SRE', email: 'redacted@example.com' },
  { id: '200400600800', name: 'Sandbox Retail', email: 'redacted@example.com' },
  { id: '400500600700', name: 'SAP', email: 'redacted@example.com' },
  { id: '500600700800', name: 'Sistemas Tiendanimal', email: 'redacted@example.com' }
];

const ACCOUNT_NAMES = STATIC_ACCOUNT_CATALOG.reduce((acc, account) => {
  acc[account.id] = account.name;
  return acc;
}, {});

// Environment classification based on account name patterns
function classifyAccountEnvironment(accountName) {
  const lower = (accountName || '').toLowerCase();
  if (lower.includes('prod') || lower === 'iskaypet data' || lower === 'iskaypet ecommerce'
    || lower === 'ecommerce tiendanimal' || lower === 'clinicanimal' || lower === 'sap'
    || lower === 'sistemas tiendanimal' || lower === 'infraestructura') return 'Production';
  if (lower.includes('uat') || lower.includes('pre')) return 'UAT';
  if (lower.includes('dev') || lower.includes('desarrollo')) return 'Development';
  if (lower.includes('sandbox')) return 'Sandbox';
  if (lower.includes('tooling')) return 'Tooling';
  if (lower.includes('root')) return 'Management';
  return 'Other';
}

const ACCOUNT_EMAILS = STATIC_ACCOUNT_CATALOG.reduce((acc, account) => {
  if (account.email) {
    acc[account.id] = account.email;
  }
  return acc;
}, {});

function accountIdsToSql(list) {
  return list.map(id => `'${id}'`).join(',');
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}

const COST_LINE_ITEM_TYPES = "'Usage','Tax','Fee'";
const DAY_MS = 24 * 60 * 60 * 1000;
const BILLING_REGION = 'us-east-1';
const AVERAGE_HOURS_PER_MONTH = 730;
const ACCOUNT_CATALOG_TTL_MS = 10 * 60 * 1000;
let billingClientsPromise = null;
let accountCatalogPromise = null;
let accountCatalogCache = null;
let accountCatalogExpiresAt = 0;

function parseUtcDate(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date: ${value}`);
  }

  return new Date(Date.UTC(year, month - 1, day));
}

function formatUtcDate(date) {
  return date.toISOString().split('T')[0];
}

function roundMoney(value) {
  return parseFloat((Number(value) || 0).toFixed(2));
}

function roundRatio(value) {
  return parseFloat((Number(value) || 0).toFixed(1));
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function createUtcDateClamped(year, monthIndex, day) {
  const normalizedMonth = new Date(Date.UTC(year, monthIndex, 1));
  const normalizedYear = normalizedMonth.getUTCFullYear();
  const normalizedMonthIndex = normalizedMonth.getUTCMonth();
  const lastDay = new Date(Date.UTC(normalizedYear, normalizedMonthIndex + 1, 0)).getUTCDate();

  return new Date(Date.UTC(normalizedYear, normalizedMonthIndex, Math.min(day, lastDay)));
}

function addUtcMonths(date, months) {
  return createUtcDateClamped(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate());
}

function startOfUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function isSameUtcMonth(left, right) {
  return left.getUTCFullYear() === right.getUTCFullYear()
    && left.getUTCMonth() === right.getUTCMonth();
}

function isFirstDayOfUtcMonth(date) {
  return date.getUTCDate() === 1;
}

function isLastDayOfUtcMonth(date) {
  return date.getUTCDate() === endOfUtcMonth(date).getUTCDate();
}

function differenceInUtcDaysInclusive(start, end) {
  return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

function differenceInUtcMonthsInclusive(start, end) {
  return ((end.getUTCFullYear() - start.getUTCFullYear()) * 12)
    + (end.getUTCMonth() - start.getUTCMonth())
    + 1;
}

function formatMonthLabel(date) {
  return new Intl.DateTimeFormat('es-ES', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(date);
}

function isBeforeUtcDate(left, right) {
  return left.getTime() < right.getTime();
}

function startOfUtcToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function parseAwsNumber(value) {
  return Number.parseFloat(value || '0') || 0;
}

function describeAwsError(error) {
  const name = String(error?.name || error?.code || '').trim();
  const message = String(error?.message || error || '').trim();

  if (name && message && !message.startsWith(name)) {
    return `${name}: ${message}`;
  }

  return message || name || 'Unknown AWS error';
}

async function getBillingClients() {
  if (!billingClientsPromise) {
    billingClientsPromise = (async () => {
      const result = {
        mode: 'v3',
        savingsPlansClient: null,
        DescribeSavingsPlansCommand: null,
        costExplorerClient: null,
        GetSavingsPlansUtilizationCommand: null,
        organizationsClient: null,
        ListAccountsCommand: null,
      };

      // Cost Explorer — should always be available in Lambda runtime
      try {
        const costExplorerPkg = await import('@aws-sdk/client-cost-explorer');
        result.costExplorerClient = new costExplorerPkg.CostExplorerClient({ region: BILLING_REGION });
        result.GetSavingsPlansUtilizationCommand = costExplorerPkg.GetSavingsPlansUtilizationCommand;
      } catch (err) {
        console.warn('Cost Explorer client not available:', err?.message);
      }

      // Organizations — may not be in Lambda runtime
      try {
        const organizationsPkg = await import('@aws-sdk/client-organizations');
        result.organizationsClient = new organizationsPkg.OrganizationsClient({ region: BILLING_REGION });
        result.ListAccountsCommand = organizationsPkg.ListAccountsCommand;
      } catch (err) {
        console.warn('Organizations client not available:', err?.message);
      }

      // Savings Plans — often NOT in Lambda runtime
      try {
        const savingsPlansPkg = await import('@aws-sdk/client-savingsplans');
        result.savingsPlansClient = new savingsPlansPkg.SavingsPlansClient({ region: BILLING_REGION });
        result.DescribeSavingsPlansCommand = savingsPlansPkg.DescribeSavingsPlansCommand;
      } catch (err) {
        console.warn('Savings Plans client not available (will skip SP inventory):', err?.message);
      }

      if (!result.costExplorerClient) {
        throw new Error('Cost Explorer client is required but failed to load');
      }

      return result;
    })();
  }

  return billingClientsPromise;
}

async function describeSavingsPlansApi(clients, input) {
  if (!clients.savingsPlansClient || !clients.DescribeSavingsPlansCommand) {
    throw new Error('Savings Plans client not available in this runtime');
  }
  return clients.savingsPlansClient.send(new clients.DescribeSavingsPlansCommand(input));
}

async function getSavingsPlansUtilizationApi(clients, input) {
  if (!clients.costExplorerClient || !clients.GetSavingsPlansUtilizationCommand) {
    throw new Error('Cost Explorer client not available');
  }
  return clients.costExplorerClient.send(new clients.GetSavingsPlansUtilizationCommand(input));
}

async function listOrganizationAccountsApi(clients, input) {
  if (!clients.organizationsClient || !clients.ListAccountsCommand) {
    throw new Error('Organizations client not available in this runtime');
  }
  return clients.organizationsClient.send(new clients.ListAccountsCommand(input));
}

function mergeAccountRecords(target, account) {
  const existing = target.get(account.id) || {};
  const nextName = account.name && account.name !== account.id
    ? account.name
    : existing.name || ACCOUNT_NAMES[account.id] || account.id;
  target.set(account.id, {
    ...existing,
    ...account,
    id: account.id,
    name: nextName,
    email: account.email || existing.email || ACCOUNT_EMAILS[account.id] || null
  });
}

function buildAccountNameMap(accounts) {
  return accounts.reduce((acc, account) => {
    acc[account.id] = account.name;
    return acc;
  }, {});
}

function getAccountStatusPriority(status) {
  switch (String(status || '').toUpperCase()) {
    case 'ACTIVE':
      return 0;
    case 'SUSPENDED':
      return 1;
    case 'PENDING_CLOSURE':
      return 2;
    case 'HISTORIC':
      return 3;
    case 'STATIC':
      return 4;
    default:
      return 5;
  }
}

async function listRecentCurAccountIds() {
  const lookbackStart = formatUtcDate(startOfUtcMonth(addUtcMonths(startOfUtcToday(), -13)));
  const query = `
SELECT DISTINCT
  line_item_usage_account_id AS account_id
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${lookbackStart}'
  AND line_item_usage_account_id IS NOT NULL
  AND TRIM(line_item_usage_account_id) != '';
`;

  const rows = await executeGenericAthenaQuery(query, ['account_id']);
  return rows
    .map((row) => row.account_id)
    .filter(Boolean);
}

async function resolveAccountCatalog(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && accountCatalogCache && now < accountCatalogExpiresAt) {
    return accountCatalogCache;
  }

  if (!forceRefresh && accountCatalogPromise) {
    return accountCatalogPromise;
  }

  accountCatalogPromise = (async () => {
    const catalog = new Map();

    Object.entries(ACCOUNT_NAMES).forEach(([id, name]) => {
      mergeAccountRecords(catalog, {
        id,
        name,
        email: ACCOUNT_EMAILS[id] || null,
        status: 'STATIC',
        source: 'static'
      });
    });

    try {
      const clients = await getBillingClients();
      let nextToken;

      do {
        const response = await listOrganizationAccountsApi(clients, {
          MaxResults: 20,
          ...(nextToken ? { NextToken: nextToken } : {})
        });

        const accounts = response.Accounts || response.accounts || [];
        accounts.forEach((account) => {
          const id = account.Id || account.id;
          if (!id) return;

          const status = account.State || account.Status || account.state || account.status || 'UNKNOWN';
          if (String(status).toUpperCase() === 'CLOSED') {
            return;
          }

          mergeAccountRecords(catalog, {
            id,
            name: account.Name || account.name || ACCOUNT_NAMES[id] || id,
            email: account.Email || account.email || null,
            status,
            source: 'organizations'
          });
        });

        nextToken = response.NextToken || response.nextToken;
      } while (nextToken);
    } catch (error) {
      console.warn('Unable to fetch AWS Organizations account catalog:', error?.message || error);
    }

    try {
      const curAccountIds = await listRecentCurAccountIds();
      curAccountIds.forEach((accountId) => {
        if (!catalog.has(accountId)) {
          mergeAccountRecords(catalog, {
            id: accountId,
            name: ACCOUNT_NAMES[accountId] || accountId,
            status: 'HISTORIC',
            source: 'cur'
          });
        }
      });
    } catch (error) {
      console.warn('Unable to enrich account catalog from CUR:', error?.message || error);
    }

    const accounts = [...catalog.values()].sort((left, right) => {
      const priorityDiff = getAccountStatusPriority(left.status) - getAccountStatusPriority(right.status);
      if (priorityDiff !== 0) return priorityDiff;
      return left.name.localeCompare(right.name);
    });

    accountCatalogCache = accounts;
    accountCatalogExpiresAt = Date.now() + ACCOUNT_CATALOG_TTL_MS;
    accountCatalogPromise = null;
    return accounts;
  })().catch((error) => {
    accountCatalogPromise = null;
    throw error;
  });

  return accountCatalogPromise;
}

async function resolveRequestedAccounts(accountIds) {
  const accountCatalog = await resolveAccountCatalog();
  const accountNameMap = buildAccountNameMap(accountCatalog);

  if (accountIds === 'all') {
    return {
      accountCatalog,
      accountIds: accountCatalog.map((account) => account.id),
      accountNameMap
    };
  }

  const selectedIds = [...new Set(String(accountIds || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean))];

  selectedIds.forEach((accountId) => {
    if (!accountNameMap[accountId]) {
      accountNameMap[accountId] = ACCOUNT_NAMES[accountId] || accountId;
    }
  });

  return {
    accountCatalog,
    accountIds: selectedIds,
    accountNameMap
  };
}

function resolveSavingsPlansUtilizationWindow(startDate, endDate) {
  const today = startOfUtcToday();
  const selectedStart = parseUtcDate(startDate);
  const selectedEndExclusive = addUtcDays(parseUtcDate(endDate), 1);
  const effectiveEndExclusive = isBeforeUtcDate(selectedEndExclusive, today) ? selectedEndExclusive : today;

  if (effectiveEndExclusive.getTime() > selectedStart.getTime()) {
    return {
      start: formatUtcDate(selectedStart),
      endExclusive: formatUtcDate(effectiveEndExclusive)
    };
  }

  const fallbackEndExclusive = today;
  const fallbackStart = startOfUtcMonth(addUtcDays(today, -1));
  return {
    start: formatUtcDate(fallbackStart),
    endExclusive: formatUtcDate(fallbackEndExclusive)
  };
}

function resolveComparisonPeriod(startDate, endDate) {
  const currentStart = parseUtcDate(startDate);
  const currentEnd = parseUtcDate(endDate);

  if (currentEnd.getTime() < currentStart.getTime()) {
    throw new Error('endDate must be greater than or equal to startDate');
  }

  const sameMonth = isSameUtcMonth(currentStart, currentEnd);
  const fullMonthRange = isFirstDayOfUtcMonth(currentStart) && isLastDayOfUtcMonth(currentEnd);

  let previousStart;
  let previousEnd;
  let mode;

  if (fullMonthRange) {
    const monthsInRange = differenceInUtcMonthsInclusive(currentStart, currentEnd);
    previousStart = startOfUtcMonth(addUtcMonths(currentStart, -monthsInRange));
    previousEnd = endOfUtcMonth(addUtcMonths(currentStart, -1));
    mode = monthsInRange === 1 ? 'previous_full_month' : 'previous_full_month_block';
  } else if (sameMonth) {
    const previousMonthAnchor = addUtcMonths(currentStart, -1);
    const previousMonthYear = previousMonthAnchor.getUTCFullYear();
    const previousMonthIndex = previousMonthAnchor.getUTCMonth();
    previousStart = createUtcDateClamped(previousMonthYear, previousMonthIndex, currentStart.getUTCDate());
    previousEnd = createUtcDateClamped(previousMonthYear, previousMonthIndex, currentEnd.getUTCDate());
    mode = currentStart.getUTCDate() === 1 ? 'same_days_previous_month' : 'same_window_previous_month';
  } else {
    const daysInRange = differenceInUtcDaysInclusive(currentStart, currentEnd);
    previousEnd = addUtcDays(currentStart, -1);
    previousStart = addUtcDays(previousEnd, -(daysInRange - 1));
    mode = 'previous_equivalent_window';
  }

  return {
    mode,
    current: {
      start: formatUtcDate(currentStart),
      end: formatUtcDate(currentEnd),
      days: differenceInUtcDaysInclusive(currentStart, currentEnd)
    },
    previous: {
      start: formatUtcDate(previousStart),
      end: formatUtcDate(previousEnd),
      days: differenceInUtcDaysInclusive(previousStart, previousEnd)
    },
    queries: {
      current: {
        start: formatUtcDate(currentStart),
        endExclusive: formatUtcDate(addUtcDays(currentEnd, 1))
      },
      previous: {
        start: formatUtcDate(previousStart),
        endExclusive: formatUtcDate(addUtcDays(previousEnd, 1))
      }
    }
  };
}

function resolveMonthlyTrendWindow(endDate, months = 12) {
  const end = parseUtcDate(endDate);
  const endMonth = startOfUtcMonth(end);
  const startMonth = startOfUtcMonth(addUtcMonths(endMonth, -(months - 1)));

  return {
    start: formatUtcDate(startMonth),
    endExclusive: formatUtcDate(startOfUtcMonth(addUtcMonths(endMonth, 1))),
    months
  };
}

function buildMonthlyTrend(rows, endDate, months = 12, accountNameMap = {}) {
  const window = resolveMonthlyTrendWindow(endDate, months);
  const buckets = [];
  const monthMap = new Map();

  for (let offset = 0; offset < months; offset++) {
    const monthDate = startOfUtcMonth(addUtcMonths(parseUtcDate(window.start), offset));
    const monthStart = formatUtcDate(monthDate);
    const bucket = {
      monthStart,
      label: formatMonthLabel(monthDate),
      totalCost: 0,
      accounts: [],
      _accountCosts: new Map()
    };

    buckets.push(bucket);
    monthMap.set(monthStart, bucket);
  }

  rows.forEach((row) => {
    const monthStart = row.month_start;
    const bucket = monthMap.get(monthStart);
    if (!bucket) return;

    const cost = Number(row.cost) || 0;
    bucket.totalCost += cost;

    const accountName = accountNameMap[row.account_id] || ACCOUNT_NAMES[row.account_id] || row.account_id;
    const existing = bucket._accountCosts.get(row.account_id) || {
      accountId: row.account_id,
      accountName,
      cost: 0
    };

    existing.cost += cost;
    bucket._accountCosts.set(row.account_id, existing);
  });

  return buckets.map((bucket) => ({
    monthStart: bucket.monthStart,
    label: bucket.label,
    totalCost: roundMoney(bucket.totalCost),
    accounts: [...bucket._accountCosts.values()]
      .map((account) => ({
        ...account,
        cost: roundMoney(account.cost)
      }))
      .sort((left, right) => right.cost - left.cost)
  }));
}

function aggregateCostRows(rows) {
  return rows.reduce((acc, row) => {
    const accountId = row.account_id;
    const service = row.service;
    const cost = Number(row.cost) || 0;

    if (!acc[accountId]) {
      acc[accountId] = { services: {}, total: 0 };
    }

    acc[accountId].services[service] = (acc[accountId].services[service] || 0) + cost;
    acc[accountId].total += cost;
    return acc;
  }, {});
}

// ─── Main handler ───────────────────────────────────────────────────────────
export const handler = async (event) => {
  try {
    let parsedBody;
    if (event.body) {
      parsedBody = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } else {
      parsedBody = event;
    }

    const action = parsedBody.action || 'costs';

    if (action === 'accounts') {
      return await handleAccounts();
    }

    if (action === 'inventory') {
      return await handleInventory(parsedBody);
    }

    if (action === 'forecast') {
      return await handleForecastAndRecommendations(parsedBody);
    }

    return await handleCosts(parsedBody);
  } catch (error) {
    console.error('Error:', error);
    return jsonResponse(500, { error: error.message });
  }
};

async function handleAccounts() {
  const accounts = await resolveAccountCatalog();
  return jsonResponse(200, {
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      status: account.status || null,
      email: account.email || null,
      source: account.source || 'static'
    }))
  });
}

// ─── Inventory handler ──────────────────────────────────────────────────────
async function handleInventory(parsedBody) {
  const query = parsedBody.query || {};
  const { accountIds: accountIdList, accountNameMap } = await resolveRequestedAccounts(query.accountIds || 'all');
  const accountIdsStr = accountIdsToSql(accountIdList);

  // Default: last 30 days
  const now = new Date();
  const endDate = query.endDate || now.toISOString().split('T')[0];
  const start = new Date(now);
  start.setDate(start.getDate() - 30);
  const startDate = query.startDate || start.toISOString().split('T')[0];

  // Query 1: Unique resources per account + service (no region in GROUP BY to avoid double-counting)
  const inventoryQuery = `
SELECT
  line_item_usage_account_id AS account_id,
  line_item_product_code AS service,
  COUNT(DISTINCT line_item_resource_id) AS resource_count
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${startDate}'
  AND line_item_usage_start_date < DATE '${endDate}'
  AND line_item_line_item_type IN ('Usage','Fee')
  AND line_item_usage_account_id IN (${accountIdsStr})
  AND line_item_resource_id IS NOT NULL
  AND line_item_resource_id != ''
GROUP BY 1, 2
ORDER BY resource_count DESC;
`;

  // Query 2: Regions per service (just for display, not for counting)
  const regionsQuery = `
SELECT DISTINCT
  line_item_product_code AS service,
  COALESCE(NULLIF(line_item_availability_zone, ''), 'global') AS region
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${startDate}'
  AND line_item_usage_start_date < DATE '${endDate}'
  AND line_item_line_item_type IN ('Usage','Fee')
  AND line_item_usage_account_id IN (${accountIdsStr})
  AND line_item_resource_id IS NOT NULL
  AND line_item_resource_id != '';
`;

  const rows = await executeGenericAthenaQuery(inventoryQuery, [
    'account_id', 'service', 'resource_count'
  ]);

  const regionRows = await executeGenericAthenaQuery(regionsQuery, [
    'service', 'region'
  ]);

  // Build service -> regions map
  const serviceRegionsMap = {};
  for (const r of regionRows) {
    if (!serviceRegionsMap[r.service]) serviceRegionsMap[r.service] = new Set();
    serviceRegionsMap[r.service].add(r.region);
  }

  // Aggregate by account
  const accountMap = {};
  const serviceMap = {};
  let totalResources = 0;

  for (const row of rows) {
    const accId = row.account_id;
    const svc = row.service;
    const count = parseInt(row.resource_count) || 0;

    totalResources += count;

    // By account
    if (!accountMap[accId]) {
      accountMap[accId] = { services: {}, totalResources: 0 };
    }
    accountMap[accId].totalResources += count;
    if (!accountMap[accId].services[svc]) {
      accountMap[accId].services[svc] = { resourceCount: 0 };
    }
    accountMap[accId].services[svc].resourceCount += count;

    // By service
    if (!serviceMap[svc]) {
      serviceMap[svc] = { resourceCount: 0 };
    }
    serviceMap[svc].resourceCount += count;
  }

  // Build region distribution from the regions query
  const allRegions = new Set();
  for (const r of regionRows) {
    allRegions.add(r.region);
  }

  // Build response
  const accounts = Object.entries(accountMap).map(([accId, data]) => ({
    accountId: accId,
    accountName: accountNameMap[accId] || ACCOUNT_NAMES[accId] || accId,
    totalResources: data.totalResources,
    services: Object.entries(data.services)
      .map(([name, s]) => ({
        name,
        resourceCount: s.resourceCount,
      }))
      .sort((a, b) => b.resourceCount - a.resourceCount)
  })).sort((a, b) => b.totalResources - a.totalResources);

  const byService = Object.entries(serviceMap)
    .map(([service, data]) => ({
      service,
      resourceCount: data.resourceCount,
      regions: serviceRegionsMap[service] ? [...serviceRegionsMap[service]].sort() : []
    }))
    .sort((a, b) => b.resourceCount - a.resourceCount);

  const byRegion = [...allRegions].map(region => ({
    region,
    resourceCount: 0, // Region distribution is informational only
  })).sort((a, b) => a.region.localeCompare(b.region));

  return jsonResponse(200, {
    dateRange: { start: startDate, end: endDate },
    totalResources,
    accounts,
    byService,
    byRegion,
    resources: []
  });
}

// ─── Costs handler (original logic) ────────────────────────────────────────
async function handleCosts(parsedBody) {
  const query = parsedBody.query || {};
  const { accountIds: accountIdList, accountNameMap } = await resolveRequestedAccounts(query.accountIds || 'all');
  const startDate = query.startDate;
  const endDate = query.endDate;
  const includeTrends = query.includeTrends !== false;
  const includeResourceCosts = query.includeResourceCosts === true || query.includeResourceCosts === 'true';
  const parsedLimit = Number(query.resourceCostLimit || 1500);
  const resourceCostLimit = Number.isFinite(parsedLimit) ? Math.min(3000, Math.max(200, Math.round(parsedLimit))) : 1500;

  if (!startDate || !endDate) {
    return jsonResponse(400, { error: 'startDate and endDate required' });
  }

  const accountIdsStr = accountIdsToSql(accountIdList);
  const comparison = resolveComparisonPeriod(startDate, endDate);
  const monthlyTrendWindow = resolveMonthlyTrendWindow(endDate, 12);

  const currentQuery = `
SELECT
  line_item_usage_account_id as account_id,
  line_item_product_code as service,
  SUM(line_item_unblended_cost) as cost
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${comparison.queries.current.start}'
  AND line_item_usage_start_date < DATE '${comparison.queries.current.endExclusive}'
  AND line_item_line_item_type IN (${COST_LINE_ITEM_TYPES})
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
WHERE line_item_usage_start_date >= DATE '${comparison.queries.previous.start}'
  AND line_item_usage_start_date < DATE '${comparison.queries.previous.endExclusive}'
  AND line_item_line_item_type IN (${COST_LINE_ITEM_TYPES})
  AND line_item_usage_account_id IN (${accountIdsStr})
GROUP BY 1,2;
` : null;

  const savingsPlansQuery = `
SELECT
  line_item_usage_account_id as account_id,
  SUM(savings_plan_savings_plan_effective_cost) as sp_covered_cost,
  SUM(pricing_public_on_demand_cost) as on_demand_cost,
  SUM(line_item_unblended_cost) as total_cost,
  COUNT(*) as line_items
FROM athenacurcfn_finnops.data
WHERE savings_plan_savings_plan_a_r_n IS NOT NULL
  AND line_item_usage_start_date >= DATE '${comparison.queries.current.start}'
  AND line_item_usage_start_date < DATE '${comparison.queries.current.endExclusive}'
  AND line_item_usage_account_id IN (${accountIdsStr})
GROUP BY 1
ORDER BY sp_covered_cost DESC;
`;

  const resourceCostsQuery = includeResourceCosts ? `
SELECT
  line_item_usage_account_id as account_id,
  line_item_product_code as service,
  line_item_resource_id as resource_id,
  SUM(line_item_unblended_cost) as cost,
  COUNT(*) as line_items
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${comparison.queries.current.start}'
  AND line_item_usage_start_date < DATE '${comparison.queries.current.endExclusive}'
  AND line_item_line_item_type IN (${COST_LINE_ITEM_TYPES})
  AND line_item_usage_account_id IN (${accountIdsStr})
  AND line_item_resource_id IS NOT NULL
  AND TRIM(line_item_resource_id) != ''
GROUP BY 1,2,3
HAVING SUM(line_item_unblended_cost) > 0
ORDER BY cost DESC
LIMIT ${resourceCostLimit};
` : null;

  const monthlyTrendQuery = `
SELECT
  date_format(date_trunc('month', line_item_usage_start_date), '%Y-%m-01') as month_start,
  line_item_usage_account_id as account_id,
  SUM(line_item_unblended_cost) as cost
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${monthlyTrendWindow.start}'
  AND line_item_usage_start_date < DATE '${monthlyTrendWindow.endExclusive}'
  AND line_item_line_item_type IN (${COST_LINE_ITEM_TYPES})
  AND line_item_usage_account_id IN (${accountIdsStr})
GROUP BY 1,2
ORDER BY 1,2;
`;

  // ─── NEW: Executive-level queries ──────────────────────────────────────────

  // Net cost with real discounts (reseller/partner/credits)
  const netCostQuery = `
SELECT
  SUM(line_item_unblended_cost) as gross_cost,
  SUM(line_item_net_unblended_cost) as net_cost,
  SUM(COALESCE(discount_total_discount, 0)) as total_discount,
  SUM(COALESCE(discount_bundled_discount, 0)) as bundled_discount,
  SUM(CASE WHEN line_item_line_item_type = 'Credit' THEN line_item_unblended_cost ELSE 0 END) as credits_applied,
  SUM(CASE WHEN line_item_line_item_type = 'SppDiscount' THEN line_item_unblended_cost ELSE 0 END) as spp_discount,
  SUM(pricing_public_on_demand_cost) as on_demand_equivalent
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${comparison.queries.current.start}'
  AND line_item_usage_start_date < DATE '${comparison.queries.current.endExclusive}'
  AND line_item_usage_account_id IN (${accountIdsStr});
`;

  // Pricing model breakdown (On-Demand vs SP vs RI vs Spot)
  const pricingModelQuery = `
SELECT
  COALESCE(
    CASE
      WHEN savings_plan_savings_plan_a_r_n IS NOT NULL THEN 'SavingsPlan'
      WHEN reservation_reservation_a_r_n IS NOT NULL THEN 'ReservedInstance'
      WHEN line_item_line_item_type = 'Usage' AND pricing_term = 'Spot' THEN 'Spot'
      WHEN line_item_line_item_type IN ('Usage','Fee','FlatRateSubscription') THEN 'OnDemand'
      WHEN line_item_line_item_type = 'Tax' THEN 'Tax'
      WHEN line_item_line_item_type IN ('Credit','SppDiscount','BundledDiscount','SavingsPlanNegation') THEN 'Discount'
      ELSE 'Other'
    END,
    'Other'
  ) as pricing_model,
  SUM(line_item_unblended_cost) as cost,
  SUM(pricing_public_on_demand_cost) as on_demand_equivalent,
  COUNT(DISTINCT line_item_resource_id) as resources
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${comparison.queries.current.start}'
  AND line_item_usage_start_date < DATE '${comparison.queries.current.endExclusive}'
  AND line_item_usage_account_id IN (${accountIdsStr})
GROUP BY 1
ORDER BY cost DESC;
`;

  // SP utilization detail from CUR (complements the API-based data)
  // NOTE: SP coverage is org-level — a SP purchased in one account covers usage in others
  const spUtilizationQuery = `
SELECT
  savings_plan_offering_type as sp_type,
  savings_plan_payment_option as payment_option,
  savings_plan_region as sp_region,
  SUM(savings_plan_savings_plan_effective_cost) as effective_cost,
  SUM(savings_plan_used_commitment) as used_commitment,
  SUM(savings_plan_recurring_commitment_for_billing_period) as recurring_commitment,
  SUM(pricing_public_on_demand_cost) as on_demand_equivalent,
  COUNT(DISTINCT savings_plan_savings_plan_a_r_n) as plan_count,
  COUNT(DISTINCT line_item_usage_account_id) as accounts_covered
FROM athenacurcfn_finnops.data
WHERE savings_plan_savings_plan_a_r_n IS NOT NULL
  AND line_item_usage_start_date >= DATE '${comparison.queries.current.start}'
  AND line_item_usage_start_date < DATE '${comparison.queries.current.endExclusive}'
  AND line_item_usage_account_id IN (${accountIdsStr})
GROUP BY 1, 2, 3;
`;

  // Org-level SP coverage: how much of the SELECTED accounts' usage is covered by ANY SP
  const spOrgCoverageQuery = `
SELECT
  SUM(CASE WHEN savings_plan_savings_plan_a_r_n IS NOT NULL
    THEN savings_plan_savings_plan_effective_cost ELSE 0 END) as sp_covered_cost,
  SUM(CASE WHEN savings_plan_savings_plan_a_r_n IS NOT NULL
    THEN pricing_public_on_demand_cost ELSE 0 END) as sp_on_demand_equivalent,
  SUM(CASE WHEN reservation_reservation_a_r_n IS NOT NULL
    THEN reservation_effective_cost ELSE 0 END) as ri_covered_cost,
  SUM(CASE WHEN line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage')
    THEN line_item_unblended_cost ELSE 0 END) as total_usage_cost,
  SUM(CASE WHEN line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage')
    THEN pricing_public_on_demand_cost ELSE 0 END) as total_on_demand_equivalent
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${comparison.queries.current.start}'
  AND line_item_usage_start_date < DATE '${comparison.queries.current.endExclusive}'
  AND line_item_usage_account_id IN (${accountIdsStr})
  AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','DiscountedUsage');
`;

  // Daily cost trend for the current period (for anomaly detection)
  const dailyCostQuery = `
SELECT
  DATE(line_item_usage_start_date) as day,
  SUM(line_item_unblended_cost) as cost,
  SUM(line_item_net_unblended_cost) as net_cost
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${comparison.queries.current.start}'
  AND line_item_usage_start_date < DATE '${comparison.queries.current.endExclusive}'
  AND line_item_line_item_type IN (${COST_LINE_ITEM_TYPES})
  AND line_item_usage_account_id IN (${accountIdsStr})
GROUP BY 1
ORDER BY 1;
`;

  // Top resources with instance type info for rightsizing
  const topResourcesQuery = `
SELECT
  line_item_usage_account_id as account_id,
  line_item_product_code as service,
  line_item_resource_id as resource_id,
  MAX(product_instance_type) as instance_type,
  MAX(product_region_code) as region,
  MAX(line_item_usage_type) as usage_type,
  SUM(line_item_unblended_cost) as cost,
  SUM(line_item_usage_amount) as usage_amount,
  MAX(pricing_unit) as unit,
  SUM(pricing_public_on_demand_cost) as on_demand_cost
FROM athenacurcfn_finnops.data
WHERE line_item_usage_start_date >= DATE '${comparison.queries.current.start}'
  AND line_item_usage_start_date < DATE '${comparison.queries.current.endExclusive}'
  AND line_item_line_item_type IN ('Usage','Fee')
  AND line_item_usage_account_id IN (${accountIdsStr})
  AND line_item_resource_id IS NOT NULL
  AND TRIM(line_item_resource_id) != ''
GROUP BY 1,2,3
HAVING SUM(line_item_unblended_cost) > 10
ORDER BY cost DESC
LIMIT 50;
`;

  // ─── Execute all queries in parallel ──────────────────────────────────────

  const [
    currentResults,
    previousResults,
    savingsPlansResults,
    resourceCostResults,
    monthlyTrendResults,
    netCostResults,
    pricingModelResults,
    spUtilizationResults,
    spOrgCoverageResults,
    dailyCostResults,
    topResourcesResults,
  ] = await Promise.all([
    executeAthenaQuery(currentQuery),
    includeTrends ? executeAthenaQuery(previousQuery) : Promise.resolve([]),
    executeSavingsPlansQuery(savingsPlansQuery),
    includeResourceCosts
      ? executeGenericAthenaQuery(resourceCostsQuery, ['account_id', 'service', 'resource_id', 'cost', 'line_items'])
      : Promise.resolve([]),
    executeGenericAthenaQuery(monthlyTrendQuery, ['month_start', 'account_id', 'cost']),
    executeGenericAthenaQuery(netCostQuery, [
      'gross_cost', 'net_cost', 'total_discount', 'bundled_discount',
      'credits_applied', 'spp_discount', 'on_demand_equivalent'
    ]),
    executeGenericAthenaQuery(pricingModelQuery, ['pricing_model', 'cost', 'on_demand_equivalent', 'resources']),
    executeGenericAthenaQuery(spUtilizationQuery, [
      'sp_type', 'payment_option', 'sp_region', 'effective_cost',
      'used_commitment', 'recurring_commitment', 'on_demand_equivalent',
      'plan_count', 'accounts_covered'
    ]),
    executeGenericAthenaQuery(spOrgCoverageQuery, [
      'sp_covered_cost', 'sp_on_demand_equivalent', 'ri_covered_cost',
      'total_usage_cost', 'total_on_demand_equivalent'
    ]),
    executeGenericAthenaQuery(dailyCostQuery, ['day', 'cost', 'net_cost']),
    executeGenericAthenaQuery(topResourcesQuery, [
      'account_id', 'service', 'resource_id', 'instance_type', 'region',
      'usage_type', 'cost', 'usage_amount', 'unit', 'on_demand_cost'
    ]),
  ]);

  const savingsPlansCommitment = await getSavingsPlansCommitment(startDate, endDate);

  // Transform data
  const accountMap = aggregateCostRows(currentResults);
  const prevAccountMap = aggregateCostRows(previousResults);

  const accounts = [], allServices = {};
  let totalCost = 0;
  let previousTotalCost = 0;
  const accountIds = [...new Set([...Object.keys(accountMap), ...Object.keys(prevAccountMap)])];

  accountIds.forEach(accId => {
    const current = accountMap[accId] || { services: {}, total: 0 };
    const previous = prevAccountMap[accId] || { services: {}, total: 0 };
    const services = [];
    const serviceNames = [...new Set([...Object.keys(current.services), ...Object.keys(previous.services)])];

    serviceNames.forEach(svc => {
      const currentCost = current.services[svc] || 0;
      const prevCost = previous.services[svc] || 0;
      const change = currentCost - prevCost;
      const percentage = prevCost > 0 ? (change / prevCost) * 100 : 0;
      services.push({
        name: svc,
        cost: roundMoney(currentCost),
        previousCost: roundMoney(prevCost),
        percentage: current.total > 0 ? parseFloat(((currentCost / current.total) * 100).toFixed(2)) : 0,
        trend: { change: roundMoney(change), percentage: roundMoney(percentage) }
      });
      if (!allServices[svc]) allServices[svc] = { current: 0, previous: 0 };
      allServices[svc].current += currentCost;
      allServices[svc].previous += prevCost;
    });

    services.sort((left, right) => (right.cost - left.cost) || (right.previousCost - left.previousCost));
    const topService = services.find((service) => service.cost > 0) || { name: 'None', cost: 0, previousCost: 0, percentage: 0 };
    const prevTotal = Number(previous.total) || 0;

    accounts.push({
      accountId: accId,
      accountName: accountNameMap[accId] || ACCOUNT_NAMES[accId] || accId,
      totalCost: roundMoney(current.total),
      previousCost: roundMoney(prevTotal),
      trend: {
        change: roundMoney(current.total - prevTotal),
        percentage: prevTotal > 0 ? roundMoney(((current.total - prevTotal) / prevTotal) * 100) : 0
      },
      topService: {
        name: topService.name,
        cost: roundMoney(topService.cost),
        percentage: current.total > 0 ? roundMoney((topService.cost / current.total) * 100) : 0
      },
      services
    });

    totalCost += current.total;
    previousTotalCost += prevTotal;
  });

  const serviceChanges = Object.keys(allServices).map(svc => ({
    service: svc,
    change: roundMoney(allServices[svc].current - allServices[svc].previous),
    percentage: allServices[svc].previous > 0
      ? roundMoney(((allServices[svc].current - allServices[svc].previous) / allServices[svc].previous) * 100)
      : 0
  })).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  const globalServices = Object.keys(allServices)
    .map(svc => ({ name: svc, cost: allServices[svc].current, prevCost: allServices[svc].previous }))
    .sort((a, b) => b.cost - a.cost);
  const topGlobalService = globalServices.find((service) => service.cost > 0) || { name: 'None', cost: 0, prevCost: 0 };
  const accountSummaryMap = new Map(accounts.map((account) => [account.accountId, account]));
  const savingsPlansResultMap = new Map(savingsPlansResults.map((row) => [row.account_id, row]));
  const savingsPlansByAccount = accountIdList.map((accountId) => {
    const result = savingsPlansResultMap.get(accountId);
    const accountData = accountSummaryMap.get(accountId);
    const spCoveredCost = roundMoney(result?.sp_covered_cost || 0);
    const onDemandCost = roundMoney(result?.on_demand_cost || 0);
    const savings = roundMoney((result?.on_demand_cost || 0) - (result?.sp_covered_cost || 0));
    const totalCost = roundMoney(accountData?.totalCost || result?.total_cost || 0);
    const lineItems = result?.line_items || 0;

    return {
      accountId,
      accountName: accountNameMap[accountId] || ACCOUNT_NAMES[accountId] || accountId,
      spCoveredCost,
      onDemandCost,
      savings,
      savingsPercentage: onDemandCost > 0 ? roundMoney((savings / onDemandCost) * 100) : 0,
      totalCost,
      coveragePercentage: totalCost > 0 ? roundMoney((spCoveredCost / totalCost) * 100) : 0,
      lineItems,
      hasCoverage: spCoveredCost > 0
    };
  }).sort((left, right) => {
    if (Number(right.hasCoverage) !== Number(left.hasCoverage)) {
      return Number(right.hasCoverage) - Number(left.hasCoverage);
    }

    return (right.savings - left.savings) || (right.totalCost - left.totalCost);
  });
  const coveredAccountCount = savingsPlansByAccount.filter((account) => account.hasCoverage).length;

  return jsonResponse(200, {
    executionTime: 0,
    dataScanned: '0 GB',
    dateRange: { start: comparison.current.start, end: comparison.current.end },
    comparison: {
      mode: comparison.mode,
      current: comparison.current,
      previous: comparison.previous
    },
    summary: {
      totalCost: roundMoney(totalCost),
      previousTotalCost: roundMoney(previousTotalCost),
      trend: {
        change: roundMoney(totalCost - previousTotalCost),
        percentage: previousTotalCost > 0 ? roundMoney(((totalCost - previousTotalCost) / previousTotalCost) * 100) : 0
      },
      accountCount: accounts.length,
      topService: {
        name: topGlobalService.name,
        cost: roundMoney(topGlobalService.cost),
        trend: {
          change: roundMoney(topGlobalService.cost - topGlobalService.prevCost),
          percentage: topGlobalService.prevCost > 0
            ? roundMoney(((topGlobalService.cost - topGlobalService.prevCost) / topGlobalService.prevCost) * 100)
            : 0
        }
      }
    },
    accounts: accounts.sort((a, b) => b.totalCost - a.totalCost),
    topMovers: {
      increases: serviceChanges.filter(s => s.change > 0).slice(0, 5),
      decreases: serviceChanges.filter(s => s.change < 0).slice(0, 5)
    },
    monthlyTrend: buildMonthlyTrend(monthlyTrendResults, endDate, 12, accountNameMap),
    resourceCosts: resourceCostResults.map((row) => ({
      accountId: row.account_id,
      service: row.service,
      resourceId: row.resource_id,
      cost: roundMoney(row.cost),
      lineItems: parseInt(row.line_items || '0', 10),
    })),
    savingsPlans: {
      totalCoverage: roundMoney(savingsPlansResults.reduce((sum, r) => sum + r.sp_covered_cost, 0)),
      totalSavings: roundMoney(savingsPlansResults.reduce((sum, r) => sum + (r.on_demand_cost - r.sp_covered_cost), 0)),
      selectedAccountCount: accountIdList.length,
      visibleAccountCount: savingsPlansByAccount.length,
      coveredAccountCount,
      commitment: savingsPlansCommitment,
      byAccount: savingsPlansByAccount
    },
    // ─── NEW: Executive-level data ──────────────────────────────────────────
    executive: (() => {
      const execData = buildExecutiveData(
        netCostResults,
        pricingModelResults,
        spUtilizationResults,
        spOrgCoverageResults,
        dailyCostResults,
        topResourcesResults,
        accountNameMap
      );

      // Environment breakdown from account data
      const envMap = {};
      for (const account of accounts) {
        const env = classifyAccountEnvironment(account.accountName);
        if (!envMap[env]) envMap[env] = { environment: env, cost: 0, accounts: 0 };
        envMap[env].cost += account.totalCost;
        envMap[env].accounts += 1;
      }
      execData.environmentBreakdown = Object.values(envMap)
        .map(e => ({ ...e, cost: roundMoney(e.cost), pct: totalCost > 0 ? roundMoney((e.cost / totalCost) * 100) : 0 }))
        .sort((a, b) => b.cost - a.cost);

      return execData;
    })(),
  });
}

// ─── Forecast & Recommendations handler (Cost Explorer API) ─────────────────

async function handleForecastAndRecommendations(parsedBody) {
  const query = parsedBody.query || {};
  const today = startOfUtcToday();
  const forecastMonths = query.forecastMonths || 3;

  // Create Cost Explorer client directly (available in Lambda runtime)
  const costExplorerPkg = await import('@aws-sdk/client-cost-explorer');
  const ceClient = new costExplorerPkg.CostExplorerClient({ region: BILLING_REGION });

  const result = {
    generatedAt: formatUtcDate(today),
    forecast: null,
    spCoverage: null,
    rightsizing: null,
    errors: [],
  };

  // 1. Cost Forecast — next N months
  try {
    const forecastStart = formatUtcDate(addUtcDays(today, 1));
    const forecastEnd = formatUtcDate(startOfUtcMonth(addUtcMonths(today, forecastMonths)));

    const forecastResponse = await ceClient.send(new costExplorerPkg.GetCostForecastCommand({
      TimePeriod: { Start: forecastStart, End: forecastEnd },
      Metric: 'UNBLENDED_COST',
      Granularity: 'MONTHLY',
    }));

    const totalForecast = forecastResponse.Total || forecastResponse.total || {};
    const forecastByMonth = (forecastResponse.ForecastResultsByTime || forecastResponse.forecastResultsByTime || [])
      .map((period) => ({
        start: period.TimePeriod?.Start || period.timePeriod?.start,
        end: period.TimePeriod?.End || period.timePeriod?.end,
        mean: roundMoney(parseAwsNumber(period.MeanValue || period.meanValue)),
        low: roundMoney(parseAwsNumber(
          period.PredictionIntervalLowerBound || period.predictionIntervalLowerBound
        )),
        high: roundMoney(parseAwsNumber(
          period.PredictionIntervalUpperBound || period.predictionIntervalUpperBound
        )),
      }));

    result.forecast = {
      period: { start: forecastStart, end: forecastEnd },
      totalMean: roundMoney(parseAwsNumber(totalForecast.Amount || totalForecast.amount)),
      currency: totalForecast.Unit || totalForecast.unit || 'USD',
      byMonth: forecastByMonth,
    };
  } catch (error) {
    result.errors.push({ area: 'forecast', message: describeAwsError(error) });
    console.warn('Forecast error:', error?.message || error);
  }

  // 2. Savings Plans Coverage — last 30 days daily
  try {
    const coverageStart = formatUtcDate(addUtcDays(today, -30));
    const coverageEnd = formatUtcDate(today);

    const { GetSavingsPlansCoverageCommand } = await import('@aws-sdk/client-cost-explorer');
    const coverageResponse = await ceClient.send(new GetSavingsPlansCoverageCommand({
      TimePeriod: { Start: coverageStart, End: coverageEnd },
      Granularity: 'DAILY',
    }));

    const coverageByDay = (coverageResponse.SavingsPlansCoverages || coverageResponse.savingsPlansCoverages || [])
      .map((item) => {
        const coverage = item.Coverage || item.coverage || {};
        const attrs = item.Attributes || item.attributes || {};
        return {
          start: item.TimePeriod?.Start || item.timePeriod?.start,
          coveragePct: roundRatio(parseAwsNumber(
            coverage.CoveragePercentage || coverage.coveragePercentage
          )),
          spendCoveredBySP: roundMoney(parseAwsNumber(
            coverage.SpendCoveredBySavingsPlans || coverage.spendCoveredBySavingsPlans
          )),
          onDemandCost: roundMoney(parseAwsNumber(
            coverage.OnDemandCost || coverage.onDemandCost
          )),
          totalCost: roundMoney(parseAwsNumber(
            coverage.TotalCost || coverage.totalCost
          )),
        };
      });

    const avgCoverage = coverageByDay.length > 0
      ? roundRatio(coverageByDay.reduce((sum, d) => sum + d.coveragePct, 0) / coverageByDay.length)
      : 0;

    result.spCoverage = {
      period: { start: coverageStart, end: coverageEnd },
      averageCoveragePct: avgCoverage,
      daily: coverageByDay,
    };
  } catch (error) {
    result.errors.push({ area: 'spCoverage', message: describeAwsError(error) });
    console.warn('SP Coverage error:', error?.message || error);
  }

  // 3. Rightsizing Recommendations
  try {
    const { GetRightsizingRecommendationCommand } = await import('@aws-sdk/client-cost-explorer');
    const rightsizingResponse = await ceClient.send(new GetRightsizingRecommendationCommand({
      Service: 'AmazonEC2',
      Configuration: {
        RecommendationTarget: 'SAME_INSTANCE_FAMILY',
        BenefitsConsidered: true,
      },
    }));

    const recommendations = (
      rightsizingResponse.RightsizingRecommendations ||
      rightsizingResponse.rightsizingRecommendations || []
    ).slice(0, 30);

    result.rightsizing = {
      totalRecommendations: recommendations.length,
      summary: {
        terminateCount: recommendations.filter((r) =>
          (r.RightsizingType || r.rightsizingType) === 'Terminate'
        ).length,
        modifyCount: recommendations.filter((r) =>
          (r.RightsizingType || r.rightsizingType) === 'Modify'
        ).length,
        estimatedMonthlySavings: roundMoney(
          recommendations.reduce((sum, r) => {
            const current = r.CurrentInstance || r.currentInstance || {};
            const monthlyCost = parseAwsNumber(
              current.MonthlyCost || current.monthlyCost
            );
            const targets = r.ModifyRecommendationDetail?.TargetInstances ||
              r.modifyRecommendationDetail?.targetInstances || [];
            const targetCost = targets.length > 0
              ? parseAwsNumber(targets[0].EstimatedMonthlyCost || targets[0].estimatedMonthlyCost)
              : 0;
            return sum + Math.max(0, monthlyCost - targetCost);
          }, 0)
        ),
      },
      recommendations: recommendations.map((r) => {
        const current = r.CurrentInstance || r.currentInstance || {};
        const resourceDetails = current.ResourceDetails?.EC2ResourceDetails ||
          current.resourceDetails?.ec2ResourceDetails || {};
        const targets = r.ModifyRecommendationDetail?.TargetInstances ||
          r.modifyRecommendationDetail?.targetInstances || [];
        const target = targets[0] || {};
        const targetDetails = target.ResourceDetails?.EC2ResourceDetails ||
          target.resourceDetails?.ec2ResourceDetails || {};

        return {
          type: r.RightsizingType || r.rightsizingType,
          accountId: r.AccountId || r.accountId,
          instanceId: resourceDetails.InstanceId || resourceDetails.instanceId || current.ResourceId || current.resourceId,
          currentType: resourceDetails.InstanceType || resourceDetails.instanceType,
          currentMonthlyCost: roundMoney(parseAwsNumber(current.MonthlyCost || current.monthlyCost)),
          suggestedType: targetDetails.InstanceType || targetDetails.instanceType || null,
          suggestedMonthlyCost: roundMoney(parseAwsNumber(target.EstimatedMonthlyCost || target.estimatedMonthlyCost)),
          estimatedSavings: roundMoney(
            parseAwsNumber(current.MonthlyCost || current.monthlyCost) -
            parseAwsNumber(target.EstimatedMonthlyCost || target.estimatedMonthlyCost || current.MonthlyCost || current.monthlyCost)
          ),
        };
      }),
    };
  } catch (error) {
    result.errors.push({ area: 'rightsizing', message: describeAwsError(error) });
    console.warn('Rightsizing error:', error?.message || error);
  }

  return jsonResponse(200, result);
}

// ─── Executive data builder ─────────────────────────────────────────────────

function buildExecutiveData(netCostRows, pricingModelRows, spUtilRows, spOrgCoverageRows, dailyCostRows, topResourceRows, accountNameMap) {
  // Net cost breakdown
  const nc = netCostRows[0] || {};
  const grossCost = roundMoney(parseFloat(nc.gross_cost || '0'));
  const netCost = roundMoney(parseFloat(nc.net_cost || '0'));
  const totalDiscount = roundMoney(parseFloat(nc.total_discount || '0'));
  const bundledDiscount = roundMoney(parseFloat(nc.bundled_discount || '0'));
  const creditsApplied = roundMoney(parseFloat(nc.credits_applied || '0'));
  const sppDiscount = roundMoney(parseFloat(nc.spp_discount || '0'));
  const onDemandEquivalent = roundMoney(parseFloat(nc.on_demand_equivalent || '0'));
  const realSavings = roundMoney(onDemandEquivalent - grossCost);
  const effectiveDiscountPct = onDemandEquivalent > 0
    ? roundMoney(((onDemandEquivalent - grossCost) / onDemandEquivalent) * 100)
    : 0;

  // Pricing model breakdown
  const pricingModels = pricingModelRows.map((row) => ({
    model: row.pricing_model,
    cost: roundMoney(parseFloat(row.cost || '0')),
    onDemandEquivalent: roundMoney(parseFloat(row.on_demand_equivalent || '0')),
    resources: parseInt(row.resources || '0', 10),
  }));

  const usageCost = pricingModels
    .filter((m) => ['OnDemand', 'SavingsPlan', 'ReservedInstance', 'Spot'].includes(m.model))
    .reduce((sum, m) => sum + m.cost, 0);

  const onDemandCost = pricingModels.find((m) => m.model === 'OnDemand')?.cost || 0;
  const spCost = pricingModels.find((m) => m.model === 'SavingsPlan')?.cost || 0;
  const riCost = pricingModels.find((m) => m.model === 'ReservedInstance')?.cost || 0;
  const spotCost = pricingModels.find((m) => m.model === 'Spot')?.cost || 0;

  const commitmentCoverage = usageCost > 0
    ? roundMoney(((spCost + riCost) / usageCost) * 100)
    : 0;

  // Org-level coverage: SP + RI coverage based on on-demand equivalent
  const orgCov = spOrgCoverageRows[0] || {};
  const orgSpCovered = roundMoney(parseFloat(orgCov.sp_covered_cost || '0'));
  const orgRiCovered = roundMoney(parseFloat(orgCov.ri_covered_cost || '0'));
  const orgTotalOnDemand = roundMoney(parseFloat(orgCov.total_on_demand_equivalent || '0'));
  const orgTotalUsage = roundMoney(parseFloat(orgCov.total_usage_cost || '0'));
  const orgCoveragePct = orgTotalOnDemand > 0
    ? roundMoney(((parseFloat(orgCov.sp_on_demand_equivalent || '0') + orgRiCovered) / orgTotalOnDemand) * 100)
    : 0;
  const orgOnDemandExposedPct = roundMoney(Math.max(0, 100 - orgCoveragePct));

  // SP utilization detail
  const spUtilization = spUtilRows.map((row) => ({
    type: row.sp_type || 'Unknown',
    paymentOption: row.payment_option || 'Unknown',
    region: row.sp_region || 'global',
    effectiveCost: roundMoney(parseFloat(row.effective_cost || '0')),
    usedCommitment: roundMoney(parseFloat(row.used_commitment || '0')),
    recurringCommitment: roundMoney(parseFloat(row.recurring_commitment || '0')),
    onDemandEquivalent: roundMoney(parseFloat(row.on_demand_equivalent || '0')),
    planCount: parseInt(row.plan_count || '0', 10),
    accountsCovered: parseInt(row.accounts_covered || '0', 10),
  }));

  const totalSpEffective = spUtilization.reduce((sum, sp) => sum + sp.effectiveCost, 0);
  const totalSpOnDemand = spUtilization.reduce((sum, sp) => sum + sp.onDemandEquivalent, 0);
  const spSavingsAmount = roundMoney(totalSpOnDemand - totalSpEffective);
  const spSavingsPct = totalSpOnDemand > 0 ? roundMoney((spSavingsAmount / totalSpOnDemand) * 100) : 0;

  // Daily cost trend
  const dailyCosts = dailyCostRows.map((row) => ({
    day: row.day,
    cost: roundMoney(parseFloat(row.cost || '0')),
    netCost: roundMoney(parseFloat(row.net_cost || '0')),
  }));

  // Anomaly detection: flag days with cost > mean + 2*stddev
  const costValues = dailyCosts.map((d) => d.cost).filter((v) => v > 0);
  const mean = costValues.length > 0 ? costValues.reduce((a, b) => a + b, 0) / costValues.length : 0;
  const stddev = costValues.length > 1
    ? Math.sqrt(costValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (costValues.length - 1))
    : 0;
  const anomalyThreshold = roundMoney(mean + 2 * stddev);

  const anomalies = dailyCosts
    .filter((d) => d.cost > anomalyThreshold && anomalyThreshold > 0)
    .map((d) => ({
      day: d.day,
      cost: d.cost,
      deviation: roundMoney(((d.cost - mean) / stddev)),
    }));

  // Top resources with rightsizing info
  const topResources = topResourceRows.map((row) => ({
    accountId: row.account_id,
    accountName: accountNameMap[row.account_id] || ACCOUNT_NAMES[row.account_id] || row.account_id,
    service: row.service,
    resourceId: row.resource_id,
    instanceType: row.instance_type || null,
    region: row.region || null,
    usageType: row.usage_type || null,
    cost: roundMoney(parseFloat(row.cost || '0')),
    usageAmount: roundMoney(parseFloat(row.usage_amount || '0')),
    unit: row.unit || null,
    onDemandCost: roundMoney(parseFloat(row.on_demand_cost || '0')),
  }));

  return {
    netCost: {
      grossCost,
      netCost,
      onDemandEquivalent: roundMoney(onDemandEquivalent),
      totalDiscount: roundMoney(totalDiscount),
      bundledDiscount: roundMoney(bundledDiscount),
      creditsApplied: roundMoney(creditsApplied),
      sppDiscount: roundMoney(sppDiscount),
      realSavings,
      effectiveDiscountPct,
      netCostAvailable: netCost !== 0 && netCost !== grossCost,
    },
    pricingModel: {
      breakdown: pricingModels,
      usageCost: roundMoney(usageCost),
      onDemandCost: roundMoney(onDemandCost),
      spCost: roundMoney(spCost),
      riCost: roundMoney(riCost),
      spotCost: roundMoney(spotCost),
      commitmentCoverage,
      onDemandPct: usageCost > 0 ? roundMoney((onDemandCost / usageCost) * 100) : 0,
      orgCoverage: {
        spCoveredCost: orgSpCovered,
        riCoveredCost: orgRiCovered,
        totalUsageCost: orgTotalUsage,
        totalOnDemandEquivalent: orgTotalOnDemand,
        coveragePct: orgCoveragePct,
        onDemandExposedPct: orgOnDemandExposedPct,
      },
    },
    savingsPlansDetail: {
      plans: spUtilization,
      totalEffectiveCost: roundMoney(totalSpEffective),
      totalOnDemandEquivalent: roundMoney(totalSpOnDemand),
      savingsAmount: spSavingsAmount,
      savingsPct: spSavingsPct,
    },
    dailyCosts,
    anomalies: {
      threshold: anomalyThreshold,
      mean: roundMoney(mean),
      stddev: roundMoney(stddev),
      flaggedDays: anomalies,
    },
    topResources,
  };
}

// ─── Athena query helpers ───────────────────────────────────────────────────

async function runAthenaQuery(queryString) {
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

  if (status !== 'SUCCEEDED') throw new Error('Query timeout');

  const resultsCommand = new GetQueryResultsCommand({ QueryExecutionId: queryId });
  const resultsResult = await athenaClient.send(resultsCommand);
  return resultsResult.ResultSet.Rows || [];
}

// Generic query: maps columns by name
async function executeGenericAthenaQuery(queryString, columnNames) {
  const rows = await runAthenaQuery(queryString);
  if (rows.length <= 1) return [];

  return rows.slice(1).map(row => {
    const obj = {};
    columnNames.forEach((col, i) => {
      obj[col] = row.Data[i]?.VarCharValue || '';
    });
    return obj;
  });
}

// Legacy: cost queries (account_id, service, cost)
async function executeAthenaQuery(queryString) {
  const rows = await runAthenaQuery(queryString);
  if (rows.length <= 1) return [];

  return rows.slice(1).map(row => ({
    account_id: row.Data[0]?.VarCharValue || '',
    service: row.Data[1]?.VarCharValue || '',
    cost: parseFloat(row.Data[2]?.VarCharValue || '0')
  }));
}

// Legacy: savings plans queries
async function executeSavingsPlansQuery(queryString) {
  const rows = await runAthenaQuery(queryString);
  if (rows.length <= 1) return [];

  return rows.slice(1).map(row => ({
    account_id: row.Data[0]?.VarCharValue || '',
    sp_covered_cost: parseFloat(row.Data[1]?.VarCharValue || '0'),
    on_demand_cost: parseFloat(row.Data[2]?.VarCharValue || '0'),
    total_cost: parseFloat(row.Data[3]?.VarCharValue || '0'),
    line_items: parseInt(row.Data[4]?.VarCharValue || '0', 10)
  }));
}

async function getSavingsPlansCommitment(startDate, endDate) {
  const today = startOfUtcToday();
  const summary = {
    scope: 'organization',
    asOfDate: formatUtcDate(today),
    inventoryAvailable: false,
    inventoryError: null,
    activePlans: null,
    currency: 'USD',
    hourlyCommitment: null,
    estimatedMonthlyCommitment: null,
    recurringPaymentAmount: null,
    upfrontPaymentAmount: null,
    nextExpirationDate: null,
    nextExpirationDays: null,
    planTypes: [],
    paymentOptions: [],
    utilizationAvailable: false,
    utilizationError: null,
    utilization: null
  };

  try {
    const clients = await getBillingClients();

    try {
      const activePlans = [];
      let nextToken;

      do {
        const response = await describeSavingsPlansApi(clients, {
          states: ['active'],
          maxResults: 100,
          ...(nextToken ? { nextToken } : {})
        });

        activePlans.push(...(response.savingsPlans || response.SavingsPlans || []));
        nextToken = response.nextToken || response.NextToken;
      } while (nextToken);

      let hourlyCommitment = 0;
      let recurringPaymentAmount = 0;
      let upfrontPaymentAmount = 0;
      let nextExpiration = null;
      const planTypes = new Set();
      const paymentOptions = new Set();
      const currencies = new Set();

      activePlans.forEach((plan) => {
        hourlyCommitment += parseAwsNumber(plan.commitment || plan.Commitment);
        recurringPaymentAmount += parseAwsNumber(plan.recurringPaymentAmount || plan.RecurringPaymentAmount);
        upfrontPaymentAmount += parseAwsNumber(plan.upfrontPaymentAmount || plan.UpfrontPaymentAmount);

        const planType = plan.savingsPlanType || plan.SavingsPlanType;
        if (planType) {
          planTypes.add(planType);
        }

        const paymentOption = plan.paymentOption || plan.PaymentOption;
        if (paymentOption) {
          paymentOptions.add(paymentOption);
        }

        const currency = plan.currency || plan.Currency;
        if (currency) {
          currencies.add(currency);
        }

        const endValue = plan.end || plan.End;
        if (!endValue) {
          return;
        }

        const endDateTime = new Date(endValue);
        if (Number.isNaN(endDateTime.getTime())) {
          return;
        }

        const endDay = new Date(Date.UTC(
          endDateTime.getUTCFullYear(),
          endDateTime.getUTCMonth(),
          endDateTime.getUTCDate()
        ));

        if (!nextExpiration || endDay.getTime() < nextExpiration.getTime()) {
          nextExpiration = endDay;
        }
      });

      summary.inventoryAvailable = true;
      summary.activePlans = activePlans.length;
      summary.currency = currencies.size > 0 ? [...currencies][0] : 'USD';
      summary.hourlyCommitment = roundMoney(hourlyCommitment);
      summary.estimatedMonthlyCommitment = roundMoney(hourlyCommitment * AVERAGE_HOURS_PER_MONTH);
      summary.recurringPaymentAmount = roundMoney(recurringPaymentAmount);
      summary.upfrontPaymentAmount = roundMoney(upfrontPaymentAmount);
      summary.nextExpirationDate = nextExpiration ? formatUtcDate(nextExpiration) : null;
      summary.nextExpirationDays = nextExpiration
        ? Math.max(0, Math.ceil((nextExpiration.getTime() - today.getTime()) / DAY_MS))
        : null;
      summary.planTypes = [...planTypes].sort();
      summary.paymentOptions = [...paymentOptions].sort();
    } catch (error) {
      summary.inventoryError = describeAwsError(error);
      console.warn('Unable to fetch Savings Plans inventory:', summary.inventoryError);
    }

    try {
      const utilizationWindow = resolveSavingsPlansUtilizationWindow(startDate, endDate);
      const utilizationResponse = await getSavingsPlansUtilizationApi(clients, {
        TimePeriod: {
          Start: utilizationWindow.start,
          End: utilizationWindow.endExclusive
        },
        Granularity: 'DAILY'
      });

      const total = utilizationResponse.Total || utilizationResponse.total || {};
      const utilization = total.Utilization || total.utilization || {};
      const savings = total.Savings || total.savings || {};
      const amortized = total.AmortizedCommitment || total.amortizedCommitment || {};

      summary.utilizationAvailable = true;
      summary.utilization = {
        start: utilizationWindow.start,
        endExclusive: utilizationWindow.endExclusive,
        utilizationPercentage: roundRatio(parseAwsNumber(utilization.UtilizationPercentage || utilization.utilizationPercentage)),
        totalCommitment: roundMoney(parseAwsNumber(utilization.TotalCommitment || utilization.totalCommitment)),
        usedCommitment: roundMoney(parseAwsNumber(utilization.UsedCommitment || utilization.usedCommitment)),
        unusedCommitment: roundMoney(parseAwsNumber(utilization.UnusedCommitment || utilization.unusedCommitment)),
        netSavings: roundMoney(parseAwsNumber(savings.NetSavings || savings.netSavings)),
        onDemandCostEquivalent: roundMoney(parseAwsNumber(savings.OnDemandCostEquivalent || savings.onDemandCostEquivalent)),
        amortizedRecurringCommitment: roundMoney(parseAwsNumber(amortized.AmortizedRecurringCommitment || amortized.amortizedRecurringCommitment)),
        amortizedUpfrontCommitment: roundMoney(parseAwsNumber(amortized.AmortizedUpfrontCommitment || amortized.amortizedUpfrontCommitment)),
        totalAmortizedCommitment: roundMoney(parseAwsNumber(amortized.TotalAmortizedCommitment || amortized.totalAmortizedCommitment))
      };
    } catch (error) {
      summary.utilizationError = describeAwsError(error);
      console.warn('Unable to fetch Savings Plans utilization:', summary.utilizationError);
    }

    if (!summary.inventoryAvailable && !summary.utilizationAvailable) {
      console.warn('Unable to fetch Savings Plans commitment:', summary.inventoryError || summary.utilizationError || 'Unknown AWS error');
    }

    return summary;
  } catch (error) {
    const message = describeAwsError(error);
    console.warn('Unable to initialize Savings Plans billing clients:', message);
    return {
      ...summary,
      inventoryError: message,
      utilizationError: message
    };
  }
}
