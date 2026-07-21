"use client";

import { useState, useEffect, useMemo, Fragment } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, query, where, doc, setDoc, getDoc, serverTimestamp, onSnapshot } from "firebase/firestore";
import { db } from "@/config/firebase";
import { useAuthContext } from "@/features/auth/AuthContext";
import { getCenters } from "@/services/center/center.service";
import { hasSectionAccess } from "@/lib/validators/auth.validators";
import type { Center } from "@/types";

// ── Date/label helpers (small, pure — duplicated from app/dashboard/page.tsx,
//    which CommandCenter also depends on and can't re-export per Next's page
//    module constraints) ──────────────────────────────────────────────────────
function isoMonthStart(offset = 0): string {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - offset);
  return d.toISOString().slice(0, 7);
}

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseClassEndMinutes(timeSlot: string): number | null {
  const m24 = timeSlot.match(/\d{1,2}:\d{2}\s*[–\-]\s*(\d{1,2}):(\d{2})/);
  if (m24) return parseInt(m24[1]) * 60 + parseInt(m24[2]);
  const m12 = timeSlot.match(/\d{1,2}:\d{2}\s*(?:AM|PM)\s*[–\-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m12) {
    let h = parseInt(m12[1]);
    const ampm = m12[3].toUpperCase();
    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return h * 60 + parseInt(m12[2]);
  }
  return null;
}

function classHasEnded(timeSlot: string): boolean {
  const end = parseClassEndMinutes(timeSlot);
  if (end === null) return true;
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes() >= end;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface AdminStudentDoc {
  uid:            string;
  centerId:       string;
  status:         string;
  classType:      string;
  currentBalance: number;
  createdAt:      string;
  lastBilledMonth: string | null;
}

interface AdminTeacherDoc {
  uid:        string;
  displayName:string;
  centerIds:  string[];
  status:     string;
}

interface BillingMonthStatus {
  month:          string;   // "YYYY-MM"
  completed:      boolean;
  completedAt:    string | null;
  completedBy:    string | null;
  alertSent:      boolean;
  collectedAmt:   number;
  billedCount:    number;
  paidCount:      number;
}

// ── Admin Dashboard Component ──────────────────────────────────────────────────
export function AdminDashboard() {
  const { user } = useAuthContext();
  const router   = useRouter();

  // Highlights are scoped to this admin's own granted sections — undefined
  // permissions (never restricted) shows everything, same as full access elsewhere.
  const canStudents   = hasSectionAccess(user, "students");
  const canCenters     = hasSectionAccess(user, "centers");
  const canTeachers    = hasSectionAccess(user, "teachers");
  const canAttendance  = hasSectionAccess(user, "attendance");
  const canFees        = hasSectionAccess(user, "fees");

  const today     = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const thisMonth = useMemo(() => today.slice(0, 7), [today]);
  // Last 3 months including current
  const months3   = useMemo(() => [thisMonth, isoMonthStart(1), isoMonthStart(2)], [thisMonth]);

  const [students,  setStudents]  = useState<AdminStudentDoc[]>([]);
  const [teachers,  setTeachers]  = useState<AdminTeacherDoc[]>([]);
  const [centers,   setCenters]   = useState<Center[]>([]);
  const [txList,    setTxList]    = useState<{ month: string; amount: number; studentUid: string; status: string; type: string; method: string; billingMonth: string }[]>([]);
  const [billing,   setBilling]   = useState<Record<string, BillingMonthStatus>>({});
  const [monthAttRecs, setMonthAttRecs] = useState<{ centerId: string; status: string; markedBy: string; markedAt: string; date: string }[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [completing,      setCompleting]      = useState<string | null>(null); // month being marked complete
  const [showPending,       setShowPending]       = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    async function load() {
      try {
        const [studSnap, teachSnap, centersData, txSnap, ...billingSnaps] = await Promise.all([
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
          getDocs(query(collection(db, "users"), where("role", "==", "teacher"))),
          getCenters(),
          getDocs(query(collection(db, "transactions"), where("date", ">=", isoMonthStart(2)))),
          ...months3.map(m => getDoc(doc(db, "billing_months", m))),
        ]);

        const studs: AdminStudentDoc[] = studSnap.docs.map(d => ({
          uid:            d.id,
          centerId:       (d.data().centerId   ?? "") as string,
          status:         (d.data().status ?? d.data().studentStatus ?? "active") as string,
          classType:      (d.data().classType  ?? "group") as string,
          currentBalance: Number(d.data().currentBalance ?? 0),
          createdAt:      (d.data().createdAt  ?? "") as string,
          lastBilledMonth:(d.data().lastBilledMonth ?? null) as string | null,
        }));
        setStudents(studs);

        setTeachers(teachSnap.docs.map(d => ({
          uid:         d.id,
          displayName: (d.data().displayName ?? d.data().name ?? "—") as string,
          centerIds:   (d.data().centerIds   ?? []) as string[],
          status:      (d.data().status      ?? "active") as string,
        })));

        setCenters(centersData);

        const txs = txSnap.docs.map(d => ({
          month:        ((d.data().date as string | undefined) ?? "").slice(0, 7),
          amount:       Number(d.data().amount ?? 0),
          studentUid:   (d.data().studentUid   ?? "") as string,
          status:       (d.data().status        ?? "") as string,
          type:         (d.data().type          ?? "") as string,
          method:       (d.data().method        ?? "") as string,
          billingMonth: (d.data().billingMonth  ?? "") as string,
        }));
        setTxList(txs);

        // Build billing status map — merge Firestore doc with derived stats
        const bMap: Record<string, BillingMonthStatus> = {};
        months3.forEach((m, i) => {
          const snap = billingSnaps[i];
          const data  = snap.exists() ? snap.data() as Partial<BillingMonthStatus> : {};
          const monthTx   = txs.filter(t => t.month === m && t.status === "completed");
          const collectedAmt = monthTx.reduce((acc, t) => acc + t.amount, 0);
          const billedCount  = studs.filter(s => s.lastBilledMonth === m && s.status === "active").length;
          const paidCount    = monthTx.length;
          bMap[m] = {
            month:       m,
            completed:   data.completed   ?? false,
            completedAt: data.completedAt ?? null,
            completedBy: data.completedBy ?? null,
            alertSent:   data.alertSent   ?? false,
            collectedAmt,
            billedCount,
            paidCount,
          };
        });
        setBilling(bMap);
      } catch (err) {
        console.error("[AdminDashboard] load error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, today]);

  // ── Real-time attendance listener — covers the full current month ─────────
  useEffect(() => {
    if (!user) return;
    const monthStart = thisMonth + "-01";
    const q = query(collection(db, "attendance"), where("date", ">=", monthStart));
    const unsub = onSnapshot(q, snap => {
      setMonthAttRecs(snap.docs
        .filter(d => ((d.data().date as string | undefined) ?? "").startsWith(thisMonth))
        .map(d => ({
          centerId: (d.data().centerId ?? "") as string,
          status:   (d.data().status   ?? "") as string,
          markedBy: (d.data().markedBy ?? "") as string,
          markedAt: (d.data().markedAt ?? "") as string,
          date:     (d.data().date     ?? "") as string,
        })));
    });
    return () => unsub();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, thisMonth]);

  // ── Mark month complete ──────────────────────────────────────────────────
  async function markMonthComplete(month: string) {
    if (!user) return;
    setCompleting(month);
    try {
      const payload: BillingMonthStatus = {
        month,
        completed:   true,
        completedAt: new Date().toISOString(),
        completedBy: user.uid,
        alertSent:   billing[month]?.alertSent ?? false,
        collectedAmt:billing[month]?.collectedAmt ?? 0,
        billedCount: billing[month]?.billedCount ?? 0,
        paidCount:   billing[month]?.paidCount ?? 0,
      };
      await setDoc(doc(db, "billing_months", month), { ...payload, updatedAt: serverTimestamp() }, { merge: true });
      setBilling(prev => ({ ...prev, [month]: payload }));
    } catch (err) {
      console.error("[AdminDashboard] markMonthComplete error:", err);
    } finally {
      setCompleting(null);
    }
  }

  // ── Derived stats ────────────────────────────────────────────────────────
  const activeStudents  = students.filter(s => s.status === "active").length;
  const groupStudents   = students.filter(s => s.classType === "group").length;
  const personalStudents = students.filter(s => s.classType === "personal").length;
  const feeDueMap = useMemo(() => {
    const m = new Map<string, number>();
    txList.forEach(tx => {
      if (!tx.studentUid || tx.type !== "fee_due") return;
      const bm = tx.billingMonth || tx.month;
      if (bm === thisMonth) m.set(tx.studentUid, tx.amount);
    });
    return m;
  }, [txList, thisMonth]);

  const paidSet = useMemo(() => {
    const s = new Set<string>();
    txList.forEach(tx => {
      if (!tx.studentUid || tx.status !== "completed" || tx.month !== thisMonth) return;
      if (tx.type === "fee_due" || tx.type === "charge" || tx.method === "auto" || tx.method === "auto-monthly") return;
      s.add(tx.studentUid);
    });
    return s;
  }, [txList, thisMonth]);

  const pendingFeeAmt = useMemo(() => {
    let amt = 0;
    feeDueMap.forEach((fee, uid) => { if (!paidSet.has(uid)) amt += fee; });
    return amt;
  }, [feeDueMap, paidSet]);

  const pendingFeeCount = useMemo(() => {
    let n = 0;
    feeDueMap.forEach((_, uid) => { if (!paidSet.has(uid)) n++; });
    return n;
  }, [feeDueMap, paidSet]);
  // Today's records derived from the month listener
  const todayAttRecs = useMemo(() => monthAttRecs.filter(r => r.date === today), [monthAttRecs, today]);

  const attStats = useMemo(() =>
    todayAttRecs.length > 0
      ? { present: todayAttRecs.filter(r => r.status === "present").length, total: todayAttRecs.length }
      : null,
  [todayAttRecs]);
  const attPct          = attStats && attStats.total > 0 ? Math.round((attStats.present / attStats.total) * 100) : null;
  const attBad          = attPct !== null && attPct < 60;

  // Monthly attendance totals — every student remark counts
  const monthlyTotals = useMemo(() => ({
    present:   monthAttRecs.filter(r => r.status === "present").length,
    absent:    monthAttRecs.filter(r => r.status === "absent").length,
    break:     monthAttRecs.filter(r => r.status === "break").length,
    cancelled: monthAttRecs.filter(r => r.status?.startsWith("cancelled")).length,
    total:     monthAttRecs.length,
  }), [monthAttRecs]);

  // This month billing
  const thisMonthBilling = billing[thisMonth];
  const activeCount      = students.filter(s => s.status === "active").length;
  const billedThisMonth  = thisMonthBilling?.billedCount ?? 0;
  const paidThisMonth    = thisMonthBilling?.paidCount ?? 0;
  const collectedThisMonth = thisMonthBilling?.collectedAmt ?? 0;
  const unbilledCount    = activeCount - billedThisMonth;
  const unpaidCount      = billedThisMonth - paidThisMonth;

  // Teacher name lookup
  const adminTeacherMap = useMemo(() => {
    const m: Record<string, string> = {};
    teachers.forEach(t => { m[t.uid] = t.displayName; });
    return m;
  }, [teachers]);

  // Any attendance record for a centre today = marked (regardless of status or count)
  const markedCentreIds = useMemo(() => {
    const s = new Set<string>();
    todayAttRecs.forEach(r => { if (r.centerId) s.add(r.centerId); });
    return s;
  }, [todayAttRecs]);

  // Info for the notification panel — one entry per marked centre
  const markedCentresInfo = useMemo(() => Array.from(markedCentreIds).map(cid => {
    const centre = centers.find(c => c.id === cid);
    const recs   = todayAttRecs.filter(r => r.centerId === cid);
    const first  = [...recs].sort((a, b) => a.markedAt.localeCompare(b.markedAt))[0];
    const markedTime  = first?.markedAt
      ? new Date(first.markedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
      : "";
    const teacherName = adminTeacherMap[first?.markedBy ?? ""] ?? "";
    const p  = recs.filter(r => r.status === "present").length;
    const a  = recs.filter(r => r.status === "absent").length;
    const br = recs.filter(r => r.status === "break").length;
    const ca = recs.filter(r => r.status?.startsWith("cancelled")).length;
    const parts: string[] = [];
    if (p  > 0) parts.push(`${p} present`);
    if (a  > 0) parts.push(`${a} absent`);
    if (br > 0) parts.push(`${br} break`);
    if (ca > 0) parts.push("cancelled");
    return {
      cid, name: centre?.name ?? "Centre", markedTime, teacherName,
      summary: parts.join(" · ") || `${recs.length} marked`,
    };
  }), [markedCentreIds, todayAttRecs, centers, adminTeacherMap]);

  // Today's classes
  const todayDow    = useMemo(() => DAY_ABBR[new Date(today + "T00:00:00").getDay()], [today]);
  const todayCentres = useMemo(() =>
    centers.filter(c => ((c as Center & { daysOfWeek?: string[] }).daysOfWeek ?? []).includes(todayDow)),
    [centers, todayDow]
  );

  // ── Alerts ───────────────────────────────────────────────────────────────
  const alerts = useMemo(() => {
    const list: { icon: string; msg: string; level: "critical" | "warning"; action?: string; href?: string }[] = [];

    // Deactivation requests
    const pendingDeact = students.filter(s => s.status === "deactivation_requested").length;
    if (pendingDeact > 0)
      list.push({ icon: "🔔", msg: `${pendingDeact} deactivation request${pendingDeact > 1 ? "s" : ""} pending approval`, level: "critical", action: "Review", href: "/dashboard/students" });

    // Attendance low
    if (attPct !== null && attPct < 60)
      list.push({ icon: "📉", msg: `Attendance low today — only ${attPct}%`, level: "critical", action: "View", href: "/dashboard/attendance" });

    // Overdue fees
    if (pendingFeeAmt > 0)
      list.push({ icon: "💰", msg: `₹${pendingFeeAmt.toLocaleString("en-IN")} outstanding — ${pendingFeeCount} student${pendingFeeCount > 1 ? "s" : ""}`, level: "warning", action: "Collect", href: "/dashboard/finance" });

    // Teachers with no center assigned
    const unassignedTeachers = teachers.filter(t => t.status === "active" && (!t.centerIds || t.centerIds.length === 0));
    if (unassignedTeachers.length > 0)
      list.push({ icon: "👤", msg: `${unassignedTeachers.length} teacher${unassignedTeachers.length > 1 ? "s" : ""} not assigned to any centre`, level: "warning", action: "Assign", href: "/dashboard/centers" });

    // Inactive teachers
    const inactiveTeachers = teachers.filter(t => t.status !== "active").length;
    if (inactiveTeachers > 0)
      list.push({ icon: "😴", msg: `${inactiveTeachers} teacher${inactiveTeachers > 1 ? "s" : ""} marked inactive`, level: "warning", action: "Review", href: "/dashboard/teachers" });

    // Centers with no students
    const emptyCenters = centers.filter(c => !students.some(s => s.centerId === c.id && s.status === "active"));
    if (emptyCenters.length > 0)
      list.push({ icon: "🏫", msg: `${emptyCenters.length} centre${emptyCenters.length > 1 ? "s" : ""} with no active students: ${emptyCenters.map(c => c.name).join(", ")}`, level: "warning", action: "View", href: "/dashboard/centers" });

    // Unbilled students this month
    if (unbilledCount > 0 && !thisMonthBilling?.completed)
      list.push({ icon: "📋", msg: `${unbilledCount} student${unbilledCount > 1 ? "s" : ""} not yet billed for ${monthLabel(thisMonth)}`, level: "warning", action: "Bill", href: "/dashboard/finance" });

    return list;
  }, [students, teachers, centers, attPct, pendingFeeAmt, pendingFeeCount, unbilledCount, thisMonth, thisMonthBilling]);

  // Alerts each point at one section (via href) — hide any this admin can't access
  const alertSectionByHref: Record<string, string> = {
    "/dashboard/students": "students",
    "/dashboard/attendance": "attendance",
    "/dashboard/finance": "fees",
    "/dashboard/centers": "centers",
    "/dashboard/teachers": "teachers",
  };
  const visibleAlerts = useMemo(() => alerts.filter(a => {
    if (!a.href) return true;
    const key = alertSectionByHref[a.href];
    return !key || hasSectionAccess(user, key);
  }), [alerts, user]);

  const quickItems = useMemo(() => ([
    { icon: "🎓", label: "Students",   sub: `${activeStudents} active`, href: "/dashboard/students", sectionKey: "students" },
    { icon: "🏫", label: "Centres",    sub: `${centers.length} total`, href: "/dashboard/centers", sectionKey: "centers" },
    { icon: "👤", label: "Teachers",   sub: `${teachers.filter(t => t.status === "active").length} active`, href: "/dashboard/teachers", sectionKey: "teachers" },
    { icon: "💰", label: "Finance",    sub: "Collect & track fees", href: "/dashboard/finance", sectionKey: "fees" },
    { icon: "📊", label: "Attendance", sub: "View & mark", href: "/dashboard/attendance", sectionKey: "attendance" },
    { icon: "📚", label: "Syllabus",   sub: "Lessons & progress", href: "/dashboard/syllabus", sectionKey: "syllabus" },
  ] as const).filter(item => hasSectionAccess(user, item.sectionKey)),
  [user, activeStudents, centers, teachers]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={adm.page}>

      {/* ── HEADER ── */}
      {(() => {
        const pendingCentres = todayCentres.filter(c => !markedCentreIds.has(c.id) && classHasEnded(c.timeSlot ?? ""));
        const pendingCount   = pendingCentres.length;
        return (
          <>
            <div style={adm.header}>
              <div>
                <div style={adm.eyebrow}>Admin Suite</div>
                <div style={adm.date}>
                  {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                </div>
                <div style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
                  Welcome back, {user?.displayName}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                {canAttendance && (
                  <>
                    {/* Notification icon */}
                    <button
                      title="Notifications"
                      onClick={() => { setShowNotifications(v => !v); setShowPending(false); }}
                      style={{
                        position: "relative", width: 38, height: 38, borderRadius: "50%", border: "1px solid var(--color-border)",
                        background: showNotifications ? "var(--color-accent-dim,#f0dde1)" : "var(--color-surface-2)",
                        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0,
                      }}>
                      🔔
                      {markedCentreIds.size > 0 && (
                        <span style={{
                          position: "absolute", top: 1, right: 1, background: "#16a34a", color: "#fff",
                          borderRadius: "50%", width: 15, height: 15, fontSize: 8, fontWeight: 800,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                          {markedCentreIds.size}
                        </span>
                      )}
                    </button>
                    {/* Pending icon */}
                    <button
                      title="Pending tasks"
                      onClick={() => { setShowPending(v => !v); setShowNotifications(false); }}
                      style={{
                        position: "relative", width: 38, height: 38, borderRadius: "50%", border: "1px solid var(--color-border)",
                        background: showPending ? "var(--color-accent-dim,#f0dde1)" : "var(--color-surface-2)",
                        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0,
                      }}>
                      ⏳
                      {pendingCount > 0 && (
                        <span style={{
                          position: "absolute", top: 1, right: 1, background: "#ef4444", color: "#fff",
                          borderRadius: "50%", width: 15, height: 15, fontSize: 8, fontWeight: 800,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                          {pendingCount}
                        </span>
                      )}
                    </button>
                    <div style={{ width: 1, height: 28, background: "var(--color-border)", margin: "0 2px" }} />
                  </>
                )}
                <div style={adm.quickActions}>
                  {canStudents && <button style={adm.qaBtn} onClick={() => router.push("/dashboard/students")}>+ Student</button>}
                  {canTeachers && <button style={adm.qaBtn} onClick={() => router.push("/dashboard/teachers")}>+ Teacher</button>}
                  {canCenters  && <button style={adm.qaBtn} onClick={() => router.push("/dashboard/centers")}>+ Centre</button>}
                  {canFees     && <button style={{ ...adm.qaBtn, ...adm.qaBtnPrimary }} onClick={() => router.push("/dashboard/finance")}>Finance →</button>}
                </div>
              </div>
            </div>

            {/* Notification panel */}
            {showNotifications && (
              <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, marginBottom: 16, overflow: "hidden", boxShadow: "var(--shadow-sm)" }}>
                <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)" }}>🔔 Attendance — Today</span>
                  <button onClick={() => setShowNotifications(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-muted)", fontSize: 16 }}>✕</button>
                </div>
                {markedCentresInfo.length === 0 ? (
                  <div style={{ padding: "28px 20px", textAlign: "center", fontSize: 13, color: "var(--color-text-muted)" }}>
                    No attendance marked yet today
                  </div>
                ) : (
                  <div style={{ padding: "0 20px 8px" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em", padding: "12px 0 6px" }}>
                      Marked today
                    </div>
                    {markedCentresInfo.map((info, i) => (
                      <div key={info.cid} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "11px 0", borderTop: i === 0 ? "none" : "1px solid var(--color-border)" }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-success)" }}>✓ {info.name}</div>
                          <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 3 }}>
                            {info.summary}{info.teacherName ? ` · by ${info.teacherName}` : ""}
                          </div>
                        </div>
                        {info.markedTime && (
                          <span style={{ fontSize: 11, fontWeight: 700, background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0", borderRadius: 99, padding: "3px 10px", whiteSpace: "nowrap" as const, flexShrink: 0, marginTop: 2 }}>
                            {info.markedTime}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Pending panel */}
            {showPending && (() => {
              const unmarked = todayCentres.filter(c => !markedCentreIds.has(c.id) && classHasEnded(c.timeSlot ?? ""));
              // Group by teacher
              const byTeacher: Record<string, { teacherName: string; centres: string[] }> = {};
              unmarked.forEach(c => {
                const tUid  = (c as Center & { teacherUid?: string }).teacherUid ?? "";
                const tName = adminTeacherMap[tUid] ?? "Unassigned";
                if (!byTeacher[tUid]) byTeacher[tUid] = { teacherName: tName, centres: [] };
                byTeacher[tUid].centres.push(c.name);
              });
              const rows = Object.values(byTeacher);
              return (
                <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, marginBottom: 16, overflow: "hidden", boxShadow: "var(--shadow-sm)" }}>
                  <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)" }}>⏳ Pending Tasks</span>
                    <button onClick={() => setShowPending(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-muted)", fontSize: 16 }}>✕</button>
                  </div>
                  {rows.length === 0 ? (
                    <div style={{ padding: "24px 20px", textAlign: "center", fontSize: 13, color: "var(--color-success)", fontWeight: 600 }}>
                      ✅ All caught up — every centre has attendance marked today!
                    </div>
                  ) : (
                    <div style={{ padding: "0 20px 8px" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", padding: "12px 0 6px" }}>
                        Teachers who haven't marked attendance today
                      </div>
                      {rows.map((row, i) => (
                        <div key={row.teacherName} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "11px 0", borderTop: i === 0 ? "none" : "1px solid var(--color-border)" }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)" }}>{row.teacherName}</div>
                            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 3 }}>
                              {row.centres.join(" · ")}
                            </div>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 700, background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 99, padding: "3px 10px", whiteSpace: "nowrap" as const, flexShrink: 0, marginTop: 2 }}>
                            {row.centres.length} centre{row.centres.length > 1 ? "s" : ""} pending
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        );
      })()}

      {/* ── KPI STRIP — only the sections this admin has been granted ── */}
      {(() => {
        const tiles = [
          {
            key: "students", visible: canStudents,
            node: <KpiTile label="Students" value={loading ? "…" : String(students.length)} sub={loading ? "" : `${activeStudents} active · ${groupStudents} group · ${personalStudents} personal`} />,
          },
          {
            key: "centers", visible: canCenters,
            node: <KpiTile label="Centres" value={loading ? "…" : String(centers.length)} sub={`${centers.filter(c => c.status === "active").length} active`} />,
          },
          {
            key: "teachers", visible: canTeachers,
            node: <KpiTile label="Teachers" value={loading ? "…" : String(teachers.length)} sub={`${teachers.filter(t => t.status === "active").length} active`} />,
          },
          {
            key: "attendance", visible: canAttendance,
            node: (
              <KpiTile
                label="Attendance Today"
                value={loading ? "…" : !attStats ? "—" : `${attPct ?? 0}%`}
                sub={loading ? "" : !attStats ? "No records yet" : `${attStats.present} / ${attStats.total} present`}
                valueColor={attBad ? "var(--color-danger)" : attPct !== null ? "var(--color-success)" : undefined}
              />
            ),
          },
          {
            key: "fees", visible: canFees,
            node: (
              <KpiTile
                label="Pending Fees"
                value={loading ? "…" : pendingFeeAmt === 0 ? "All Clear" : `₹${pendingFeeAmt.toLocaleString("en-IN")}`}
                sub={loading ? "" : pendingFeeAmt === 0 ? "All collected" : `${pendingFeeCount} students due`}
                valueColor={pendingFeeAmt > 0 ? "var(--color-warning)" : "var(--color-success)"}
              />
            ),
          },
        ].filter(t => t.visible);

        if (tiles.length === 0) return null;
        return (
          <div style={adm.kpiStrip}>
            {tiles.map((t, i) => (
              <Fragment key={t.key}>
                {i > 0 && <div style={adm.kpiDiv} />}
                {t.node}
              </Fragment>
            ))}
          </div>
        );
      })()}

      {/* ── TODAY'S CLASSES ── */}
      {canAttendance && todayCentres.length > 0 && (
        <div style={adm.section}>
          <div style={adm.secHeader}>
            <span style={adm.secTitle}>Today's Classes</span>
            <span style={adm.secSub}>{new Date().toLocaleDateString("en-IN", { weekday: "long" })}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {todayCentres.map(c => {
              const marked = markedCentreIds.has(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => router.push("/dashboard/attendance")}
                  style={{
                    background: marked ? "var(--color-success-dim)" : "var(--color-danger-dim)",
                    border: `1px solid ${marked ? "var(--color-success-border)" : "var(--color-danger-border)"}`,
                    borderRadius: 10, padding: "12px 16px",
                    textAlign: "left", cursor: "pointer",
                    display: "flex", flexDirection: "column", gap: 5, minWidth: 130,
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 700, color: marked ? "var(--color-success)" : "var(--color-danger)" }}>
                    {marked ? "✓ Marked" : "! Pending"}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)", lineHeight: 1.3 }}>{c.name}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── MONTHLY ATTENDANCE TOTALS ── */}
      {canAttendance && (
        <div style={adm.section}>
          <div style={adm.secHeader}>
            <span style={adm.secTitle}>Attendance This Month</span>
            <span style={adm.secSub}>{monthLabel(thisMonth)} · all student records</span>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const }}>
            {[
              { label: "Present",   value: monthlyTotals.present,   color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
              { label: "Absent",    value: monthlyTotals.absent,     color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
              { label: "Break",     value: monthlyTotals.break,      color: "#a05a2c", bg: "#f7ece1", border: "#e0c19f" },
              { label: "Cancelled", value: monthlyTotals.cancelled,  color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb" },
              { label: "Total",     value: monthlyTotals.total,      color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe" },
            ].map(({ label, value, color, bg, border }) => (
              <div key={label} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: "12px 20px", minWidth: 100, textAlign: "center" as const }}>
                <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginTop: 4, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>{label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── MONTHLY FINANCE PANEL ── */}
      {canFees && (
      <div style={adm.section}>
        <div style={adm.secHeader}>
          <span style={adm.secTitle}>Monthly Fee Collection</span>
          <span style={adm.secSub}>3-month view · tap a month to mark complete</span>
        </div>

        {/* Current month status strip */}
        {!loading && thisMonthBilling && (
          <div style={{
            ...adm.monthStatusBar,
            background: thisMonthBilling.completed ? "var(--color-success-dim, #f0fdf4)" : "var(--color-warning-dim, #f7ece1)",
            border: `1px solid ${thisMonthBilling.completed ? "var(--color-success-border, #bbf7d0)" : "var(--color-warning-border, #e0c19f)"}`,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 4 }}>
                {thisMonthBilling.completed ? "✅" : "📋"} {monthLabel(thisMonth)}
                {thisMonthBilling.completed && (
                  <span style={{ marginLeft: 10, fontSize: 11, color: "var(--color-success)", fontWeight: 600, background: "#dcfce7", borderRadius: 99, padding: "2px 9px" }}>COMPLETED</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" as const }}>
                <MonthStatChip label="Billed" value={billedThisMonth} total={activeCount} />
                <MonthStatChip label="Paid" value={paidThisMonth} total={billedThisMonth} />
                <MonthStatChip label="Unpaid" value={unpaidCount} total={billedThisMonth} warn={unpaidCount > 0} />
                <div style={{ fontSize: 12 }}>
                  <span style={{ color: "var(--color-text-muted)" }}>Collected </span>
                  <span style={{ fontWeight: 700, color: "var(--color-success)" }}>₹{collectedThisMonth.toLocaleString("en-IN")}</span>
                </div>
              </div>
            </div>
            {!thisMonthBilling.completed && (
              <button
                style={{
                  ...adm.completeBtn,
                  opacity: completing === thisMonth ? 0.6 : 1,
                  cursor: completing === thisMonth ? "default" : "pointer",
                }}
                disabled={completing === thisMonth}
                onClick={() => markMonthComplete(thisMonth)}
              >
                {completing === thisMonth ? "Saving…" : `✓ Complete ${monthLabel(thisMonth)}`}
              </button>
            )}
            {thisMonthBilling.completed && thisMonthBilling.completedAt && (
              <div style={{ fontSize: 11, color: "var(--color-success)", textAlign: "right" }}>
                Marked done<br />
                {new Date(thisMonthBilling.completedAt).toLocaleDateString("en-IN")}
              </div>
            )}
          </div>
        )}

        {/* 3-month history table */}
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={adm.table}>
            <thead>
              <tr>
                {["Month", "Billed", "Paid", "Unpaid", "Collected", "Status"].map(h => (
                  <th key={h} style={adm.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading
                ? <tr><td colSpan={6} style={{ ...adm.td, textAlign: "center", color: "var(--color-text-muted)", padding: 20 }}>Loading…</td></tr>
                : months3.map(m => {
                    const b = billing[m];
                    if (!b) return null;
                    const isPast = m !== thisMonth;
                    return (
                      <tr key={m} style={{ background: m === thisMonth ? "var(--color-surface-2, #f9fafb)" : "transparent" }}>
                        <td style={{ ...adm.td, fontWeight: 700, color: "var(--color-text-primary)" }}>
                          {monthLabel(m)}
                          {m === thisMonth && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--color-accent)", background: "var(--color-accent-dim,#f0dde1)", borderRadius: 99, padding: "1px 7px", fontWeight: 700 }}>CURRENT</span>}
                        </td>
                        <td style={adm.td}>{b.billedCount} <span style={{ color: "var(--color-text-muted)", fontSize: 11 }}>/ {activeCount}</span></td>
                        <td style={{ ...adm.td, color: "var(--color-success)" }}>{b.paidCount}</td>
                        <td style={{ ...adm.td, color: b.billedCount - b.paidCount > 0 ? "var(--color-danger)" : "var(--color-success)" }}>
                          {b.billedCount - b.paidCount}
                        </td>
                        <td style={{ ...adm.td, fontWeight: 700 }}>₹{b.collectedAmt.toLocaleString("en-IN")}</td>
                        <td style={adm.td}>
                          {b.completed
                            ? <span style={adm.pillDone}>✅ Done</span>
                            : isPast
                              ? <button style={{ ...adm.completeBtn, fontSize: 11, padding: "5px 12px", opacity: completing === m ? 0.6 : 1 }}
                                  disabled={completing === m}
                                  onClick={() => markMonthComplete(m)}>
                                  {completing === m ? "…" : "Mark Done"}
                                </button>
                              : <span style={adm.pillPending}>In Progress</span>
                          }
                        </td>
                      </tr>
                    );
                  })
              }
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* ── ALERTS — filtered to sections this admin can access ── */}
      <div style={adm.section}>
        <div style={adm.secHeader}>
          <span style={adm.secTitle}>Needs Attention</span>
          {!loading && visibleAlerts.length > 0 && (
            <span style={adm.alertCountBadge}>{visibleAlerts.length}</span>
          )}
        </div>

        {loading
          ? <div style={adm.emptyRow}>Loading…</div>
          : visibleAlerts.length === 0
            ? <div style={{ ...adm.emptyRow, color: "var(--color-success)" }}>✓ Everything looks healthy — no issues.</div>
            : visibleAlerts.map((a, i) => (
                <div key={i} style={{ ...adm.alertRow, borderLeft: `3px solid ${a.level === "critical" ? "var(--color-danger)" : "var(--color-warning)"}` }}>
                  <span style={adm.alertIcon}>{a.icon}</span>
                  <span style={adm.alertMsg}>{a.msg}</span>
                  {a.href && (
                    <button style={adm.alertActionBtn} onClick={() => router.push(a.href!)}>
                      {a.action ?? "Go"} →
                    </button>
                  )}
                </div>
              ))
        }
      </div>

      {/* ── QUICK ACCESS — filtered to sections this admin can access ── */}
      <div style={adm.quickGrid}>
        {quickItems.map(item => (
          <button key={item.href} style={adm.quickCard} onClick={() => router.push(item.href)}>
            <span style={adm.quickIcon}>{item.icon}</span>
            <span style={adm.quickLabel}>{item.label}</span>
            <span style={adm.quickSub}>{item.sub}</span>
          </button>
        ))}
      </div>

    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function KpiTile({ label, value, sub, valueColor }: { label: string; value: string; sub: string; valueColor?: string }) {
  return (
    <div style={adm.kpi}>
      <div style={adm.kpiLabel}>{label}</div>
      <div style={{ ...adm.kpiValue, color: valueColor ?? "var(--color-text-primary)" }}>{value}</div>
      <div style={adm.kpiSub}>{sub}</div>
    </div>
  );
}

function MonthStatChip({ label, value, total, warn }: { label: string; value: number; total: number; warn?: boolean }) {
  return (
    <div style={{ fontSize: 12 }}>
      <span style={{ color: "var(--color-text-muted)" }}>{label} </span>
      <span style={{ fontWeight: 700, color: warn ? "var(--color-danger)" : "var(--color-text-primary)" }}>{value}</span>
      {total > 0 && <span style={{ color: "var(--color-text-muted)", fontSize: 11 }}>/{total}</span>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const adm: Record<string, React.CSSProperties> = {
  page:    { maxWidth: 1000, margin: "0 auto", paddingBottom: 48 },

  // Header
  header:       { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 },
  eyebrow:      { fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: "var(--color-accent)", textTransform: "uppercase", marginBottom: 4 },
  date:         { fontSize: 18, fontWeight: 700, color: "var(--color-text-primary)" },
  quickActions: { display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "center" },
  qaBtn:        { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--color-text-secondary)" },
  qaBtnPrimary: { background: "var(--color-accent)", color: "#1a140d", border: "none" },

  // KPI strip
  kpiStrip: { display: "flex", alignItems: "stretch", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 14, padding: "20px 24px", marginBottom: 20, gap: 0, boxShadow: "var(--shadow-sm)", flexWrap: "wrap" as const },
  kpi:      { flex: 1, minWidth: 120, padding: "0 14px" },
  kpiDiv:   { width: 1, background: "var(--color-border)", margin: "0 4px" },
  kpiLabel: { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.07em", color: "var(--color-text-muted)", marginBottom: 6 },
  kpiValue: { fontSize: 24, fontWeight: 800, lineHeight: 1, marginBottom: 4 },
  kpiSub:   { fontSize: 11, color: "var(--color-text-muted)", fontWeight: 500 },

  // Section
  section:   { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "18px 20px", marginBottom: 16, boxShadow: "var(--shadow-sm)" },
  secHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  secTitle:  { fontSize: 12, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--color-text-secondary)" },
  secSub:    { fontSize: 11, color: "var(--color-text-muted)" },

  // Monthly finance
  monthStatusBar: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, borderRadius: 10, padding: "14px 18px", flexWrap: "wrap" as const },
  completeBtn: { background: "var(--color-success)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" as const, flexShrink: 0 },
  pillDone:    { fontSize: 11, fontWeight: 700, color: "var(--color-success)", background: "#dcfce7", borderRadius: 99, padding: "3px 10px" },
  pillPending: { fontSize: 11, fontWeight: 600, color: "var(--color-warning)", background: "#f3e3d3", borderRadius: 99, padding: "3px 10px" },

  // Table
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 },
  th:    { textAlign: "left" as const, padding: "8px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.05em", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-2)", whiteSpace: "nowrap" as const },
  td:    { padding: "12px 12px", color: "var(--color-text-secondary)", verticalAlign: "middle" as const, borderBottom: "1px solid var(--color-border-subtle, #f3f4f6)" },

  // Alerts
  alertCountBadge: { fontSize: 11, fontWeight: 700, background: "var(--color-danger-dim)", color: "var(--color-danger)", border: "1px solid var(--color-danger-border)", borderRadius: 99, padding: "1px 8px" },
  alertRow:        { display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 8, borderRadius: 8, background: "var(--color-surface-2, #f9fafb)", borderLeft: "3px solid var(--color-warning)" },
  alertIcon:       { fontSize: 16, flexShrink: 0 },
  alertMsg:        { flex: 1, fontSize: 13, color: "var(--color-text-primary)", lineHeight: 1.4 },
  alertActionBtn:  { fontSize: 12, fontWeight: 700, color: "var(--color-accent)", background: "transparent", border: "1px solid var(--color-border)", borderRadius: 6, padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap" as const },
  emptyRow:        { padding: "16px 4px", fontSize: 13, color: "var(--color-text-muted)" },

  // Quick grid
  quickGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: 12, marginBottom: 16 },
  quickCard: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "18px 16px", display: "flex", flexDirection: "column" as const, alignItems: "flex-start", gap: 4, cursor: "pointer", transition: "box-shadow 0.15s", boxShadow: "var(--shadow-sm)", textAlign: "left" as const },
  quickIcon:  { fontSize: 22, marginBottom: 4 },
  quickLabel: { fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)" },
  quickSub:   { fontSize: 11, color: "var(--color-text-muted)" },
};
