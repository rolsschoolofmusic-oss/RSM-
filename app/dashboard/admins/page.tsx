"use client";

import { useState, useEffect, type FormEvent } from "react";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  collection,
  setDoc,
  updateDoc,
  deleteField,
  getDocs,
  query,
  where,
  serverTimestamp,
  doc,
  getDoc,
} from "firebase/firestore";
import {
  createUserWithEmailAndPassword,
  getAuth,
  signOut as fbSignOut,
} from "firebase/auth";
import { deleteApp } from "firebase/app";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import type { Center } from "@/types";
import { deleteUser as deleteUserRecord } from "@/services/admin/delete.service";
import { ADMIN_SECTIONS } from "@/config/adminSections";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminRow {
  uid:         string;
  displayName: string;
  email:       string;
  adminCode:   string;
  status:      string;
  role:        string;
  permissions?: string[];
  _createdAt:  number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Atomic counter — center-scoped, year-aware, Firestore transaction */
async function getNextAdminSeq(): Promise<number> {
  const ref = doc(db, "counters", "admin_global");
  const snap = await getDoc(ref);
  const current = snap.exists() ? (snap.data().seq as number) : 0;
  const next = current + 1;
  const { setDoc } = await import("firebase/firestore");
  await setDoc(ref, { seq: next }, { merge: true });
  return next;
}

function pad(n: number, w: number) {
  return String(n).padStart(w, "0");
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminsPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN]}>
      <AdminsContent />
    </ProtectedRoute>
  );
}

function AdminsContent() {
  const { user } = useAuth();

  const [admins, setAdmins]         = useState<AdminRow[]>([]);
  const [centers, setCenters]       = useState<Center[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showForm, setShowForm]     = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminRow | null>(null);
  const [permTarget, setPermTarget] = useState<AdminRow | null>(null);

  // Form fields
  const [name, setName]           = useState("");
  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [showPw, setShowPw]       = useState(false);
  const [createRole, setCreateRole] = useState<typeof ROLES.ADMIN | typeof ROLES.SUPER_ADMIN>(ROLES.ADMIN);
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);

  // Permissions to assign at creation time (admin role only — defaults to full access;
  // irrelevant for super_admin, which is always unrestricted)
  const [createFullAccess, setCreateFullAccess] = useState(true);
  const [createSelected, setCreateSelected] = useState<Set<string>>(
    new Set(ADMIN_SECTIONS.map(sec => sec.key))
  );
  function toggleCreatePerm(key: string) {
    setCreateSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // ── Load admins + centers ─────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const [adminSnap, centerSnap] = await Promise.all([
          getDocs(query(
            collection(db, "users"),
            where("role", "in", [ROLES.ADMIN, ROLES.SUPER_ADMIN]),
          )),
          getDocs(collection(db, "centers")),
        ]);

        setAdmins(adminSnap.docs.map(d => {
          const data = d.data();
          return {
            uid:         d.id,
            displayName: data.displayName ?? data.name ?? "—",
            email:       data.email ?? "—",
            adminCode:   data.adminCode ?? "—",
            status:      data.status ?? "active",
            role:        data.role ?? ROLES.ADMIN,
            permissions: data.permissions,
            _createdAt:  data.createdAt?.seconds ?? 0,
          };
        }).sort((a, b) => b._createdAt - a._createdAt));

        setCenters(centerSnap.docs.map(d => ({
          id: d.id,
          ...d.data(),
        } as Center)));
      } catch (err) {
        console.error("Failed to load admins:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ── Create admin ─────────────────────────────────────────────────────────
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSuccessMsg(null);
    setErrorMsg(null);

    if (!name.trim())       return setErrorMsg("Name is required.");
    if (!email.trim())      return setErrorMsg("Email is required.");
    if (password.length < 6) return setErrorMsg("Password must be at least 6 characters.");

    setSubmitting(true);
    try {
      // 1. Check duplicate email in Firestore
      const dupSnap = await getDocs(query(
        collection(db, "users"),
        where("email", "==", email.trim().toLowerCase()),
      ));
      if (!dupSnap.empty) {
        setErrorMsg(`Email already in use: "${email.trim()}"`);
        return;
      }

      // 2. Create Firebase Auth user using a secondary app instance
      //    so the super admin's own session is never displaced.
      const { initializeApp } = await import("firebase/app");
      const { default: primaryApp } = await import("@/services/firebase/firebase");
      const secondaryApp  = initializeApp(primaryApp.options, `admin-create-${Date.now()}`);
      const secondaryAuth = getAuth(secondaryApp);

      let uid: string;
      try {
        const cred = await createUserWithEmailAndPassword(
          secondaryAuth, email.trim().toLowerCase(), password
        );
        uid = cred.user.uid;
      } finally {
        // Always sign out + delete secondary app — password no longer needed
        await fbSignOut(secondaryAuth).catch(() => {});
        await deleteApp(secondaryApp).catch(() => {});
      }

      // 3. Generate adminCode (ADM001, ADM002…)
      const seq       = await getNextAdminSeq();
      const adminCode = `ADM${pad(seq, 3)}`;

      // 4. Write Firestore user doc (doc ID = Firebase Auth UID) — password NEVER stored.
      //    permissions is only ever meaningful for role "admin" — super_admin is always
      //    full access, so it's omitted entirely for both "full access" admins and super_admins.
      const isSuperAdmin = createRole === ROLES.SUPER_ADMIN;
      await setDoc(doc(db, "users", uid), {
        uid,
        email:           email.trim().toLowerCase(),
        displayName:     name.trim(),
        role:            createRole,
        adminCode,
        status:          "active",
        mustResetPassword: false,
        currentBalance:  0,
        lastActivity:    null,
        qrCodeURL:       null,
        createdBy:       user?.uid ?? "unknown",
        createdAt:       serverTimestamp(),
        updatedAt:       serverTimestamp(),
        ...(!isSuperAdmin && !createFullAccess ? { permissions: Array.from(createSelected) } : {}),
      });

      // 5. Audit log — password never included in metadata
      await logAction({
        action:        isSuperAdmin ? "SUPER_ADMIN_CREATED" : "ADMIN_CREATED",
        initiatorId:   user?.uid ?? "unknown",
        initiatorRole: ROLES.SUPER_ADMIN,
        approverId:    null,
        approverRole:  null,
        reason:        isSuperAdmin ? "Super admin created new super admin" : "Super admin created new admin",
        metadata:      { adminCode, email: email.trim().toLowerCase(), role: createRole },
      });

      // 6. Refresh admin list (no orderBy — sort client-side to avoid index requirement)
      const fresh = await getDocs(query(
        collection(db, "users"),
        where("role", "in", [ROLES.ADMIN, ROLES.SUPER_ADMIN]),
      ));
      setAdmins(fresh.docs.map(d => {
        const data = d.data();
        return {
          uid:          d.id,
          displayName:  data.displayName ?? data.name ?? "—",
          email:        data.email ?? "—",
          adminCode:    data.adminCode ?? "—",
          status:       data.status ?? "active",
          role:         data.role ?? ROLES.ADMIN,
          permissions:  data.permissions,
          _createdAt:   (data.createdAt?.seconds ?? 0) * 1000,
        };
      }));

      setSuccessMsg(`${isSuperAdmin ? "Super Admin" : "Admin"} created successfully. Code: ${adminCode}`);
      setName(""); setEmail(""); setPassword(""); setCreateRole(ROLES.ADMIN);
      setCreateFullAccess(true); setCreateSelected(new Set(ADMIN_SECTIONS.map(sec => sec.key)));
      setShowForm(false);

    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "auth/email-already-in-use") {
        setErrorMsg("This email is already registered in Firebase Auth.");
      } else {
        setErrorMsg(err instanceof Error ? err.message : "Creation failed.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* ── Delete Admin Modal ── */}
      {deleteTarget && (
        <div style={s.overlay} onClick={() => setDeleteTarget(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <span style={{ ...s.modalTitle, color: "#991b1b" }}>✕ Delete Admin</span>
              <button onClick={() => setDeleteTarget(null)} style={s.closeBtn}>×</button>
            </div>
            <div style={s.modalBody}>
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "#991b1b", marginBottom: 14 }}>
                <strong>Delete &ldquo;{deleteTarget.displayName}&rdquo;?</strong> Their login will be disabled and they will lose access. This cannot be undone.
              </div>
              <DeleteConfirm
                name={deleteTarget.displayName}
                uid={deleteTarget.uid}
                role="admin"
                currentUserUid={user?.uid ?? ""}
                onDeleted={() => {
                  setAdmins(prev => prev.filter(a => a.uid !== deleteTarget.uid));
                  setDeleteTarget(null);
                  setSuccessMsg(`Admin "${deleteTarget.displayName}" deleted.`);
                }}
                onError={msg => { setErrorMsg(msg); setDeleteTarget(null); }}
                onClose={() => setDeleteTarget(null)}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Permissions Modal ── */}
      {permTarget && (
        <PermissionsModal
          target={permTarget}
          onClose={() => setPermTarget(null)}
          onSaved={(permissions) => {
            setAdmins(prev => prev.map(a => a.uid === permTarget.uid ? { ...a, permissions } : a));
            setSuccessMsg(`Permissions updated for "${permTarget.displayName}".`);
            setPermTarget(null);
          }}
          onError={msg => { setErrorMsg(msg); setPermTarget(null); }}
        />
      )}

      {/* Header row */}
      <div style={s.headerRow}>
        <div>
          <h1 style={s.title}>Admins</h1>
          <p style={s.subtitle}>Manage center administrators</p>
        </div>
        <button
          style={showForm ? s.btnGhost : s.btnPrimary}
          onClick={() => { setShowForm(v => !v); setSuccessMsg(null); setErrorMsg(null); }}
        >
          {showForm ? "✕ Cancel" : "+ Add Admin"}
        </button>
      </div>

      {/* Banners */}
      {successMsg && <div style={s.bannerSuccess}>{successMsg}</div>}
      {errorMsg   && <div style={s.bannerError}>{errorMsg}</div>}

      {/* ── Create Admin Form ── */}
      {showForm && (
        <div style={s.card}>
          <p style={s.cardTitle}>New Admin Details</p>
          <form onSubmit={handleSubmit}>
            <div style={s.grid2}>

              <div style={{ ...s.field, gridColumn: "1 / -1" }}>
                <label style={s.label}>Role</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {([
                    { value: ROLES.ADMIN,       label: "Admin",       desc: "Access can be restricted per section" },
                    { value: ROLES.SUPER_ADMIN, label: "Super Admin", desc: "Always full access to everything" },
                  ] as const).map(opt => {
                    const active = createRole === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setCreateRole(opt.value)}
                        style={{
                          flex: 1, textAlign: "left", padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                          border: active ? "1.5px solid var(--color-accent)" : "1px solid var(--color-border)",
                          background: active ? "var(--color-accent-dim)" : "var(--color-bg)",
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 600, color: active ? "var(--color-accent)" : "var(--color-text-primary)" }}>
                          {opt.label}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                          {opt.desc}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={s.field}>
                <label style={s.label}>Full Name</label>
                <input
                  style={s.input}
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Rahul Sharma"
                  required
                />
              </div>

              <div style={s.field}>
                <label style={s.label}>Email Address</label>
                <input
                  style={s.input}
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="admin@rolsplus.com"
                  required
                />
              </div>

              <div style={s.field}>
                <label style={s.label}>Password</label>
                <div style={{ position: "relative" }}>
                  <input
                    style={{ ...s.input, paddingRight: 52 }}
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Min. 6 characters"
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPw(v => !v)}
                    style={s.showHide}
                  >
                    {showPw ? "Hide" : "Show"}
                  </button>
                </div>
              </div>

              {/* Spacer on right column */}
              <div />

              {createRole === ROLES.ADMIN ? (
                <div style={{ ...s.field, gridColumn: "1 / -1" }}>
                  <label style={s.label}>Access</label>
                  <div style={{ border: "1px solid var(--color-border)", borderRadius: 8, padding: "4px 14px" }}>
                    <PermissionChecklist
                      fullAccess={createFullAccess}
                      setFullAccess={setCreateFullAccess}
                      selected={createSelected}
                      toggle={toggleCreatePerm}
                    />
                  </div>
                </div>
              ) : (
                <div style={{ ...s.field, gridColumn: "1 / -1" }}>
                  <div style={{ background: "var(--color-accent-dim)", border: "1px solid var(--color-accent-border)", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "var(--color-text-secondary)" }}>
                    Super Admins always have full access to every section — this can&apos;t be restricted.
                  </div>
                </div>
              )}

              <div style={{ ...s.field, gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
                <button type="button" style={s.btnGhost} onClick={() => setShowForm(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{ ...s.btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? "not-allowed" : "pointer", minWidth: 130 }}
                  disabled={submitting}
                >
                  {submitting ? "Creating…" : "Create Admin"}
                </button>
              </div>

            </div>
          </form>
        </div>
      )}

      {/* ── Admin List ── */}
      <div style={s.card}>
        <p style={s.cardTitle}>
          All Admins{" "}
          <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>
            ({admins.length})
          </span>
        </p>

        {loading ? (
          <div style={s.emptyState}>Loading…</div>
        ) : admins.length === 0 ? (
          <div style={s.emptyState}>No admins yet. Click "+ Add Admin" to create one.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {["Name", "Email", "Code", "Role", "Status", ""].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {admins.map(a => (
                  <tr key={a.uid} style={s.tr}>
                    <td style={{ ...s.td, color: "var(--color-text-primary)", fontWeight: 500 }}>
                      {a.displayName}
                    </td>
                    <td style={s.td}>{a.email}</td>
                    <td style={s.td}>
                      <span style={s.code}>{a.adminCode}</span>
                    </td>
                    <td style={s.td}>
                      <span style={a.role === ROLES.SUPER_ADMIN ? s.roleSuper : s.roleAdmin}>
                        {a.role === ROLES.SUPER_ADMIN ? "Super Admin" : "Admin"}
                      </span>
                    </td>
                    <td style={s.td}>
                      <span style={a.status === "active" ? s.badgeActive : s.badgeInactive}>
                        {a.status}
                      </span>
                    </td>
                    <td style={s.td}>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        {a.role === ROLES.ADMIN && (
                          <button style={s.permBtn} onClick={() => setPermTarget(a)}>
                            🔐 Permissions
                          </button>
                        )}
                        {a.uid !== user?.uid && (
                          <button style={s.deleteBtn} onClick={() => setDeleteTarget(a)}>
                            ✕ Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Delete Confirm inline ────────────────────────────────────────────────────

function DeleteConfirm({ name, uid, role, currentUserUid, onDeleted, onError, onClose }: {
  name: string; uid: string; role: "admin"; currentUserUid: string;
  onDeleted: () => void; onError: (m: string) => void; onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState("");
  const [busy, setBusy]           = useState(false);
  const confirmWord = name.split(" ")[0] ?? "DELETE";
  const canDelete   = confirmed === confirmWord;

  async function doDelete() {
    if (!canDelete) return;
    setBusy(true);
    try {
      const res = await deleteUserRecord(uid, role, currentUserUid, "super_admin");
      if (res.success) onDeleted();
      else { onError(res.error ?? "Delete failed."); onClose(); }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 6 }}>
        Type <strong style={{ color: "#dc2626" }}>{confirmWord}</strong> to confirm:
      </label>
      <input
        value={confirmed} onChange={e => setConfirmed(e.target.value)}
        placeholder={`Type "${confirmWord}"`}
        style={{ padding: "8px 10px", border: `1px solid ${canDelete ? "#86efac" : "#d1d5db"}`, borderRadius: 6, fontSize: 13, outline: "none", background: "#fff", color: "#111827", width: "100%", boxSizing: "border-box" as const }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
        <button onClick={onClose} style={s.btnGhost}>Cancel</button>
        <button onClick={doDelete} disabled={!canDelete || busy}
          style={{ ...s.btnPrimary, background: canDelete && !busy ? "#dc2626" : "#f3f4f6", color: canDelete && !busy ? "#fff" : "#9ca3af", border: "none", cursor: canDelete && !busy ? "pointer" : "not-allowed" }}>
          {busy ? "Deleting…" : "Delete Admin"}
        </button>
      </div>
    </>
  );
}

// ─── Shared permission checklist ─────────────────────────────────────────────
// Used by both the "New Admin Details" create form and the Permissions modal.

function PermissionChecklist({ fullAccess, setFullAccess, selected, toggle }: {
  fullAccess:    boolean;
  setFullAccess: (v: boolean) => void;
  selected:      Set<string>;
  toggle:        (key: string) => void;
}) {
  const groups = ["Finance", "Insights & Reports", "System Admin"];
  const ungrouped = ADMIN_SECTIONS.filter(sec => !sec.group);

  return (
    <>
      <label style={s.permFullRow}>
        <input type="checkbox" checked={fullAccess} onChange={e => setFullAccess(e.target.checked)} />
        Full Access (all current and future sections)
      </label>

      {ungrouped.map(sec => (
        <label key={sec.key} style={s.permRow}>
          <input
            type="checkbox"
            checked={sec.alwaysOn || fullAccess || selected.has(sec.key)}
            disabled={sec.alwaysOn || fullAccess}
            onChange={() => toggle(sec.key)}
          />
          {sec.label}
        </label>
      ))}

      {groups.map(group => (
        <div key={group}>
          <div style={s.permGroupLabel}>{group}</div>
          {ADMIN_SECTIONS.filter(sec => sec.group === group).map(sec => (
            <label key={sec.key} style={s.permRow}>
              <input
                type="checkbox"
                checked={fullAccess || selected.has(sec.key)}
                disabled={fullAccess}
                onChange={() => toggle(sec.key)}
              />
              {sec.label}
            </label>
          ))}
        </div>
      ))}
    </>
  );
}

// ─── Permissions Modal ────────────────────────────────────────────────────────

function PermissionsModal({ target, onClose, onSaved, onError }: {
  target: AdminRow;
  onClose: () => void;
  onSaved: (permissions: string[] | undefined) => void;
  onError: (msg: string) => void;
}) {
  const [fullAccess, setFullAccess] = useState(target.permissions === undefined);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(target.permissions ?? ADMIN_SECTIONS.map(sec => sec.key))
  );
  const [saving, setSaving] = useState(false);

  function toggle(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const permissions = fullAccess ? deleteField() : Array.from(selected);
      await updateDoc(doc(db, "users", target.uid), { permissions });
      onSaved(fullAccess ? undefined : Array.from(selected));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save permissions.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={{ ...s.modal, maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <span style={s.modalTitle}>🔐 Permissions — {target.displayName}</span>
          <button onClick={onClose} style={s.closeBtn}>×</button>
        </div>
        <div style={{ ...s.modalBody, maxHeight: "60vh", overflowY: "auto" as const }}>
          <PermissionChecklist fullAccess={fullAccess} setFullAccess={setFullAccess} selected={selected} toggle={toggle} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "0 20px 20px" }}>
          <button style={s.btnGhost} onClick={onClose} disabled={saving}>Cancel</button>
          <button
            style={{ ...s.btnPrimary, opacity: saving ? 0.6 : 1, cursor: saving ? "not-allowed" : "pointer" }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save Permissions"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  headerRow:     { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  title:         { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)", margin: 0 },
  subtitle:      { fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 },

  btnPrimary:    { padding: "9px 18px", background: "var(--color-accent)", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  btnGhost:      { padding: "9px 18px", background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" },

  bannerSuccess: { borderRadius: 8, padding: "10px 16px", fontSize: 13, marginBottom: 16, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" },
  bannerError:   { borderRadius: 8, padding: "10px 16px", fontSize: 13, marginBottom: 16, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" },

  card:          { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 24, marginBottom: 24 },
  cardTitle:     { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 20, marginTop: 0 },

  grid2:         { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px" },
  field:         { display: "flex", flexDirection: "column", gap: 6 },
  label:         { fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" },
  input:         { background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "9px 12px", fontSize: 14, color: "var(--color-text-primary)", outline: "none", width: "100%", boxSizing: "border-box" },
  showHide:      { position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--color-text-secondary)", fontSize: 11, cursor: "pointer", padding: 0 },

  table:         { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:            { textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" },
  tr:            { borderBottom: "1px solid var(--color-border)" },
  td:            { padding: "12px", color: "var(--color-text-secondary)", verticalAlign: "middle" },

  code:          { fontFamily: "monospace", fontSize: 12, background: "#f0dde1", color: "#8b3a4a", padding: "2px 8px", borderRadius: 4 },
  badgeActive:   { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#f0fdf4", color: "#166534" },
  badgeInactive: { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#f3f4f6", color: "#6b7280" },
  roleAdmin:     { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#eef2ff", color: "#4338ca" },
  roleSuper:     { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#fef3c7", color: "#92400e" },

  emptyState:    { textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 14 },
  deleteBtn:     { padding: "5px 12px", background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  permBtn:       { padding: "5px 12px", background: "#eef2ff", color: "#4338ca", border: "1px solid #c7d2fe", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const },
  permGroupLabel:{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.05em", color: "var(--color-text-secondary)", margin: "16px 0 8px" },
  permRow:       { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 13, color: "var(--color-text-primary)" },
  permFullRow:   { display: "flex", alignItems: "center", gap: 8, padding: "10px 0", marginBottom: 8, borderBottom: "1px solid var(--color-border)", fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" },

  // Modal
  overlay:       { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:         { background: "#fff", borderRadius: 12, width: "100%", maxWidth: 440, boxShadow: "0 8px 32px rgba(0,0,0,0.16)", overflow: "hidden" },
  modalHeader:   { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e5e7eb" },
  modalTitle:    { fontSize: 15, fontWeight: 600, color: "#111" },
  closeBtn:      { background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#6b7280", lineHeight: 1 },
  modalBody:     { padding: "20px" },
};
