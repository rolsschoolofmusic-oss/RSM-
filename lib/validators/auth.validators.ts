import { ROLES, USER_STATUS } from "@/config/constants";
import { ADMIN_SECTIONS } from "@/config/adminSections";
import type { User, Role } from "@/types";

export function isActiveUser(user: User): boolean {
  return user.status === USER_STATUS.ACTIVE;
}

export function hasRole(user: User, role: Role): boolean {
  return user.role === role;
}

export function hasAnyRole(user: User, roles: Role[]): boolean {
  return roles.includes(user.role);
}

export function canApproveStudentDeactivation(user: User): boolean {
  return hasAnyRole(user, [ROLES.ADMIN, ROLES.SUPER_ADMIN]);
}

export function canApproveTeacherDeactivation(user: User): boolean {
  return hasRole(user, ROLES.SUPER_ADMIN);
}

export function canOverrideSyllabus(user: User): boolean {
  // Strict rule: only admin can skip syllabus order
  return hasAnyRole(user, [ROLES.ADMIN, ROLES.SUPER_ADMIN]);
}

export function canManuallyMarkAttendance(user: User): boolean {
  // Manual attendance is allowed but flagged — any active user may do it
  return isActiveUser(user);
}

/**
 * Returns true if the user is active and not pending.
 * Use this before allowing any protected action.
 */
export function validateUserAccess(user: User | null): boolean {
  if (!user) return false;
  return user.status === USER_STATUS.ACTIVE;
}

/**
 * Returns true if the user's role is in the allowed list.
 * Combines with validateUserAccess for full gate: access + role.
 */
export function isRoleAllowed(user: User | null, roles: Role[]): boolean {
  if (!user) return false;
  return roles.includes(user.role);
}

/**
 * Returns true unless the user is an `admin` who has been explicitly
 * restricted away from `sectionKey`. super_admin/teacher/student always
 * pass — this only ever narrows access for role === ROLES.ADMIN.
 * Undefined `permissions` (never configured) means full access.
 */
export function hasSectionAccess(user: User | null, sectionKey?: string): boolean {
  if (!sectionKey || !user || user.role !== ROLES.ADMIN) return true;
  const section = ADMIN_SECTIONS.find(s => s.key === sectionKey);
  if (section?.alwaysOn) return true;
  const perms = "permissions" in user ? user.permissions : undefined;
  return perms === undefined || perms.includes(sectionKey);
}