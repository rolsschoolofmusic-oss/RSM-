"use client";

import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { AdminDashboard } from "../AdminDashboardContent";

// Admin's own landing dashboard — highlights only the sections this admin has
// been granted (see AdminDashboard's hasSectionAccess checks). Not further
// restrictable itself, same as Faculty Suite / Learner's Suite for their roles.
export default function AdminSuitePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.ADMIN]}>
      <AdminDashboard />
    </ProtectedRoute>
  );
}
