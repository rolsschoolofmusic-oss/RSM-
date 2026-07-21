"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/config/firebase";
import { useAuthContext } from "@/features/auth/AuthContext";
import { ROLES } from "@/config/constants";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { getCenters } from "@/services/center/center.service";
import { getAllTeacherQuality } from "@/services/quality/quality.service";
import type { TeacherQuality } from "@/types/quality";
import type { Center } from "@/types";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface BasicStats {
  totalStudents:     number;
  studentsLast30:    number;
  studentsPrev30:    number;
  totalCenters:      number;
  attendancePresent: number;
  attendanceTotal:   number;
  pendingFees:       number;
}

interface AlertItem {
  id:        string;
  type:      string;
  severity:  "red" | "yellow";
  message:   string;
  createdAt: number;
}

interface StudentDoc {
  uid:            string;
  centerId:       string;
  status:         string;
  classType:      string;  // "group" | "personal"
  currentBalance: number;
  createdAt:      string;
}

interface TeacherDoc {
  uid:          string;
  displayName:  string;
  centerIds:    string[];
  status:       string;
}

interface AttendanceDoc {
  centerId:   string;
  studentUid: string;
  date:       string;
  status:     "present" | "absent";
}

interface TransactionDoc {
  studentUid: string;
  centerId:   string;
  amount:     number;
  date:       string;
  status:     string;
}

interface CenterRow {
  center:         Center;
  studentCount:   number;
  activeCount:    number;
  groupCount:     number;
  personalCount:  number;
  attendancePct:  number | null;
  teacherName:    string;
  pendingFeeCount:number;
  revenue30d:     number;
  growthPct:      number | null;
}

interface SystemData {
  students:     StudentDoc[];
  teachers:     TeacherDoc[];
  centers:      Center[];
  attendance:   AttendanceDoc[];
  transactions: TransactionDoc[];
  quality:      TeacherQuality[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function isoToday(): string { return new Date().toISOString().slice(0, 10); }
function isoDaysAgo(n: number): string { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }
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

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE SHELL
// ═══════════════════════════════════════════════════════════════════════════════

export default function DashboardPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.STUDENT]}>
      <DashboardContent />
    </ProtectedRoute>
  );
}

function DashboardContent() {
  const { user, loading: authLoading } = useAuthContext();
  const router = useRouter();

  // Center Suite is super_admin-only — every other role has its own landing page.
  // (Teacher/student are also bounced by app/dashboard/layout.tsx before this
  // ever renders; the admin redirect is duplicated here as a safety net.)
  useEffect(() => {
    if (authLoading) return;
    if (user?.role === ROLES.STUDENT) router.replace("/dashboard/student");
    if (user?.role === ROLES.ADMIN)   router.replace("/dashboard/admin-suite");
  }, [authLoading, user, router]);

  if (authLoading || !user || user.role === ROLES.STUDENT || user.role === ROLES.ADMIN) return null;
  if (user.role === ROLES.SUPER_ADMIN) return <CommandCenter />;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPER ADMIN — COMMAND CENTER
// Layout: KPI strip → Alerts → Centre table → Teacher leaderboard → Revenue
// ═══════════════════════════════════════════════════════════════════════════════

function CommandCenter() {
  const router = useRouter();
  const [data,    setData]    = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // Stabilise date strings inside useMemo so they never change reference mid-render.
  // Plain const declarations like `const today = isoToday()` return a new string
  // instance on every render — even though the VALUE is the same, some useMemo
  // dependencies compare with Object.is() and would see a change, triggering
  // unnecessary recomputation that cascades into extra re-renders.
  const today     = useMemo(() => isoToday(),       []);
  const days7ago  = useMemo(() => isoDaysAgo(7),    []);
  const days30ago = useMemo(() => isoDaysAgo(30),   []);
  const thisMonth = useMemo(() => isoMonthStart(0), []);
  const lastMonth = useMemo(() => isoMonthStart(1), []);

  useEffect(() => {
    async function load() {
      try {
        const [studentsSnap, teachersSnap, centersSnap, attSnap, txSnap, quality] = await Promise.all([
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
          getDocs(query(collection(db, "users"), where("role", "==", "teacher"))),
          getCenters(),
          getDocs(query(collection(db, "attendance"), where("date", ">=", thisMonth + "-01"))),
          getDocs(collection(db, "transactions")),
          getAllTeacherQuality(),
        ]);
        setData({
          students:     studentsSnap.docs.map(d => ({ uid: d.id, ...d.data() } as StudentDoc)),
          teachers:     teachersSnap.docs.map(d => ({ uid: d.id, ...d.data() } as TeacherDoc)),
          centers:      centersSnap,
          attendance:   attSnap.docs.map(d => d.data() as AttendanceDoc),
          transactions: txSnap.docs.map(d => d.data() as TransactionDoc),
          quality,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load.");
      } finally {
        setLoading(false);
      }
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── All hooks BEFORE any early return ────────────────────────────────────────

  const students     = data?.students     ?? [];
  const teachers     = data?.teachers     ?? [];
  const centers      = data?.centers      ?? [];
  const attendance   = data?.attendance   ?? [];
  const transactions = data?.transactions ?? [];
  const quality      = data?.quality      ?? [];

  // KPI: students
  const totalStudents   = students.length;
  const activeStudents  = students.filter(s => s.status === "active").length;
  const groupStudents   = students.filter(s => s.classType === "group").length;
  const personalStudents = students.filter(s => s.classType === "personal").length;

  // KPI: attendance today
  const todayAtt     = attendance.filter(a => a.date === today);
  const todayPresent = todayAtt.filter(a => a.status === "present").length;
  const todayTotal   = todayAtt.length;
  const todayPct     = todayTotal > 0 ? Math.round((todayPresent / todayTotal) * 100) : null;

  // KPI: revenue this month
  // Only manual payment receipts — excludes fee_due records, auto-charges, and deposits
  // (mirrors the isManualPayment filter in the finance page summary)
  const completedTx  = useMemo(() => transactions.filter(t => {
    const raw = t as unknown as Record<string, unknown>;
    if (t.status !== "completed") return false;
    const type   = (raw.type   as string) ?? "";
    const method = (raw.method as string) ?? "";
    return type !== "fee_due" && type !== "charge" && method !== "auto" && method !== "auto-monthly";
  }), [transactions]);
  const revThisMonth = useMemo(() => completedTx.filter(t => t.date?.startsWith(thisMonth)).reduce((s, t) => s + t.amount, 0), [completedTx, thisMonth]);
  const revLastMonth = useMemo(() => completedTx.filter(t => t.date?.startsWith(lastMonth)).reduce((s, t) => s + t.amount, 0), [completedTx, lastMonth]);
  const revGrowthPct = revLastMonth > 0 ? Math.round(((revThisMonth - revLastMonth) / revLastMonth) * 100) : null;

  // KPI: pending fees — mirrors finance page: fee_due tx for this month, not yet covered by a manual payment
  const feeDueMap = useMemo(() => {
    const m = new Map<string, number>();
    transactions.forEach(tx => {
      const raw = tx as unknown as Record<string, unknown>;
      if (!tx.studentUid || (raw.type as string) !== "fee_due") return;
      const bm = (raw.billingMonth as string) || tx.date.slice(0, 7);
      if (bm === thisMonth) m.set(tx.studentUid, Number(raw.amount ?? 0));
    });
    return m;
  }, [transactions, thisMonth]);

  const paidSet = useMemo(() => {
    const s = new Set<string>();
    transactions.forEach(tx => {
      const raw = tx as unknown as Record<string, unknown>;
      if (!tx.studentUid || tx.status !== "completed") return;
      if (!tx.date.startsWith(thisMonth)) return;
      const type   = (raw.type   as string) ?? "";
      const method = (raw.method as string) ?? "";
      if (type === "fee_due" || type === "charge" || method === "auto" || method === "auto-monthly") return;
      s.add(tx.studentUid);
    });
    return s;
  }, [transactions, thisMonth]);

  const totalPendingFees = useMemo(() => {
    let amt = 0;
    feeDueMap.forEach((fee, uid) => { if (!paidSet.has(uid)) amt += fee; });
    return amt;
  }, [feeDueMap, paidSet]);

  const pendingFeeStudents = useMemo(() => {
    let n = 0;
    feeDueMap.forEach((_, uid) => { if (!paidSet.has(uid)) n++; });
    return n;
  }, [feeDueMap, paidSet]);

  // Centre rows
  const teacherNameMap = useMemo(() => Object.fromEntries(teachers.map(t => [t.uid, t.displayName])), [teachers]);

  const centreRows: CenterRow[] = useMemo(() => {
    const days60ago = isoDaysAgo(60);
    return centers.map(center => {
      const cStudents         = students.filter(s => s.centerId === center.id);
      const activeCount       = cStudents.filter(s => s.status === "active").length;
      const pendingFeeCount   = cStudents.filter(s => feeDueMap.has(s.uid) && !paidSet.has(s.uid)).length;
      const cGroupCount       = cStudents.filter(s => s.classType === "group").length;
      const cPersonalCount    = cStudents.filter(s => s.classType === "personal").length;
      const cAtt7d          = attendance.filter(a => a.centerId === center.id && a.date >= days7ago);
      const prs7d           = cAtt7d.filter(a => a.status === "present").length;
      const attPct          = cAtt7d.length > 0 ? Math.round((prs7d / cAtt7d.length) * 100) : null;
      const rev30           = completedTx.filter(t => t.centerId === center.id && t.date >= days30ago).reduce((s, t) => s + t.amount, 0);
      const withDate        = cStudents.filter(s => !!s.createdAt);
      let growthPct: number | null = null;
      if (withDate.length > 0) {
        const n = withDate.filter(s => s.createdAt >= days30ago).length;
        const p = withDate.filter(s => s.createdAt >= days60ago && s.createdAt < days30ago).length;
        growthPct = p > 0 ? Math.round(((n - p) / p) * 100) : n > 0 ? 100 : 0;
      }
      return {
        center, studentCount: cStudents.length, activeCount,
        groupCount: cGroupCount, personalCount: cPersonalCount,
        attendancePct: attPct, teacherName: teacherNameMap[center.teacherUid] ?? "—",
        pendingFeeCount, revenue30d: rev30, growthPct,
      };
    }).sort((a, b) => (b.attendancePct ?? -1) - (a.attendancePct ?? -1));
  }, [centers, students, attendance, completedTx, teacherNameMap, days7ago, days30ago, feeDueMap, paidSet]);

  // Teacher leaderboard
  const teacherPerf = useMemo(() => teachers.map(t => {
    const q = quality.find(q => q.teacherId === t.uid);
    return { uid: t.uid, name: t.displayName, score: q?.score ?? null, factors: q?.factors ?? null };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)), [teachers, quality]);

  // Monthly revenue trend (last 6 months)
  const revMonthlyTrend = useMemo(() => Array.from({ length: 6 }, (_, i) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - i));
    const ym  = d.toISOString().slice(0, 7);
    const amt = completedTx.filter(t => t.date?.startsWith(ym)).reduce((s, t) => s + t.amount, 0);
    const label = d.toLocaleDateString("en-IN", { month: "short" });
    return { ym, label, amt };
  }), [completedTx]);

  // Weekly attendance trend (last 7 days)
  const attWeeklyTrend = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const date  = isoDaysAgo(6 - i);
    const recs  = attendance.filter(a => a.date === date);
    const pct   = recs.length > 0 ? Math.round((recs.filter(a => a.status === "present").length / recs.length) * 100) : null;
    const label = new Date(date + "T12:00:00").toLocaleDateString("en-IN", { weekday: "short" });
    return { date, label, pct };
  }), [attendance]);

  // Top 5 centres by revenue + students
  const top5Rev      = [...centreRows].sort((a,b) => b.revenue30d - a.revenue30d).slice(0,5);
  const top5Students = [...centreRows].sort((a,b) => b.studentCount - a.studentCount).slice(0,5);

  // Attendance breakdown (present / absent / cancelled)
  const attBreakdown = useMemo(() => {
    return centreRows.slice(0,5).map(row => {
      const recs = attendance.filter(a => a.centerId === row.center.id);
      return {
        name:      row.center.name.length > 10 ? row.center.name.slice(0,10)+"…" : row.center.name,
        present:   recs.filter(a => a.status === "present").length,
        absent:    recs.filter(a => a.status === "absent").length,
        cancelled: recs.filter(a => a.status?.startsWith("cancelled")).length,
      };
    });
  }, [centreRows, attendance]);

  // Monthly attendance totals — every student remark counts
  const monthlyTotals = useMemo(() => {
    const monthRecs = attendance.filter(a => a.date?.startsWith(thisMonth));
    return {
      present:   monthRecs.filter(a => a.status === "present").length,
      absent:    monthRecs.filter(a => a.status === "absent").length,
      break:     monthRecs.filter(a => (a.status as string) === "break").length,
      cancelled: monthRecs.filter(a => (a.status as string)?.startsWith("cancelled")).length,
      total:     monthRecs.length,
    };
  }, [attendance, thisMonth]);

  // Fee pie
  const feePaid    = completedTx.reduce((s,t) => s + t.amount, 0);
  const feePending = totalPendingFees;

  // Revenue goal (hardcoded target = 1.2× last month or 50000 floor)
  const revGoal = Math.max(50000, Math.round(revLastMonth * 1.2));

  // Today's classes — any attendance record with any status = marked
  const markedCentreIds = useMemo(() => {
    const s = new Set<string>();
    todayAtt.forEach(a => { if (a.centerId) s.add(a.centerId); });
    return s;
  }, [todayAtt]);
  const todayCentres = useMemo(() => {
    const dow = DAY_ABBR[new Date(today + "T00:00:00").getDay()];
    return centers.filter(c => ((c as Center & { daysOfWeek?: string[] }).daysOfWeek ?? []).includes(dow));
  }, [centers, today]);

  // Alerts (priority issues)
  const alerts = useMemo(() => {
    const list: { icon: string; msg: string; level: "critical" | "warning" }[] = [];
    if (todayPct !== null && todayPct < 50)
      list.push({ icon: "📉", msg: `Attendance critically low today — ${todayPct}%`, level: "critical" });
    const lowAtt = centreRows.filter(c => c.attendancePct !== null && c.attendancePct < 60);
    if (lowAtt.length > 0)
      list.push({ icon: "🏫", msg: `Low attendance: ${lowAtt.map(c => c.center.name).join(", ")}`, level: "critical" });
    if (revGrowthPct !== null && revGrowthPct < -10)
      list.push({ icon: "💸", msg: `Revenue down ${Math.abs(revGrowthPct)}% vs last month`, level: "critical" });
    const pendingDeact = students.filter(s => s.status === "deactivation_requested").length;
    if (pendingDeact > 0)
      list.push({ icon: "🔔", msg: `${pendingDeact} deactivation request${pendingDeact > 1 ? "s" : ""} pending approval`, level: "warning" });
    const inactiveTeachers = teachers.filter(t => t.status !== "active").length;
    if (inactiveTeachers > 0)
      list.push({ icon: "👤", msg: `${inactiveTeachers} teacher${inactiveTeachers > 1 ? "s" : ""} marked inactive`, level: "warning" });
    if (totalPendingFees > 0)
      list.push({ icon: "💰", msg: `₹${totalPendingFees.toLocaleString("en-IN")} pending fees — ${pendingFeeStudents} students`, level: "warning" });
    return list;
  }, [todayPct, centreRows, revGrowthPct, students, teachers, totalPendingFees, pendingFeeStudents]);

  // ── Early returns AFTER all hooks ────────────────────────────────────────────
  if (loading) return (
    <div style={s.shell}>
      <div style={s.spinner} />
      <span style={s.loadingText}>Loading…</span>
    </div>
  );
  if (error) return <div style={s.errorShell}>⚠ {error}</div>;

  const attColor = todayPct === null ? "var(--color-text-muted)"
    : todayPct < 50  ? "var(--color-danger)"
    : todayPct < 75  ? "var(--color-warning)"
    : "var(--color-success)";

  const revColor = revGrowthPct === null ? "var(--color-text-muted)"
    : revGrowthPct < 0 ? "var(--color-danger)" : "var(--color-success)";

  return (
    <div style={s.page}>

      {/* ── 1. HEADER ── */}
      <div style={s.header}>
        <div>
          <div style={s.eyebrow}>CENTER SUITE</div>
          <div style={s.date}>{new Date().toLocaleDateString("en-IN", { weekday:"long", day:"numeric", month:"long", year:"numeric" })}</div>
        </div>
        <div style={s.actions}>
          <button style={s.btn}    onClick={() => router.push("/dashboard/centers")}>+ Centre</button>
          <button style={s.btn}    onClick={() => router.push("/dashboard/students")}>+ Student</button>
          <button style={s.btnPri} onClick={() => router.push("/dashboard/finance")}>Finance →</button>
        </div>
      </div>

      {/* ── 2. KPI ROW ── */}
      <div style={s.kpiStrip}>
        <KpiCard label="Total Students"   value={String(totalStudents)}   sub={`${activeStudents} active`} color="#8b3a4a" />
        <KpiCard label="Active Centres"   value={String(centers.filter(c=>c.status==="active").length)} sub={`of ${centers.length} total`} color="#0891b2" />
        <KpiCard label="Revenue · Month"  value={`₹${(revThisMonth/1000).toFixed(1)}k`}
          sub={revGrowthPct!==null ? `${revGrowthPct>=0?"▲":"▼"} ${Math.abs(revGrowthPct)}% vs last` : "no prior data"}
          color={revGrowthPct===null?"#6b7280":revGrowthPct>=0?"#16a34a":"#dc2626"} />
        <KpiCard label="Pending Fees"     value={totalPendingFees===0?"All Clear":`₹${(totalPendingFees/1000).toFixed(1)}k`}
          sub={totalPendingFees===0?"Collected":`${pendingFeeStudents} students`}
          color={totalPendingFees===0?"#16a34a":"#b87333"} />
      </div>

      {/* ── TODAY'S CLASSES ── */}
      {todayCentres.length > 0 && (
        <div style={{ ...s.section, marginBottom: 16 }}>
          <div style={{ ...s.sectionHeader, marginBottom: 14 }}>
            <span style={s.sectionTitle}>Today's Classes</span>
            <span style={s.sectionSub}>{new Date().toLocaleDateString("en-IN", { weekday: "long" })}</span>
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
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px", marginBottom: 16 }}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>Attendance This Month</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{monthLabel(thisMonth)} · all student records</div>
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

      {/* ── 3. TRENDS ROW ── */}
      <div style={s.twoCol}>
        <ChartCard title="Revenue Trend" sub="6 months">
          <LineChart data={revMonthlyTrend.map(d=>({ label:d.label, value:d.amt }))} color="#8b3a4a" formatValue={v=>`₹${(v/1000).toFixed(1)}k`} />
        </ChartCard>
        <ChartCard title="Attendance Trend" sub="7 days">
          <LineChart data={attWeeklyTrend.map(d=>({ label:d.label, value:d.pct??0 }))} color="#16a34a" formatValue={v=>`${v}%`} />
        </ChartCard>
      </div>

      {/* ── 4. TOP CENTRES ── */}
      <div style={s.twoCol}>
        <ChartCard title="Top 5 Centres by Revenue" sub="30 days">
          <BarChart data={top5Rev.map(r=>({ label:r.center.name, value:r.revenue30d }))} color="#8b3a4a" formatValue={v=>`₹${(v/1000).toFixed(1)}k`} />
        </ChartCard>
        <ChartCard title="Top 5 Centres by Students" sub="active">
          <BarChart data={top5Students.map(r=>({ label:r.center.name, value:r.studentCount }))} color="#0891b2" formatValue={v=>String(v)} />
        </ChartCard>
      </div>

      {/* ── 5. ATTENDANCE BREAKDOWN ── */}
      <ChartCard title="Attendance Breakdown" sub="present / absent / cancelled — top 5 centres">
        <StackedBarChart data={attBreakdown} />
      </ChartCard>

      {/* ── 6. FINANCE ROW ── */}
      <div style={s.twoCol}>
        <ChartCard title="Fee Status" sub="collected vs pending">
          <PieChart paid={feePaid} pending={feePending} />
        </ChartCard>
        <ChartCard title="Revenue vs Goal" sub={`Target ₹${(revGoal/1000).toFixed(1)}k this month`}>
          <GaugeChart value={revThisMonth} goal={revGoal} />
        </ChartCard>
      </div>

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART PRIMITIVES  (pure SVG, no library)
// ═══════════════════════════════════════════════════════════════════════════════

function ChartCard({ title, sub, children }: { title:string; sub?:string; children:React.ReactNode }) {
  return (
    <div style={{ background:"#fff", border:"1px solid #e5e7eb", borderRadius:12, padding:"18px 20px", marginBottom:0 }}>
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:13, fontWeight:700, color:"#111" }}>{title}</div>
        {sub && <div style={{ fontSize:11, color:"#9ca3af", marginTop:2 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function KpiCard({ label, value, sub, color }: { label:string; value:string; sub:string; color:string }) {
  return (
    <div style={{ background:"#fff", border:"1px solid #e5e7eb", borderRadius:12, padding:"16px 18px",
                  borderTop:`3px solid ${color}`, flex:1, minWidth:140 }}>
      <div style={{ fontSize:11, fontWeight:600, color:"#9ca3af", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:24, fontWeight:800, color, lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:11, color:"#6b7280", marginTop:4 }}>{sub}</div>
    </div>
  );
}

// ── Line Chart ────────────────────────────────────────────────────────────────
function LineChart({ data, color, formatValue }: {
  data: { label:string; value:number }[];
  color: string;
  formatValue: (v:number) => string;
}) {
  const W=440, H=110, PL=10, PR=10, PT=20, PB=28;
  const vals   = data.map(d=>d.value);
  const maxV   = Math.max(...vals, 1);
  const minV   = Math.min(...vals, 0);
  const range  = maxV - minV || 1;
  const xStep  = (W-PL-PR) / Math.max(data.length-1, 1);
  const y      = (v:number) => PT + ((maxV - v) / range) * (H - PT - PB);
  const x      = (i:number) => PL + i * xStep;
  const pts    = data.map((_,i)=>`${x(i)},${y(vals[i])}`).join(" ");
  const fill   = data.map((_,i)=>`${x(i)},${y(vals[i])}`).join(" ") + ` ${x(data.length-1)},${H-PB} ${PL},${H-PB}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:H, display:"block" }}>
      {/* gradient area */}
      <defs>
        <linearGradient id={`lg-${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0.01} />
        </linearGradient>
      </defs>
      <polygon points={fill} fill={`url(#lg-${color.replace("#","")})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {/* dots + labels */}
      {data.map((d,i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(vals[i])} r={3} fill={color} />
          <text x={x(i)} y={H-PB+13} textAnchor="middle" fontSize={9} fill="#9ca3af">{d.label}</text>
          {(i===0||i===data.length-1) && (
            <text x={x(i)} y={y(vals[i])-7} textAnchor="middle" fontSize={9} fill={color} fontWeight="600">{formatValue(vals[i])}</text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ── Bar Chart ─────────────────────────────────────────────────────────────────
function BarChart({ data, color, formatValue }: {
  data: { label:string; value:number }[];
  color: string;
  formatValue: (v:number) => string;
}) {
  const W=440, H=120, PL=4, PR=4, PT=20, PB=28;
  const maxV   = Math.max(...data.map(d=>d.value), 1);
  const bW     = (W-PL-PR)/data.length;
  const gap    = bW*0.22;
  const bW2    = bW - gap;
  const bH     = (v:number) => Math.max(4, ((v/maxV)*(H-PT-PB)));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:H, display:"block" }}>
      <line x1={PL} y1={H-PB} x2={W-PR} y2={H-PB} stroke="#e5e7eb" strokeWidth={1} />
      {data.map((d,i) => {
        const barH = bH(d.value);
        const bx   = PL + i*bW + gap/2;
        const by   = H - PB - barH;
        const short = d.label.length>8 ? d.label.slice(0,8)+"…" : d.label;
        return (
          <g key={i}>
            <rect x={bx} y={by} width={bW2} height={barH} rx={3} fill={color} opacity={0.85} />
            <text x={bx+bW2/2} y={by-5} textAnchor="middle" fontSize={9} fill={color} fontWeight="600">{formatValue(d.value)}</text>
            <text x={bx+bW2/2} y={H-PB+13} textAnchor="middle" fontSize={9} fill="#9ca3af">{short}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Stacked Bar Chart ─────────────────────────────────────────────────────────
function StackedBarChart({ data }: {
  data: { name:string; present:number; absent:number; cancelled:number }[];
}) {
  const W=880, H=130, PL=4, PR=4, PT=20, PB=28;
  const totals = data.map(d=>d.present+d.absent+d.cancelled);
  const maxT   = Math.max(...totals, 1);
  const bW     = (W-PL-PR)/data.length;
  const gap    = bW*0.22;
  const bW2    = bW-gap;
  const maxBarH = H-PT-PB;
  const SEG = [
    { key:"present"  as const, color:"#16a34a" },
    { key:"absent"   as const, color:"#dc2626" },
    { key:"cancelled"as const, color:"#9ca3af" },
  ];

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:H, display:"block" }}>
        {data.map((d,i)=>{
          const bx    = PL + i*bW + gap/2;
          const total = totals[i];
          let yOff = H-PB;
          return (
            <g key={i}>
              {SEG.map(seg=>{
                const segH = total>0 ? Math.max(total>0?1:0, Math.round((d[seg.key]/maxT)*maxBarH)) : 0;
                yOff -= segH;
                return <rect key={seg.key} x={bx} y={yOff} width={bW2} height={segH} fill={seg.color} opacity={0.88} />;
              })}
              <text x={bx+bW2/2} y={H-PB+13} textAnchor="middle" fontSize={9} fill="#9ca3af">{d.name}</text>
              {total>0 && <text x={bx+bW2/2} y={H-PB - Math.round((total/maxT)*maxBarH) - 4} textAnchor="middle" fontSize={9} fill="#374151" fontWeight="600">{total}</text>}
            </g>
          );
        })}
        <line x1={PL} y1={H-PB} x2={W-PR} y2={H-PB} stroke="#e5e7eb" />
      </svg>
      <div style={{ display:"flex", gap:14, marginTop:6, flexWrap:"wrap" }}>
        {[["#16a34a","Present"],["#dc2626","Absent"],["#9ca3af","Cancelled"]].map(([c,l])=>(
          <div key={l} style={{ display:"flex", alignItems:"center", gap:5, fontSize:11, color:"#6b7280" }}>
            <div style={{ width:10, height:10, borderRadius:2, background:c }} />
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Pie Chart ─────────────────────────────────────────────────────────────────
function PieChart({ paid, pending }: { paid:number; pending:number }) {
  const total = paid + pending || 1;
  const paidPct = paid / total;
  const R=60, CX=80, CY=80;
  const arc = (pct:number, r:number) => {
    const angle = pct * 2 * Math.PI - 0.001;
    const x = CX + r * Math.sin(angle);
    const y = CY - r * Math.cos(angle);
    return `M ${CX} ${CY-r} A ${r} ${r} 0 ${angle>Math.PI?1:0} 1 ${x} ${y} Z`;
  };

  return (
    <div style={{ display:"flex", alignItems:"center", gap:24 }}>
      <svg viewBox="0 0 160 160" style={{ width:130, height:130, flexShrink:0 }}>
        <circle cx={CX} cy={CY} r={R} fill="#fee2e2" />
        <path d={arc(paidPct, R)} fill="#16a34a" opacity={0.9} />
        <circle cx={CX} cy={CY} r={R*0.55} fill="#fff" />
        <text x={CX} y={CY+3} textAnchor="middle" fontSize={11} fontWeight="700" fill="#111">
          {Math.round(paidPct*100)}%
        </text>
        <text x={CX} y={CY+15} textAnchor="middle" fontSize={9} fill="#6b7280">Paid</text>
      </svg>
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:12 }}>
            <div style={{ width:10,height:10,borderRadius:2,background:"#16a34a" }} />
            <span style={{ color:"#374151", fontWeight:600 }}>Collected</span>
          </div>
          <div style={{ fontSize:15, fontWeight:800, color:"#16a34a", marginTop:2 }}>₹{paid.toLocaleString("en-IN")}</div>
        </div>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:12 }}>
            <div style={{ width:10,height:10,borderRadius:2,background:"#dc2626" }} />
            <span style={{ color:"#374151", fontWeight:600 }}>Pending</span>
          </div>
          <div style={{ fontSize:15, fontWeight:800, color:"#dc2626", marginTop:2 }}>₹{pending.toLocaleString("en-IN")}</div>
        </div>
      </div>
    </div>
  );
}

// ── Gauge Chart ───────────────────────────────────────────────────────────────
function GaugeChart({ value, goal }: { value:number; goal:number }) {
  const pct   = Math.min(value / goal, 1);
  const R=64, CX=100, CY=90;
  const startAngle = -Math.PI * 0.85;
  const endAngle   =  Math.PI * 0.85;
  const toXY = (angle:number) => ({
    x: CX + R * Math.cos(angle),
    y: CY + R * Math.sin(angle),
  });
  const trackStart = toXY(startAngle);
  const trackEnd   = toXY(endAngle);
  const fillEnd    = toXY(startAngle + (endAngle - startAngle) * pct);
  const arcFlag    = (endAngle - startAngle) * pct > Math.PI ? 1 : 0;
  const fillFlag   = (endAngle - startAngle) > Math.PI ? 1 : 0;
  const color      = pct >= 1 ? "#16a34a" : pct >= 0.6 ? "#b87333" : "#dc2626";

  return (
    <svg viewBox="0 0 200 115" style={{ width:"100%", height:115, display:"block" }}>
      {/* track */}
      <path d={`M ${trackStart.x} ${trackStart.y} A ${R} ${R} 0 ${fillFlag} 1 ${trackEnd.x} ${trackEnd.y}`}
        fill="none" stroke="#e5e7eb" strokeWidth={14} strokeLinecap="round" />
      {/* fill */}
      {pct > 0 && (
        <path d={`M ${trackStart.x} ${trackStart.y} A ${R} ${R} 0 ${arcFlag} 1 ${fillEnd.x} ${fillEnd.y}`}
          fill="none" stroke={color} strokeWidth={14} strokeLinecap="round" />
      )}
      {/* labels */}
      <text x={CX} y={CY-8}  textAnchor="middle" fontSize={20} fontWeight="800" fill={color}>
        {Math.round(pct*100)}%
      </text>
      <text x={CX} y={CY+10} textAnchor="middle" fontSize={10} fill="#6b7280">of target</text>
      <text x={CX} y={CY+24} textAnchor="middle" fontSize={11} fontWeight="700" fill="#374151">
        ₹{(value/1000).toFixed(1)}k / ₹{(goal/1000).toFixed(1)}k
      </text>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEACHER ROW SUB-COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function TeacherRow({ rank, name, score, factors, top }: {
  rank: number; name: string; score: number | null;
  factors: { attendanceDiscipline: number; syllabusProgress: number; studentRetention: number } | null;
  top: boolean;
}) {
  const sc = score === null ? "var(--color-text-muted)"
    : score >= 75 ? "var(--color-success)"
    : score >= 50 ? "var(--color-warning)"
    : "var(--color-danger)";

  return (
    <div style={s.teacherRow}>
      <span style={{ fontSize: 12, fontWeight: 800, color: top ? "var(--color-success)" : "var(--color-danger)", minWidth: 24 }}>#{rank}</span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{name}</span>
      {score !== null
        ? <div style={{ display: "flex", alignItems: "baseline", gap: 1 }}>
            <span style={{ fontSize: 17, fontWeight: 800, color: sc }}>{score}</span>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>/100</span>
          </div>
        : <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>—</span>
      }
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helper: month label ────────────────────────────────────────────────────────
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND CENTER STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const s: Record<string, React.CSSProperties> = {
  page:    { maxWidth: 1000, margin: "0 auto", paddingBottom: 48 },

  // Loading
  shell:       { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "40vh", gap: 12 },
  spinner:     { width: 26, height: 26, border: "3px solid var(--color-border)", borderTopColor: "var(--color-accent)", borderRadius: "50%", animation: "spin 0.7s linear infinite" },
  loadingText: { fontSize: 13, color: "var(--color-text-muted)" },
  errorShell:  { padding: "48px 24px", textAlign: "center", color: "var(--color-danger)", fontSize: 14 },

  // Header
  header:  { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 },
  eyebrow: { fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: "var(--color-accent)", textTransform: "uppercase", marginBottom: 4 },
  date:    { fontSize: 18, fontWeight: 700, color: "var(--color-text-primary)" },
  actions: { display: "flex", gap: 8 },
  btn:     { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--color-text-secondary)" },
  btnPri:  { background: "var(--color-accent)", color: "#1a140d", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" },

  // KPI strip
  kpiStrip:   { display: "flex", alignItems: "stretch", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 14, padding: "20px 28px", marginBottom: 20, gap: 0, boxShadow: "var(--shadow-sm)", flexWrap: "wrap" },
  kpi:        { flex: 1, minWidth: 120, padding: "0 16px" },
  kpiDivider: { width: 1, background: "var(--color-border)", margin: "0 4px" },
  kpiLabel:   { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--color-text-muted)", marginBottom: 6 },
  kpiValue:   { fontSize: 26, fontWeight: 800, lineHeight: 1, color: "var(--color-text-primary)", marginBottom: 4 },
  kpiSub:     { fontSize: 11.5, color: "var(--color-text-muted)", fontWeight: 500 },

  // Alerts
  alertsBox:    { background: "var(--color-surface)", border: "1px solid var(--color-danger-border)", borderLeft: "4px solid var(--color-danger)", borderRadius: 12, marginBottom: 20, overflow: "hidden", boxShadow: "var(--shadow-sm)" },
  alertsHeader: { display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: "1px solid var(--color-border)" },
  alertsTitle:  { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--color-danger)" },
  alertsCount:  { fontSize: 11, fontWeight: 700, background: "var(--color-danger-dim)", color: "var(--color-danger)", border: "1px solid var(--color-danger-border)", borderRadius: 99, padding: "1px 8px" },
  alertsList:   { display: "flex", flexDirection: "column" },
  alertRow:     { display: "flex", alignItems: "center", gap: 10, padding: "11px 18px", borderBottom: "1px solid var(--color-border-subtle)" },
  alertDot:     { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
  alertIcon:    { fontSize: 14, flexShrink: 0 },
  alertMsg:     { flex: 1, fontSize: 13, color: "var(--color-text-primary)", lineHeight: 1.4 },
  allClear:     { fontSize: 13, color: "var(--color-success)", fontWeight: 500, padding: "14px 18px", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderLeft: "4px solid var(--color-success)", borderRadius: 12, marginBottom: 20 },

  // Section
  section:       { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "18px 20px", marginBottom: 16, boxShadow: "var(--shadow-sm)" },
  sectionHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 },
  sectionTitle:  { fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-secondary)" },
  sectionSub:    { fontSize: 11, color: "var(--color-text-muted)" },

  // Two col
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 },

  // Table
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:    { textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-2)", whiteSpace: "nowrap" as const },
  tr:    { borderBottom: "1px solid var(--color-border-subtle)" },
  td:    { padding: "12px 12px", color: "var(--color-text-secondary)", verticalAlign: "middle" },
  rank:       { fontSize: 11, color: "var(--color-text-muted)", marginRight: 6, minWidth: 24 },
  viewAllBtn: { background: "none", border: "none", color: "var(--color-accent,#8b3a4a)", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 },
  centreRow:  { display: "flex", alignItems: "center", padding: "11px 16px", borderBottom: "1px solid var(--color-border,#f3f4f6)", cursor: "pointer", gap: 8 },

  // Teacher rows
  teacherRow: { display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px solid var(--color-border-subtle)" },
  empty:      { padding: "20px", textAlign: "center", fontSize: 13, color: "var(--color-text-muted)" },

  // Bar chart
  barChart: { display: "flex", alignItems: "flex-end", gap: 10, height: 80, paddingTop: 4 },
  barCol:   { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  bar:      { width: "100%", borderRadius: 4, minHeight: 4 },
};

