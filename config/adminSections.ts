// Single source of truth for the per-admin toggleable sections of the app.
// Used by: app/dashboard/layout.tsx (sidebar filtering), ProtectedRoute
// (route guard), and app/dashboard/admins/page.tsx (the permissions editor).
export interface AdminSection {
  key:       string;
  label:     string;
  href:      string;
  group?:    string;
  /** Always accessible regardless of an admin's permissions list. */
  alwaysOn?: boolean;
}

export const ADMIN_SECTIONS: AdminSection[] = [
  { key: "centers",     label: "Centers",      href: "/dashboard/centers" },
  { key: "teachers",    label: "Teachers",     href: "/dashboard/teachers" },
  { key: "students",    label: "Students",     href: "/dashboard/students" },
  { key: "attendance",  label: "Attendance",   href: "/dashboard/attendance" },
  { key: "syllabus",    label: "Syllabus",     href: "/dashboard/syllabus" },
  { key: "admissions",  label: "Admissions",   href: "/dashboard/screening" },

  { key: "fees",        label: "Fees",         href: "/dashboard/finance",       group: "Finance" },
  { key: "expenses",    label: "Expenses",     href: "/dashboard/expenses",      group: "Finance" },

  { key: "analytics",    label: "Analytics",    href: "/dashboard/analytics",     group: "Insights & Reports" },
  { key: "leaderboards", label: "Leaderboards", href: "/dashboard/leaderboards",  group: "Insights & Reports" },
  { key: "myScore",      label: "My Score",     href: "/dashboard/teacher-score", group: "Insights & Reports" },
  { key: "export",       label: "Export",       href: "/dashboard/export",        group: "Insights & Reports" },

  { key: "alerts",    label: "Alerts",     href: "/dashboard/alerts",     group: "System Admin" },
  { key: "auditLogs", label: "Audit Logs", href: "/dashboard/audit-logs", group: "System Admin" },
  { key: "history",   label: "History",    href: "/dashboard/history",   group: "System Admin" },
];
