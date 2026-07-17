# Per-Admin Section Permissions — Design Spec
**Date:** 2026-07-17
**Goal:** Let a super_admin grant each individual `admin` user access to only a subset of the app's sections, instead of every admin automatically having identical full access.

---

## 1. Context

Today access control is role-only: `ProtectedRoute allowedRoles={[...]}` gates each page by role (`super_admin`, `admin`, `teacher`, `student`), and `app/dashboard/layout.tsx` filters the sidebar the same way. Every user with role `admin` sees and can use the exact same ~16 sections — there's no way to give one admin narrower access than another.

This spec covers **admin role only**. `super_admin` stays always-full-access (and is the only role that can grant/edit permissions). `teacher` and `student` access is unchanged.

---

## 2. Scope: the 16 toggleable sections

One toggle per section (page-level granularity — not per-action, not view/edit split). Derived 1:1 from the current `NAV_TOP`/`NAV_GROUPS` entries in `app/dashboard/layout.tsx` that are visible to `admin`:

| Key | Label | Route | Group |
|---|---|---|---|
| `centerSuite` | Center Suite | `/dashboard` | *(ungrouped, always-on)* |
| `centers` | Centers | `/dashboard/centers` | *(ungrouped)* |
| `teachers` | Teachers | `/dashboard/teachers` | *(ungrouped)* |
| `students` | Students | `/dashboard/students` | *(ungrouped)* |
| `attendance` | Attendance | `/dashboard/attendance` | *(ungrouped)* |
| `syllabus` | Syllabus | `/dashboard/syllabus` | *(ungrouped)* |
| `admissions` | Admissions | `/dashboard/screening` (+ all `/dashboard/screening/*` sub-pages) | *(ungrouped)* |
| `fees` | Fees | `/dashboard/finance` | Finance |
| `expenses` | Expenses | `/dashboard/expenses` | Finance |
| `analytics` | Analytics | `/dashboard/analytics` | Insights & Reports |
| `leaderboards` | Leaderboards | `/dashboard/leaderboards` | Insights & Reports |
| `myScore` | My Score | `/dashboard/teacher-score` | Insights & Reports |
| `export` | Export | `/dashboard/export` | Insights & Reports |
| `alerts` | Alerts | `/dashboard/alerts` | System Admin |
| `auditLogs` | Audit Logs | `/dashboard/audit-logs` | System Admin |
| `history` | History | `/dashboard/history` | System Admin |

**Explicitly excluded:** the "Admins" section (`/dashboard/admins`, managing admin accounts) stays hard-coded `super_admin`-only. It is never toggleable for `admin` — an admin must never be able to grant itself or another admin more access.

**`centerSuite` is special-cased as always-on** regardless of an admin's `permissions` list, so a heavily-restricted admin still has a working landing page after login instead of a dead end.

`admissions` bundles everything currently reachable inside `/dashboard/screening`, including the application-form editor and screening-question editor built previously — those stay gated by the existing `isAdmin` role check *and* now additionally require the `admissions` permission.

---

## 3. Data model

- **`config/adminSections.ts`** (new file) — single source of truth:
  ```ts
  export interface AdminSection { key: string; label: string; href: string; group?: string; alwaysOn?: boolean; }
  export const ADMIN_SECTIONS: AdminSection[] = [ /* exactly the 16 rows from the table in §2 above —
    key/label/route/group taken verbatim from that table, alwaysOn: true only on centerSuite */ ];
  ```
- **`types/index.ts`** — add `permissions?: string[]` to `AdminUser`. Value is an array of `AdminSection.key`s.
  - `undefined` (the field absent) = **full access** — every existing admin today, and every admin created via the current signup flow, is unaffected until a super_admin explicitly edits them.
  - `[]` (empty array) = access to nothing except the always-on `centerSuite`.
  - A defined, non-empty array = exactly those sections (plus `centerSuite`).

No new Firestore collection. `permissions` lives directly on `users/{uid}`, since `getUserProfile()` (`services/firebase/auth.service.ts`) already does a raw `snap.data() as User` passthrough — the field is available on `AuthContext`'s `user` object for free, no extra read, no extra plumbing.

---

## 4. Enforcement

Both enforcement points read `ADMIN_SECTIONS` and the same helper:

```ts
// lib/validators/auth.validators.ts
export function hasSectionAccess(user: User, sectionKey: string): boolean {
  if (user.role !== ROLES.ADMIN) return true; // super_admin/teacher/student: role gate already handled elsewhere
  const section = ADMIN_SECTIONS.find(s => s.key === sectionKey);
  if (section?.alwaysOn) return true;
  if (!("permissions" in user) || user.permissions === undefined) return true; // default full access
  return user.permissions.includes(sectionKey);
}
```

1. **Nav filtering** (`app/dashboard/layout.tsx`): after the existing role filter, additionally drop any `NAV_TOP`/`NAV_GROUPS` item whose section key fails `hasSectionAccess` for role `admin`.
2. **Route guard** (`components/layout/ProtectedRoute.tsx`): add an optional `sectionKey?: string` prop. Each `app/dashboard/*/page.tsx` (and the screening sub-pages) passes it alongside its existing `allowedRoles`. When role passes but `hasSectionAccess` fails, redirect to `/dashboard` (not `/login` — the user is legitimately authenticated, just not permitted here; sending them to the login screen would be confusing). This blocks direct URL entry even when the item is hidden from nav.

---

## 5. Admin UI

No new route. Inside the existing super_admin-only `app/dashboard/admins/page.tsx`:

- Each row in the admin list gets a **"🔐 Permissions"** action button, opening a modal overlay in the same visual pattern as `EditAdmissionOverlay` (fixed inset, centered card, header + scrollable body + footer Save/Cancel).
- Modal body: a checkbox per `ADMIN_SECTIONS` entry, grouped under headers matching the sidebar groups (ungrouped items first, then Finance / Insights & Reports / System Admin). `centerSuite` is shown but disabled/checked (always on), so it's visible but not a decision point.
- A **"Full Access"** toggle at the top: when on, all checkboxes are checked and disabled, and saving persists `permissions: undefined` via `deleteField()` (or omits the key) — keeping "full access" represented identically to a legacy, never-configured admin rather than as an explicit list that happens to include everything (avoids drift if new sections are added later — a "full access" admin should automatically get new sections too, not need re-editing).
- Saving (non-full-access case) calls `updateDoc(doc(db, "users", uid), { permissions: [...selectedKeys] })`.

---

## 6. Edge cases

- **New sections added later:** any admin with `permissions === undefined` (full access) automatically gets them. Admins with an explicit list do not, until a super_admin re-opens their permissions and checks the new box — this is the correct default (explicit lists shouldn't silently expand).
- **An admin's own permissions change while they're logged in:** `AuthContext` re-subscribes via `onAuthStateChanged`/Firestore listener already in place for role/status changes; the same path picks up `permissions` changes on next profile fetch. No new real-time listener needed.
- **Empty `permissions: []`:** admin lands on Center Suite only, sees an otherwise-empty sidebar. No special "no access" screen needed since Center Suite always renders.

## 7. Out of scope

- Teacher/student permission customization (explicitly deferred — role-only for those two, per your answer).
- Permission templates/groups (explicitly deferred — flat per-admin checklist only, per your answer).
- View vs. edit split, or any action-level granularity (page-level only, per your answer).
- Server-side enforcement via Firestore security rules — the whole app currently has no real security rules (`services/firebase/firestore.rules` is a placeholder stub, not evaluated), so this feature is client-side-enforced only, consistent with every other access check already in the app. Not a regression this spec introduces, but worth flagging as a pre-existing gap outside this spec's scope.

---

## 8. Verification

1. As super_admin, open Admins page, add a "🔐 Permissions" edit on an existing admin, uncheck everything except Students and Attendance, save.
2. Log in as that admin: sidebar shows only Center Suite, Students, Attendance. Direct-navigating to `/dashboard/finance` redirects to `/dashboard` instead of rendering.
3. Re-open the same admin's permissions, toggle "Full Access" on, save. Confirm `permissions` field is removed from the Firestore doc (not saved as an explicit full list).
4. Confirm a *different*, never-configured admin still sees every section (default full access unaffected).
5. `npm run typecheck` / `npm run build` clean.
