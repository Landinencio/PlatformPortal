/**
 * GitLab MR Metrics Service
 * Fetches MR data from GitLab API and calculates engineering metrics
 * Based on PRD specifications
 */

const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.iskaypet.com';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;

// Types
export interface MRAuthor {
  name: string;
  username: string;
  avatar_url: string;
}

export interface MRReviewer {
  name: string;
  username: string;
  avatar_url: string;
  comments: number;
}

export interface MergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  author: MRAuthor;
  created_at: string;
  merged_at: string | null;
  updated_at: string;
  state: 'opened' | 'merged' | 'closed' | 'locked';
  project_name: string;
  web_url: string;
  // Calculated metrics
  lifetime_days: number;
  lead_time_days: number;
  review_time_days: number;
  commit_count: number;
  review_count: number;
  reviewers: MRReviewer[];
}

export interface MRMetricsSummary {
  total: number;
  merged: number;
  opened: number;
  closed: number;
  lifetimeMedian: number;
  lifetimeMean: number;
  leadTimeMedian: number;
  leadTimeMean: number;
  reviewTimeMedian: number;
  reviewTimeMean: number;
  contributors: number;
}

export interface WeeklyData {
  week: string;
  weekStart: string;
  merged: number;
  reviewTimeMedian: number;
  leadTimeMedian: number;
}

interface GitLabNote {
  id: number;
  body: string;
  author: { username: string; name: string; avatar_url: string };
  created_at: string;
  system: boolean;
}

// Retry with exponential backoff
async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        // Rate limited - wait and retry
        const waitTime = Math.pow(2, i) * 1000;
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }
      return res;
    } catch (e) {
      lastError = e as Error;
      const waitTime = Math.pow(2, i) * 1000;
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
  
  throw lastError || new Error('Fetch failed after retries');
}

// GitLab API helper
async function gitlabFetch<T>(endpoint: string): Promise<T> {
  if (!GITLAB_TOKEN) throw new Error('GITLAB_TOKEN not configured');
  
  const res = await fetchWithRetry(`${GITLAB_URL}/api/v4${endpoint}`, {
    headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
  });
  
  if (!res.ok) throw new Error(`GitLab API error: ${res.status}`);
  return res.json();
}

// Get all MRs for a project with pagination
async function getProjectMRs(projectId: number, since: Date): Promise<any[]> {
  const allMRs: any[] = [];
  let page = 1;
  const perPage = 100;
  const sinceStr = since.toISOString();
  
  while (true) {
    const mrs = await gitlabFetch<any[]>(
      `/projects/${projectId}/merge_requests?state=all&per_page=${perPage}&page=${page}&updated_after=${sinceStr}`
    );
    
    if (mrs.length === 0) break;
    allMRs.push(...mrs);
    if (mrs.length < perPage) break;
    page++;
  }
  
  return allMRs;
}

// Get notes (comments) for an MR
async function getMRNotes(projectId: number, mrIid: number): Promise<GitLabNote[]> {
  return gitlabFetch<GitLabNote[]>(
    `/projects/${projectId}/merge_requests/${mrIid}/notes?per_page=100`
  );
}

// Calculate metrics for a single MR
function calculateMRMetrics(mr: any, notes: GitLabNote[]): Partial<MergeRequest> {
  const createdAt = new Date(mr.created_at);
  const mergedAt = mr.merged_at ? new Date(mr.merged_at) : null;
  const now = new Date();
  
  // Filter human comments (not system, not author)
  const humanNotes = notes
    .filter(n => !n.system && n.author.username !== mr.author.username)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  
  const firstHumanComment = humanNotes.length > 0 ? new Date(humanNotes[0].created_at) : null;
  
  // Lifetime: created → merged (or now if open)
  let lifetime_days = 0;
  if (mr.state === 'merged' && mergedAt) {
    lifetime_days = (mergedAt.getTime() - createdAt.getTime()) / (1000 * 3600 * 24);
  } else if (mr.state === 'opened') {
    lifetime_days = (now.getTime() - createdAt.getTime()) / (1000 * 3600 * 24);
  }
  
  // Lead time: created → first human comment
  let lead_time_days = lifetime_days; // Default to lifetime if no comments
  if (firstHumanComment) {
    lead_time_days = (firstHumanComment.getTime() - createdAt.getTime()) / (1000 * 3600 * 24);
  }
  
  // Review time: first human comment → merged
  let review_time_days = 0;
  if (firstHumanComment) {
    const endDate = mergedAt || now;
    review_time_days = Math.max(0, (endDate.getTime() - firstHumanComment.getTime()) / (1000 * 3600 * 24));
  }
  
  // Build reviewers map
  const reviewerMap = new Map<string, MRReviewer>();
  for (const note of humanNotes) {
    const existing = reviewerMap.get(note.author.username);
    if (existing) {
      existing.comments++;
    } else {
      reviewerMap.set(note.author.username, {
        name: note.author.name,
        username: note.author.username,
        avatar_url: note.author.avatar_url,
        comments: 1,
      });
    }
  }
  
  return {
    lifetime_days,
    lead_time_days,
    review_time_days,
    review_count: humanNotes.length,
    reviewers: Array.from(reviewerMap.values()),
  };
}


// Statistics functions
function median(values: number[], excludeZeros = false): number {
  let filtered = excludeZeros ? values.filter(v => v > 0) : values;
  if (filtered.length === 0) return 0;
  
  filtered = [...filtered].sort((a, b) => a - b);
  const mid = Math.floor(filtered.length / 2);
  
  return filtered.length % 2 !== 0
    ? filtered[mid]
    : (filtered[mid - 1] + filtered[mid]) / 2;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Get start of week (Sunday)
function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Format date as "MMM dd"
function formatWeek(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate().toString().padStart(2, '0')}`;
}

/**
 * Fetch and process MR metrics for a project
 */
export async function fetchMRMetrics(projectId: number, days: number = 30): Promise<{
  summary: MRMetricsSummary;
  weekly: WeeklyData[];
  mrs: MergeRequest[];
}> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  
  // Get all MRs
  const rawMRs = await getProjectMRs(projectId, since);
  
  // Get project name
  const project = await gitlabFetch<{ name: string }>(`/projects/${projectId}`);
  
  // Process MRs in batches to respect rate limits
  const processedMRs: MergeRequest[] = [];
  const batchSize = 3;
  
  for (let i = 0; i < rawMRs.length; i += batchSize) {
    const batch = rawMRs.slice(i, i + batchSize);
    
    const batchResults = await Promise.all(
      batch.map(async (mr) => {
        try {
          const notes = await getMRNotes(projectId, mr.iid);
          const metrics = calculateMRMetrics(mr, notes);
          
          return {
            id: mr.id,
            iid: mr.iid,
            project_id: mr.project_id,
            title: mr.title,
            author: {
              name: mr.author.name,
              username: mr.author.username,
              avatar_url: mr.author.avatar_url,
            },
            created_at: mr.created_at,
            merged_at: mr.merged_at,
            updated_at: mr.updated_at,
            state: mr.state,
            project_name: project.name,
            web_url: mr.web_url,
            commit_count: 0, // Could fetch commits if needed
            ...metrics,
          } as MergeRequest;
        } catch (e) {
          console.error(`Error processing MR ${mr.iid}:`, e);
          return null;
        }
      })
    );
    
    processedMRs.push(...batchResults.filter((mr): mr is MergeRequest => mr !== null));
    
    // Rate limit delay between batches
    if (i + batchSize < rawMRs.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  // Calculate summary
  const mergedMRs = processedMRs.filter(mr => mr.state === 'merged');
  const openedMRs = processedMRs.filter(mr => mr.state === 'opened');
  const closedMRs = processedMRs.filter(mr => mr.state === 'closed');
  
  const lifetimes = mergedMRs.map(mr => mr.lifetime_days);
  const leadTimes = mergedMRs.map(mr => mr.lead_time_days);
  const reviewTimes = mergedMRs.map(mr => mr.review_time_days);
  
  const uniqueAuthors = new Set(processedMRs.map(mr => mr.author.username));
  
  const summary: MRMetricsSummary = {
    total: processedMRs.length,
    merged: mergedMRs.length,
    opened: openedMRs.length,
    closed: closedMRs.length,
    lifetimeMedian: median(lifetimes),
    lifetimeMean: mean(lifetimes),
    leadTimeMedian: median(leadTimes),
    leadTimeMean: mean(leadTimes),
    reviewTimeMedian: median(reviewTimes, true), // Exclude zeros per PRD
    reviewTimeMean: mean(reviewTimes),
    contributors: uniqueAuthors.size,
  };
  
  // Calculate weekly data
  const weeklyMap = new Map<string, { merged: number; reviewTimes: number[]; leadTimes: number[] }>();
  
  for (const mr of mergedMRs) {
    const weekStart = startOfWeek(new Date(mr.merged_at!));
    const weekKey = weekStart.toISOString();
    
    const existing = weeklyMap.get(weekKey) || { merged: 0, reviewTimes: [], leadTimes: [] };
    existing.merged++;
    if (mr.review_time_days > 0) existing.reviewTimes.push(mr.review_time_days);
    existing.leadTimes.push(mr.lead_time_days);
    weeklyMap.set(weekKey, existing);
  }
  
  const weekly: WeeklyData[] = Array.from(weeklyMap.entries())
    .map(([weekStart, data]) => ({
      week: formatWeek(new Date(weekStart)),
      weekStart,
      merged: data.merged,
      reviewTimeMedian: median(data.reviewTimes, true),
      leadTimeMedian: median(data.leadTimes),
    }))
    .sort((a, b) => new Date(a.weekStart).getTime() - new Date(b.weekStart).getTime());
  
  return { summary, weekly, mrs: processedMRs };
}

/**
 * Get contributor stats from MR data
 */
export function calculateContributorStats(mrs: MergeRequest[]): {
  author: string;
  name: string;
  avatar: string;
  mrsCreated: number;
  reviewsGiven: number;
  commentsGiven: number;
  collaboratedWith: string[];
  badges: string[];
}[] {
  const authorMap = new Map<string, {
    name: string;
    avatar: string;
    mrsCreated: number;
    reviewsGiven: number;
    commentsGiven: number;
    collaboratedWith: Set<string>;
  }>();
  
  // Count MRs created by each author
  for (const mr of mrs) {
    const existing = authorMap.get(mr.author.username) || {
      name: mr.author.name,
      avatar: mr.author.avatar_url,
      mrsCreated: 0,
      reviewsGiven: 0,
      commentsGiven: 0,
      collaboratedWith: new Set<string>(),
    };
    existing.mrsCreated++;
    authorMap.set(mr.author.username, existing);
  }
  
  // Count reviews given
  for (const mr of mrs) {
    for (const reviewer of mr.reviewers) {
      const existing = authorMap.get(reviewer.username) || {
        name: reviewer.name,
        avatar: reviewer.avatar_url,
        mrsCreated: 0,
        reviewsGiven: 0,
        commentsGiven: 0,
        collaboratedWith: new Set<string>(),
      };
      existing.reviewsGiven++;
      existing.commentsGiven += reviewer.comments;
      existing.collaboratedWith.add(mr.author.username);
      authorMap.set(reviewer.username, existing);
    }
  }
  
  // Convert to array and add badges
  return Array.from(authorMap.entries())
    .map(([username, data]) => {
      const badges: string[] = [];
      if (data.reviewsGiven > 5) badges.push('🛡️ Guardian');
      if (data.collaboratedWith.size > 3) badges.push('❤️ Team Player');
      if (data.commentsGiven > 20) badges.push('🎓 Mentor');
      
      return {
        author: username,
        name: data.name,
        avatar: data.avatar,
        mrsCreated: data.mrsCreated,
        reviewsGiven: data.reviewsGiven,
        commentsGiven: data.commentsGiven,
        collaboratedWith: Array.from(data.collaboratedWith),
        badges,
      };
    })
    .sort((a, b) => b.reviewsGiven - a.reviewsGiven);
}
