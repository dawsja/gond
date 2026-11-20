export type AppCatalogEntry = { toolkit: string; name: string; icon: string; category: string; logo?: string; description?: string };

export type CatalogPage = { apps: AppCatalogEntry[]; total: number; page: number; pages: number };

export const CATALOG_PAGE_SIZE = 12;

export function appLogoUrl(toolkit: string) {
  return `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`;
}

export const APP_CATALOG: AppCatalogEntry[] = [
  { toolkit: "gmail", name: "Gmail", icon: "gmail", category: "Email" },
  { toolkit: "outlook", name: "Outlook", icon: "outlook", category: "Email" },
  { toolkit: "googlecalendar", name: "Google Calendar", icon: "googlecalendar", category: "Calendar" },
  { toolkit: "googledrive", name: "Google Drive", icon: "googledrive", category: "Files" },
  { toolkit: "googledocs", name: "Google Docs", icon: "googledocs", category: "Docs" },
  { toolkit: "googlesheets", name: "Google Sheets", icon: "googlesheets", category: "Files" },
  { toolkit: "googleslides", name: "Google Slides", icon: "googleslides", category: "Docs" },
  { toolkit: "googletasks", name: "Google Tasks", icon: "googletasks", category: "Work" },
  { toolkit: "googlemeet", name: "Google Meet", icon: "googlemeet", category: "Meetings" },
  { toolkit: "github", name: "GitHub", icon: "github", category: "Code" },
  { toolkit: "notion", name: "Notion", icon: "notion", category: "Docs" },
  { toolkit: "slack", name: "Slack", icon: "slack", category: "Chat" },
  { toolkit: "gitlab", name: "GitLab", icon: "gitlab", category: "Code" },
  { toolkit: "supabase", name: "Supabase", icon: "supabase", category: "Code" },
  { toolkit: "alpaca", name: "Alpaca", icon: "alpaca", category: "Finance" },
];

export const CURATED_TOOLKITS: ReadonlySet<string> = new Set(APP_CATALOG.map((app) => app.toolkit));

export type Connection = {
  toolkit: string;
  name: string;

  accountId: string;
  status: "active" | "pending" | "failed";
  createdAt: string;
};

export type ComposioKeyStatus = { source: "own" | "server" | null };
