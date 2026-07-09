# Implementation Plan: Admin Analytics Dashboard

## Overview

Replace the existing basic admin activity page with a comprehensive multi-tab analytics dashboard. The implementation follows the existing portal patterns: Next.js API routes with PostgreSQL queries, React client components with shadcn/ui, Recharts for visualization, and `node:test` + `fast-check` for property-based testing. All analytics are derived from four existing tables (`portal_user_activity`, `portal_tickets`, `access_requests`, `infra_requests`) with no schema changes required.

## Tasks

- [ ] 1. Create shared analytics utilities and UI components
  - [ ] 1.1 Create analytics utility functions (trend calculation, time range helpers)
    - Create `src/lib/admin-analytics.ts` with:
      - `calculateTrend(currentValue: number, previousValue: number): TrendData` function implementing the trend formula
      - `getDateRange(days: number): { from: Date; to: Date; previousFrom: Date; previousTo: Date }` helper
      - `VALID_TIME_RANGES` constant array `[7, 30, 90, 180, 365]`
      - `validateDaysParam(days: unknown): number` that validates and returns a valid days value or throws
      - TypeScript interfaces: `TrendData`, `AnalyticsResponse<T>`, `AnalyticsQueryParams`
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 2.1_

  - [ ] 1.2 Create KPI Card and Trend Indicator shared UI components
    - Create `src/components/admin/analytics/kpi-card.tsx`:
      - Accepts `label`, `value`, `icon`, and `trend` props
      - Uses shadcn/ui `Card` component for container
      - Renders the trend indicator inline
    - Create `src/components/admin/analytics/trend-indicator.tsx`:
      - Green up arrow (`TrendingUp` from lucide-react) for positive change
      - Red down arrow (`TrendingDown` from lucide-react) for negative change
      - "New" badge when `isNew` is true (previousValue was 0)
      - Rounds percentage to one decimal place
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [ ] 1.3 Create analytics loading skeleton and error card components
    - Create `src/components/admin/analytics/analytics-skeleton.tsx` using shadcn/ui `Skeleton`
    - Create `src/components/admin/analytics/error-card.tsx` with retry button prop
    - _Requirements: 11.2, 11.4_

- [ ] 2. Implement Overview API route and tab
  - [ ] 2.1 Create `/api/admin/analytics/overview` API route
    - Create `src/app/api/admin/analytics/overview/route.ts`
    - Implement auth guard: check session with `getServerSession` + `hasSessionMinimumRole(session, "admin")`
    - Return 401 for no session, 403 for non-admin
    - Validate `days` query parameter using `validateDaysParam`
    - Query `portal_user_activity` for: total registered users, active users 7d, active users 30d
    - Query all four tables for total counts with trend CTEs
    - Query weekly active users time series
    - Query role distribution from `portal_user_activity` (distinct users by role)
    - Query peak hours distribution
    - Return `AnalyticsResponse<OverviewData>` JSON
    - _Requirements: 1.4, 1.5, 9.1, 9.2, 9.3, 9.4, 11.1, 11.5_

  - [ ] 2.2 Create Overview tab panel component
    - Create `src/components/admin/analytics/overview-tab.tsx`
    - Fetch data from `/api/admin/analytics/overview?days=N`
    - Render KPI cards for: total users, active 7d, active 30d, total tickets, total access requests, total infra requests
    - Render weekly active users line chart (Recharts `LineChart`)
    - Render role distribution pie chart (Recharts `PieChart`)
    - Render peak hours bar chart (Recharts `BarChart`)
    - Handle loading/error states independently
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.2_

- [ ] 3. Implement Engagement API route and tab
  - [ ] 3.1 Create `/api/admin/analytics/engagement` API route
    - Create `src/app/api/admin/analytics/engagement/route.ts`
    - Auth guard (same pattern as overview)
    - Query `portal_user_activity` for: unique users, total sessions (distinct `portal_session_id`), total page views (`event_type = 'page_view'`), avg session duration, total logins (`event_type = 'login'`)
    - Compute trends for each KPI using CTE pattern
    - Query daily active users time series
    - Query top 10 paths by view count with unique user count
    - Query section views grouped by first path segment
    - Query user ranking: email, name, role, total events, session count, total minutes, last seen
    - Query hourly distribution
    - _Requirements: 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 11.1_

  - [ ] 3.2 Create `/api/admin/analytics/user-detail` API route
    - Create `src/app/api/admin/analytics/user-detail/route.ts`
    - Auth guard
    - Accept `email` and `days` query params
    - Query `portal_user_activity` for the user's navigation history ordered by `occurred_at DESC`
    - Return `AnalyticsResponse<UserDetailData>` JSON
    - _Requirements: 3.7_

  - [ ] 3.3 Create Engagement tab panel component
    - Create `src/components/admin/analytics/engagement-tab.tsx`
    - Fetch from `/api/admin/analytics/engagement?days=N`
    - Render KPI cards with trends for all engagement metrics
    - Render daily active users line chart
    - Render top paths ranked list (shadcn/ui `Table`)
    - Render section views bar chart
    - Render user ranking table with clickable rows
    - Render hourly distribution bar chart
    - On user row click, fetch user-detail and display navigation history in a dialog
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [ ] 4. Implement Tickets API route and tab
  - [ ] 4.1 Create `/api/admin/analytics/tickets` API route
    - Create `src/app/api/admin/analytics/tickets/route.ts`
    - Auth guard
    - Query `portal_tickets` for: total tickets, total incidents (`type = 'incident'`), total requests (`type = 'request'`), open count (`status = 'open'`)
    - Compute trends for each KPI
    - Query daily volume with separate incident/request counts
    - Query top 10 requestors by ticket count with type breakdown
    - Query tickets by business_team
    - Query status distribution
    - Query priority distribution
    - _Requirements: 1.4, 1.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 11.1_

  - [ ] 4.2 Create Tickets tab panel component
    - Create `src/components/admin/analytics/tickets-tab.tsx`
    - Fetch from `/api/admin/analytics/tickets?days=N`
    - Render KPI cards with trends
    - Render daily volume line chart with two lines (incidents, requests)
    - Render top requestors table
    - Render tickets by team bar chart
    - Render status distribution donut chart (Recharts `PieChart` with inner radius)
    - Render priority distribution bar chart
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [ ] 5. Implement Approvals API route and tab
  - [ ] 5.1 Create `/api/admin/analytics/approvals` API route
    - Create `src/app/api/admin/analytics/approvals/route.ts`
    - Auth guard
    - Query combined `access_requests` + `infra_requests` (UNION ALL) for reviewed items
    - Compute: total reviews, approval rate, avg time-to-review (hours), pending count
    - Compute trends for each KPI
    - Query top 10 reviewers with approved/rejected counts
    - Query approval rate by team (from `access_requests` business context)
    - Query daily approval volume with approved/rejected lines
    - _Requirements: 1.4, 1.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 11.1_

  - [ ] 5.2 Create Approvals tab panel component
    - Create `src/components/admin/analytics/approvals-tab.tsx`
    - Fetch from `/api/admin/analytics/approvals?days=N`
    - Render KPI cards with trends
    - Render top reviewers table
    - Render approval rate by team bar chart
    - Render daily volume line chart with approved/rejected lines
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [ ] 6. Implement Access API route and tab
  - [ ] 6.1 Create `/api/admin/analytics/access` API route
    - Create `src/app/api/admin/analytics/access/route.ts`
    - Auth guard
    - Query `access_requests` for: total requests, grant count (`request_type = 'grant'`), revoke count (`request_type = 'revoke'`), executed count (`status = 'executed'`)
    - Compute trends for each KPI
    - Query by platform distribution
    - Query daily volume time series
    - Query top 10 requestors
    - Query status distribution
    - _Requirements: 1.4, 1.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 11.1_

  - [ ] 6.2 Create Access tab panel component
    - Create `src/components/admin/analytics/access-tab.tsx`
    - Fetch from `/api/admin/analytics/access?days=N`
    - Render KPI cards with trends
    - Render platform distribution bar chart
    - Render daily volume line chart
    - Render top requestors table
    - Render status distribution donut chart
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [ ] 7. Implement Repos API route and tab
  - [ ] 7.1 Create `/api/admin/analytics/repos` API route
    - Create `src/app/api/admin/analytics/repos/route.ts`
    - Auth guard
    - Query `portal_user_activity` where `event_type = 'repo_created'` or action contains repo creation indicators
    - Compute: total created, unique creators
    - Compute trends for each KPI
    - Query daily volume time series
    - Query top 10 creators
    - _Requirements: 1.4, 1.5, 7.1, 7.2, 7.3, 7.4, 7.5, 11.1_

  - [ ] 7.2 Create Repos tab panel component
    - Create `src/components/admin/analytics/repos-tab.tsx`
    - Fetch from `/api/admin/analytics/repos?days=N`
    - Render KPI cards with trends
    - Render daily volume line chart
    - Render top creators table
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [ ] 8. Implement Infra API route and tab
  - [ ] 8.1 Create `/api/admin/analytics/infra` API route
    - Create `src/app/api/admin/analytics/infra/route.ts`
    - Auth guard
    - Query `infra_requests` for: total requests, approval rate, pending count, avg time-to-review
    - Compute trends for each KPI
    - Query by resource_type distribution
    - Query daily volume time series
    - Query by team distribution
    - Query top 10 requestors
    - _Requirements: 1.4, 1.5, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 11.1_

  - [ ] 8.2 Create Infra tab panel component
    - Create `src/components/admin/analytics/infra-tab.tsx`
    - Fetch from `/api/admin/analytics/infra?days=N`
    - Render KPI cards with trends
    - Render resource type bar chart
    - Render daily volume line chart
    - Render team distribution bar chart
    - Render top requestors table
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [ ] 9. Checkpoint - Core API and tab components
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Create main dashboard shell and wire everything together
  - [ ] 10.1 Create the main AdminAnalyticsDashboard component
    - Create `src/components/admin/admin-analytics-dashboard.tsx` (replaces existing)
    - Implement tab navigation using `@radix-ui/react-tabs` (Tabs, TabsList, TabsTrigger, TabsContent)
    - Implement time range selector using shadcn/ui `Select` with options: 7d, 30d, 90d, 6 months, 1 year
    - Default to 30-day range and "overview" tab
    - Pass `days` prop to each tab panel component
    - Add manual refresh button that triggers re-fetch on active tab
    - Responsive layout: grid adapts for desktop (>1024px) and tablet (768-1024px)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 10.1, 10.2, 10.3, 10.4, 10.5, 11.3_

  - [ ] 10.2 Update admin page to use new dashboard component
    - Modify `src/app/admin/page.tsx` to import `AdminAnalyticsDashboard` from the new path
    - Keep existing auth guard logic unchanged
    - _Requirements: 1.1, 1.2, 1.3_

- [ ] 11. Checkpoint - Full integration
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Property-based tests
  - [ ]* 12.1 Write property test for trend calculation (Property 1)
    - Create `src/lib/__tests__/admin-analytics/properties/trend-calculation.property.test.ts`
    - Use `node:test` + `fast-check`
    - **Property 1: Trend Calculation Correctness**
    - Generate random pairs of non-negative integers for currentValue and previousValue
    - Assert: when previousValue > 0, result equals `((current - previous) / previous) * 100` rounded to 1 decimal
    - Assert: when previousValue = 0, result is null with `isNew: true`
    - Assert: positive result → positive direction, negative result → negative direction
    - Minimum 100 iterations
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4**

  - [ ]* 12.2 Write property test for grouping partition invariant (Property 2)
    - Create `src/lib/__tests__/admin-analytics/properties/grouping-partition.property.test.ts`
    - **Property 2: Grouping Partition Invariant**
    - Generate random arrays of records with categorical fields (status, priority, team, platform, etc.)
    - Assert: sum of all group counts equals total record count
    - Assert: no record appears in more than one group
    - Minimum 100 iterations
    - **Validates: Requirements 4.5, 4.6, 4.7, 6.3, 6.6, 8.3, 8.5, 9.2, 3.5, 3.8**

  - [ ]* 12.3 Write property test for ranking sort and limit invariant (Property 3)
    - Create `src/lib/__tests__/admin-analytics/properties/ranking-invariant.property.test.ts`
    - **Property 3: Ranking Sort and Limit Invariant**
    - Generate random arrays of records with numeric metrics
    - Assert: returned list is sorted descending by metric
    - Assert: list has at most 10 entries
    - Assert: each entry's count matches actual count in input
    - Minimum 100 iterations
    - **Validates: Requirements 3.4, 3.6, 4.4, 5.3, 6.5, 7.4, 8.6**

  - [ ]* 12.4 Write property test for time-series aggregation invariant (Property 4)
    - Create `src/lib/__tests__/admin-analytics/properties/timeseries-aggregation.property.test.ts`
    - **Property 4: Time-Series Aggregation Invariant**
    - Generate random arrays of timestamped records within date ranges
    - Assert: sum of all bucket counts equals total record count for the period
    - Minimum 100 iterations
    - **Validates: Requirements 3.3, 4.3, 5.5, 6.4, 7.3, 8.4, 9.3**

  - [ ]* 12.5 Write property test for type decomposition invariant (Property 5)
    - Create `src/lib/__tests__/admin-analytics/properties/type-decomposition.property.test.ts`
    - **Property 5: Type Decomposition Invariant**
    - Generate random arrays of typed records (tickets with incident/request, access with grant/revoke)
    - Assert: sum of subtype counts equals total count
    - Minimum 100 iterations
    - **Validates: Requirements 4.1, 6.1, 5.6**

  - [ ]* 12.6 Write property test for filter correctness (Property 6)
    - Create `src/lib/__tests__/admin-analytics/properties/filter-correctness.property.test.ts`
    - **Property 6: Filter Correctness**
    - Generate random arrays of records + random filter criteria (email, event type, date range)
    - Assert: filtered result contains only matching records
    - Assert: filtered result contains every matching record
    - Minimum 100 iterations
    - **Validates: Requirements 3.7, 7.5**

  - [ ]* 12.7 Write property test for tab state preservation (Property 7)
    - Create `src/lib/__tests__/admin-analytics/properties/tab-preservation.property.test.ts`
    - **Property 7: Tab State Preservation on Range Change**
    - Generate random tab IDs and random time range transitions
    - Assert: changing time range does not change active tab
    - Minimum 100 iterations
    - **Validates: Requirements 2.4**

  - [ ]* 12.8 Write property test for time window monotonicity (Property 8)
    - Create `src/lib/__tests__/admin-analytics/properties/time-window-monotonicity.property.test.ts`
    - **Property 8: Time Window Monotonicity**
    - Generate random arrays of activity records with timestamps
    - Assert: active_7d <= active_30d <= total_registered
    - Minimum 100 iterations
    - **Validates: Requirements 9.1**

  - [ ]* 12.9 Write property test for approval rate formula (Property 9)
    - Create `src/lib/__tests__/admin-analytics/properties/approval-rate.property.test.ts`
    - **Property 9: Approval Rate Formula Correctness**
    - Generate random arrays of reviewed requests with statuses and timestamps
    - Assert: approval rate equals `(approved / total_reviewed) * 100` rounded to 1 decimal
    - Assert: avg time-to-review equals mean of all review durations in hours
    - Minimum 100 iterations
    - **Validates: Requirements 5.1, 5.4, 8.1**

- [ ] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The project uses `node:test` with `fast-check` v4.7.0 for property-based tests (see existing patterns in `src/lib/__tests__/`)
- All API routes follow the same auth pattern already used in `src/app/api/admin/activity/`
- UI components use shadcn/ui + Tailwind CSS + Recharts (all already in the project)
- No new database tables or migrations are needed — all data comes from existing tables

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "3.1", "3.2", "4.1", "5.1", "6.1", "7.1", "8.1"] },
    { "id": 2, "tasks": ["2.2", "3.3", "4.2", "5.2", "6.2", "7.2", "8.2"] },
    { "id": 3, "tasks": ["10.1"] },
    { "id": 4, "tasks": ["10.2"] },
    { "id": 5, "tasks": ["12.1", "12.2", "12.3", "12.4", "12.5", "12.6", "12.7", "12.8", "12.9"] }
  ]
}
```
