// AN-T19 plain-JSON view model: built on the server (server/report-views.ts), rendered by the client ReportView. No functions, no ids of centres/branches.
import type { AnalyticsScope } from './ScopeBanner';

export type Cell =
  | { k: 'text'; v: string; /** App-relative link rendered as "Open" next to the text (pending tests). */ open?: string }
  | { k: 'int'; v: number | undefined }
  | { k: 'money'; v: number | undefined }
  | { k: 'bp'; v: number | undefined }
  | { k: 'dur'; v: number | undefined }
  | { k: 'id'; v: string }
  | { k: 'link'; v: string; href: string }
  | { k: 'badge'; v: string; tone: 'neutral' | 'warning' | 'danger' };

export interface Col { id: string; header: string; align?: 'start' | 'end' | 'center' }
export interface TableVM {
  id: string;
  caption: string;
  heading?: string;
  columns: Col[];
  /** Index of the row-header column (default 0); the Total row carries "Total" there. */
  rowHeader?: number;
  rows: { id: string; cells: Cell[] }[];
  /** Last row, first cell is "Total". */
  total?: Cell[];
  /** Cursor paging (pending tests): `next` is the next cursor; Previous = browser back. */
  pager?: { next?: string; hasPrevious: boolean; limit: number };
}

export interface Opt { value: string; label: string }
export type Control =
  | { type: 'radio'; id: string; label: string; options: Opt[]; value: string }
  | { type: 'select'; id: string; label: string; options: Opt[]; value: string }
  | { type: 'multi'; id: string; label: string; options: Opt[]; value: string[] }
  | { type: 'switch'; id: string; label: string; on: boolean; onValue?: string; offValue?: string }
  | { type: 'checks'; id: string; label: string; options: Opt[]; value: string[] }
  /** Referrer multi filter: Combobox over searchAnalyticsReferrers; `value` = chosen ids (labels are not in the URL). */
  | { type: 'referrers'; id: string; label: string; value: string[] };

export type Section =
  | { t: 'table'; vm: TableVM }
  | { t: 'chart'; title: string; categories: string[]; series: { id: string; label: string; values: number[] }[]; format: 'money' | 'integer' }
  | { t: 'tiles'; items: { label: string; value: string }[] }
  | { t: 'card'; title: string; items: { term: string; value: string }[] }
  | { t: 'dl'; items: { term: string; value: string }[] }
  | { t: 'banner'; tone: 'info' | 'warning'; title: string }
  | { t: 'note'; text: string }
  | { t: 'text'; text: string };

export interface FreshnessVM { family: string; refreshed_at?: string; is_stale: boolean; stale_reason?: 'refresh_lagging' | 'refresh_failed' | 'never_refreshed'; live: boolean }

export interface PageVM {
  /** Tab id of this page (report slug, or `collections`). */
  tab: string;
  title: string;
  helpKey: string;
  pageId: 'staff.analytics.reports' | 'staff.analytics.collections' | 'staff.analytics.referral_incentive';
  /** Path filters / tabs navigate on (query is appended). */
  basePath: string;
  tabs: { id: string; label: string; href: string }[];
  /** Whitelisted query string the server sent to the API (no leading `?`). */
  query: string;
  period?: { labelAd: string; labelBs: string; timezone: string; from: string; to: string };
  freshness: FreshnessVM[];
  generatedAt?: string;
  scope: AnalyticsScope;
  controls: Control[];
  /** Centre / branch filters, already capped to the caller's scope by the API. Centre is absent with <= 1 centre. */
  centreOptions: Opt[];
  branchOptions: Opt[];
  /** Session holds analytics.dashboard.read (requestAnalyticsRefresh); false for a finance-only user. */
  canRefresh: boolean;
  export?: { reportCode: string; pdfEnabled: boolean; groupLabel?: string };
  link?: { href: string; label: string };
  sections: Section[];
}
