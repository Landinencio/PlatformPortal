# Requirements Document

## Introduction

The Platform Portal currently has a basic admin page at `/admin` that displays raw user activity events and simple KPIs (unique users, sessions, average time). This feature replaces it with a comprehensive analytics dashboard providing actionable insights across all portal domains: user engagement, tickets, approvals, access management, repository creation, and infrastructure requests. The dashboard supports configurable time ranges (7 days to 1 year) and presents data through charts, trend lines, rankings, and summary cards. It is restricted to users with the Admin role.

## Glossary

- **Dashboard**: The admin analytics interface accessible at `/admin` that aggregates and visualizes portal usage data
- **Time_Range_Selector**: A UI control allowing the admin to choose the analysis period (7d, 30d, 90d, 6 months, 1 year)
- **Analytics_API**: The set of Next.js API routes under `/api/admin/analytics/` that query PostgreSQL and return aggregated data
- **KPI_Card**: A summary card displaying a single metric with its current value and trend indicator
- **Trend_Indicator**: A visual element showing percentage change compared to the previous equivalent period
- **Portal_User_Activity_Table**: The `portal_user_activity` PostgreSQL table tracking logins, page views, clicks, and session data
- **Portal_Tickets_Table**: The `portal_tickets` PostgreSQL table tracking incidents and requests created through the portal
- **Access_Requests_Table**: The `access_requests` PostgreSQL table tracking platform access grant/revoke requests and their approval status
- **Infra_Requests_Table**: The `infra_requests` PostgreSQL table tracking infrastructure resource requests and their approval status
- **Admin_Role**: The highest privilege role in the portal RBAC system, verified via `hasSessionMinimumRole(session, "admin")`
- **Recharts**: The charting library already used in the portal for data visualization
- **Dashboard_Tab**: A navigation tab within the Dashboard that groups related analytics (e.g., Engagement, Tickets, Approvals)

## Requirements

### Requirement 1: Access Control

**User Story:** As a platform administrator, I want the analytics dashboard restricted to Admin role users, so that sensitive usage data is not exposed to unauthorized personnel.

#### Acceptance Criteria

1. WHEN a user without Admin_Role navigates to the Dashboard URL, THE Dashboard SHALL redirect the user to the portal home page
2. WHEN an unauthenticated user navigates to the Dashboard URL, THE Dashboard SHALL redirect the user to the portal home page
3. WHEN a user with Admin_Role navigates to the Dashboard URL, THE Dashboard SHALL render the full analytics interface
4. WHEN an unauthenticated request is made to any Analytics_API endpoint, THE Analytics_API SHALL return HTTP 401 status
5. WHEN a request from a user without Admin_Role is made to any Analytics_API endpoint, THE Analytics_API SHALL return HTTP 403 status

### Requirement 2: Time Range Selection

**User Story:** As a platform administrator, I want to select different time ranges for analysis, so that I can observe trends over weeks, months, or a full year.

#### Acceptance Criteria

1. THE Time_Range_Selector SHALL offer the following period options: 7 days, 30 days, 90 days, 6 months, and 1 year
2. WHEN the admin selects a time range, THE Dashboard SHALL reload all analytics data for the selected period within 3 seconds
3. THE Dashboard SHALL default to the 30-day time range on initial load
4. WHEN the admin changes the time range, THE Dashboard SHALL preserve the currently active Dashboard_Tab

### Requirement 3: User Engagement Analytics

**User Story:** As a platform administrator, I want to see where users navigate, which pages are most visited, and session patterns, so that I can understand portal adoption and identify underused features.

#### Acceptance Criteria

1. THE Dashboard SHALL display KPI_Cards for: total unique users, total sessions, total page views, average session duration, and total logins for the selected time range
2. THE Dashboard SHALL display a Trend_Indicator on each KPI_Card showing percentage change compared to the previous equivalent period
3. THE Dashboard SHALL display a line chart showing daily active users over the selected time range
4. THE Dashboard SHALL display a ranked list of the top 10 most visited paths with view count and unique user count
5. THE Dashboard SHALL display a bar chart of page views grouped by portal section (tickets, access-management, create-repo, infra-requests, metrics, finops, cybersecurity)
6. THE Dashboard SHALL display a table of users ranked by total events, showing user name, role, session count, total time, and last seen date
7. WHEN the admin clicks on a user row in the engagement table, THE Dashboard SHALL display that user's individual navigation history for the selected period
8. THE Dashboard SHALL display a heatmap or bar chart showing event distribution by hour of day (0-23) to identify peak usage hours

### Requirement 4: Ticket Analytics

**User Story:** As a platform administrator, I want to see ticket creation trends, who opens the most requests and incidents, and volume patterns, so that I can identify support bottlenecks and heavy requestors.

#### Acceptance Criteria

1. THE Dashboard SHALL display KPI_Cards for: total tickets created, total incidents, total requests, and open ticket count for the selected time range
2. THE Dashboard SHALL display a Trend_Indicator on each ticket KPI_Card comparing to the previous equivalent period
3. THE Dashboard SHALL display a line chart showing ticket creation volume over time, with separate lines for incidents and requests
4. THE Dashboard SHALL display a ranked list of the top 10 users by ticket count, showing breakdown by type (incident vs request)
5. THE Dashboard SHALL display a bar chart of tickets grouped by business_team
6. THE Dashboard SHALL display a pie or donut chart showing ticket status distribution (open, in-progress, resolved, closed)
7. THE Dashboard SHALL display a bar chart of tickets grouped by priority level

### Requirement 5: Approval Analytics

**User Story:** As a platform administrator, I want to see who approves and rejects the most access and infrastructure requests, and approval rates by team, so that I can monitor governance efficiency.

#### Acceptance Criteria

1. THE Dashboard SHALL display KPI_Cards for: total reviews completed, approval rate percentage, average time-to-review (hours), and pending request count
2. THE Dashboard SHALL display a Trend_Indicator on each approval KPI_Card comparing to the previous equivalent period
3. THE Dashboard SHALL display a ranked list of the top 10 reviewers by total reviews, showing their approval and rejection counts
4. THE Dashboard SHALL display a bar chart showing approval rate by business_team for access requests
5. THE Dashboard SHALL display a line chart showing approval volume over time with separate lines for approved and rejected decisions
6. THE Dashboard SHALL combine approval data from both Access_Requests_Table and Infra_Requests_Table into unified approval metrics

### Requirement 6: Access Management Analytics

**User Story:** As a platform administrator, I want to see which platforms are most requested, user access trends, and request patterns, so that I can plan capacity and identify access governance issues.

#### Acceptance Criteria

1. THE Dashboard SHALL display KPI_Cards for: total access requests, grant requests count, revoke requests count, and executed request count for the selected time range
2. THE Dashboard SHALL display a Trend_Indicator on each access KPI_Card comparing to the previous equivalent period
3. THE Dashboard SHALL display a bar chart showing request volume grouped by platform (aws, argocd, sonarqube, gitlab)
4. THE Dashboard SHALL display a line chart showing access request volume over time
5. THE Dashboard SHALL display a ranked list of the top 10 requestors by access request count
6. THE Dashboard SHALL display a pie or donut chart showing access request status distribution (pending, approved, rejected, executed, execute_failed)

### Requirement 7: Repository Creation Analytics

**User Story:** As a platform administrator, I want to see who creates the most repositories and creation trends, so that I can monitor platform growth and team productivity.

#### Acceptance Criteria

1. THE Dashboard SHALL display KPI_Cards for: total repositories created and unique creators for the selected time range
2. THE Dashboard SHALL display a Trend_Indicator on each repository KPI_Card comparing to the previous equivalent period
3. THE Dashboard SHALL display a line chart showing repository creation volume over time
4. THE Dashboard SHALL display a ranked list of the top 10 users by repository creation count
5. THE Analytics_API SHALL derive repository creation data from Portal_User_Activity_Table events where event_type is 'repo_created' or action contains repository creation indicators

### Requirement 8: Infrastructure Request Analytics

**User Story:** As a platform administrator, I want to see infrastructure request volume, types, and approval rates, so that I can understand infrastructure demand and governance effectiveness.

#### Acceptance Criteria

1. THE Dashboard SHALL display KPI_Cards for: total infra requests, approval rate percentage, pending count, and average time-to-review for the selected time range
2. THE Dashboard SHALL display a Trend_Indicator on each infra KPI_Card comparing to the previous equivalent period
3. THE Dashboard SHALL display a bar chart showing request volume grouped by resource_type (s3, rds, lambda, iam_role)
4. THE Dashboard SHALL display a line chart showing infra request volume over time
5. THE Dashboard SHALL display a bar chart showing infra requests grouped by team
6. THE Dashboard SHALL display a ranked list of the top 10 requestors by infra request count

### Requirement 9: General Usage Overview

**User Story:** As a platform administrator, I want a high-level overview of portal health including active users over time, role distribution, and peak usage, so that I can quickly assess overall platform adoption.

#### Acceptance Criteria

1. THE Dashboard SHALL display a summary section showing total registered users, active users in the last 7 days, and active users in the last 30 days
2. THE Dashboard SHALL display a pie or donut chart showing user distribution by role (Admin, Directores, Staff, Desarrolladores, Externos)
3. THE Dashboard SHALL display a line chart showing weekly active users trend over the selected time range
4. THE Dashboard SHALL display a bar chart showing peak usage hours aggregated across all users

### Requirement 10: Dashboard Navigation and Layout

**User Story:** As a platform administrator, I want the analytics organized into logical tabs with clear navigation, so that I can quickly find the insights I need.

#### Acceptance Criteria

1. THE Dashboard SHALL organize analytics into the following Dashboard_Tabs: Overview, Engagement, Tickets, Approvals, Access, Repos, Infrastructure
2. THE Dashboard SHALL display the Overview tab by default, showing cross-domain KPI_Cards and key trend charts
3. WHEN the admin clicks a Dashboard_Tab, THE Dashboard SHALL display the corresponding analytics section without a full page reload
4. THE Dashboard SHALL use a responsive layout that adapts to desktop (>1024px) and tablet (768px-1024px) viewports
5. THE Dashboard SHALL use shadcn/ui components and Tailwind CSS consistent with the existing portal design system

### Requirement 11: Data Freshness and Performance

**User Story:** As a platform administrator, I want the dashboard to load quickly and show reasonably fresh data, so that I can make timely decisions without waiting.

#### Acceptance Criteria

1. WHEN the Dashboard loads, THE Analytics_API SHALL return aggregated data within 3 seconds for any supported time range
2. THE Dashboard SHALL display a loading skeleton while data is being fetched
3. THE Dashboard SHALL display a manual refresh button that reloads all data for the current tab
4. IF an Analytics_API request fails, THEN THE Dashboard SHALL display an error message with a retry option without crashing the entire interface
5. THE Analytics_API SHALL use efficient SQL queries with appropriate indexes to maintain performance on tables with over 100,000 rows

### Requirement 12: Trend Comparison

**User Story:** As a platform administrator, I want to see how current metrics compare to the previous period, so that I can identify improvements or regressions.

#### Acceptance Criteria

1. THE Trend_Indicator SHALL calculate percentage change as: ((current_period_value - previous_period_value) / previous_period_value) * 100
2. THE Trend_Indicator SHALL display a green upward arrow for positive changes and a red downward arrow for negative changes
3. IF the previous period value is zero, THEN THE Trend_Indicator SHALL display "New" instead of a percentage
4. THE Trend_Indicator SHALL round percentage values to one decimal place
