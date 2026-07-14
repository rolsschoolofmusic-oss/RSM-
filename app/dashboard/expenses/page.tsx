"use client";

import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/hooks/useAuth";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import {
  getExpenses, createExpense, updateExpense, deleteExpense,
} from "@/services/finance/expense.service";
import type { Expense, ExpenseCategory, PaymentMethod } from "@/types/finance";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";

// ─── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: { key: ExpenseCategory; label: string }[] = [
  { key: "rent",        label: "Rent" },
  { key: "salaries",    label: "Salaries" },
  { key: "utilities",   label: "Utilities" },
  { key: "equipment",   label: "Equipment" },
  { key: "maintenance", label: "Maintenance" },
  { key: "marketing",   label: "Marketing" },
  { key: "supplies",    label: "Supplies" },
  { key: "other",       label: "Other" },
];

const CATEGORY_LABEL: Record<ExpenseCategory, string> =
  Object.fromEntries(CATEGORIES.map(c => [c.key, c.label])) as Record<ExpenseCategory, string>;

const PAY_METHODS: PaymentMethod[] = ["Cash", "UPI", "Bank"];

const EMPTY_FORM = {
  date:     new Date().toISOString().slice(0, 10),
  category: "other" as ExpenseCategory,
  amount:   "",
  paidVia:  "Cash" as PaymentMethod,
  note:     "",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtINR(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  const names = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  return `${names[parseInt(m, 10) - 1] ?? m} ${y}`;
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <ExpensesContent />
    </ProtectedRoute>
  );
}

function ExpensesContent() {
  const { user }                      = useAuth();
  const { toasts, toast, remove }     = useToast();

  const [expenses, setExpenses]       = useState<Expense[]>([]);
  const [loading, setLoading]         = useState(true);
  const [month, setMonth]             = useState(currentMonth());
  const [categoryFilter, setCategoryFilter] = useState<ExpenseCategory | "all">("all");

  const [showForm, setShowForm]       = useState(false);
  const [form, setForm]               = useState({ ...EMPTY_FORM });
  const [saving, setSaving]           = useState(false);
  const [editId, setEditId]           = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await getExpenses();
      setExpenses(data.sort((a, b) => b.date.localeCompare(a.date)));
    } catch (err) {
      console.error(err);
      toast("Failed to load expenses", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const monthExpenses = useMemo(() => (
    expenses
      .filter(e => e.date.startsWith(month))
      .filter(e => categoryFilter === "all" || e.category === categoryFilter)
  ), [expenses, month, categoryFilter]);

  const total = useMemo(() => monthExpenses.reduce((sum, e) => sum + e.amount, 0), [monthExpenses]);

  const byCategory = useMemo(() => {
    const m = new Map<ExpenseCategory, number>();
    monthExpenses.forEach(e => m.set(e.category, (m.get(e.category) ?? 0) + e.amount));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [monthExpenses]);

  function openCreate() {
    setEditId(null);
    setForm({ ...EMPTY_FORM });
    setShowForm(true);
  }

  function openEdit(exp: Expense) {
    setEditId(exp.id);
    setForm({
      date: exp.date, category: exp.category,
      amount: String(exp.amount), paidVia: exp.paidVia as PaymentMethod,
      note: exp.note ?? "",
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number(form.amount);
    if (!amount || amount <= 0) { toast("Enter a valid amount", "error"); return; }
    if (!user) return;

    setSaving(true);
    try {
      if (editId) {
        await updateExpense(editId, {
          date: form.date, category: form.category, amount,
          paidVia: form.paidVia, note: form.note.trim() || null,
        });
        toast("Expense updated", "success");
      } else {
        await createExpense(
          { date: form.date, category: form.category, amount, paidVia: form.paidVia,
            note: form.note.trim() || null, loggedBy: user.uid },
          user.uid, user.role,
        );
        toast("Expense logged", "success");
      }
      setShowForm(false);
      await load();
    } catch (err) {
      console.error(err);
      toast("Failed to save expense", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget || !user) return;
    try {
      await deleteExpense(deleteTarget.id, user.uid, user.role);
      toast("Expense deleted", "success");
      setDeleteTarget(null);
      await load();
    } catch (err) {
      console.error(err);
      toast("Failed to delete expense", "error");
    }
  }

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={st.header}>
        <div>
          <div style={st.heading}>Expenses</div>
          <div style={st.subheading}>Track school running costs — rent, salaries, supplies, and more.</div>
        </div>
        <button onClick={openCreate} style={st.addBtn}>+ Log Expense</button>
      </div>

      {/* Summary */}
      <div style={st.cardGrid}>
        <div style={st.card}>
          <div style={st.cardAccent} />
          <div style={st.cardBody}>
            <div style={st.cardLabel}>{fmtMonth(month)}</div>
            <div style={st.cardValue}>{loading ? "…" : fmtINR(total)}</div>
            <div style={st.cardHint}>{loading ? "" : `${monthExpenses.length} expense${monthExpenses.length === 1 ? "" : "s"}`}</div>
          </div>
        </div>
        {byCategory.slice(0, 3).map(([cat, amt]) => (
          <div key={cat} style={st.card}>
            <div style={st.cardAccent} />
            <div style={st.cardBody}>
              <div style={st.cardLabel}>{CATEGORY_LABEL[cat]}</div>
              <div style={st.cardValue}>{fmtINR(amt)}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={st.filterRow}>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)} style={st.filterInput} />
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value as ExpenseCategory | "all")} style={st.filterInput}>
          <option value="all">All categories</option>
          {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <form onSubmit={handleSubmit} style={st.panel}>
          <div style={st.panelTitle}>{editId ? "Edit expense" : "Log new expense"}</div>
          <div style={st.panelRow}>
            <div style={st.field}>
              <label style={st.label}>Date</label>
              <input type="date" value={form.date} required
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={st.input} />
            </div>
            <div style={st.field}>
              <label style={st.label}>Category</label>
              <select value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value as ExpenseCategory }))} style={st.input}>
                {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div style={st.field}>
              <label style={st.label}>Amount (₹)</label>
              <input type="number" min="1" step="1" value={form.amount} required
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={st.input} />
            </div>
            <div style={st.field}>
              <label style={st.label}>Paid via</label>
              <select value={form.paidVia}
                onChange={e => setForm(f => ({ ...f, paidVia: e.target.value as PaymentMethod }))} style={st.input}>
                {PAY_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div style={{ ...st.field, flex: 2, minWidth: 200 }}>
              <label style={st.label}>Note (optional)</label>
              <input type="text" value={form.note} placeholder="e.g. October rent — main center"
                onChange={e => setForm(f => ({ ...f, note: e.target.value }))} style={st.input} />
            </div>
          </div>
          <div style={st.panelActions}>
            <button type="submit" disabled={saving} style={st.confirmBtn}>
              {saving ? "Saving…" : editId ? "Save changes" : "Log expense"}
            </button>
            <button type="button" onClick={() => setShowForm(false)} style={st.cancelBtn}>Cancel</button>
          </div>
        </form>
      )}

      {/* Table */}
      <div style={st.tableWrapper}>
        <table style={st.table}>
          <thead>
            <tr>
              <th style={st.th}>Date</th>
              <th style={st.th}>Category</th>
              <th style={st.th}>Paid via</th>
              <th style={st.th}>Note</th>
              <th style={{ ...st.th, textAlign: "right" }}>Amount</th>
              <th style={st.th}></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} style={st.stateRow}>Loading…</td></tr>
            )}
            {!loading && monthExpenses.length === 0 && (
              <tr><td colSpan={6} style={st.stateRow}>No expenses logged for {fmtMonth(month)}.</td></tr>
            )}
            {!loading && monthExpenses.map((e, i) => (
              <tr key={e.id} style={i % 2 === 0 ? st.rowEven : st.rowOdd}>
                <td style={st.td}>{e.date}</td>
                <td style={st.td}>
                  <span style={st.badge}>{CATEGORY_LABEL[e.category]}</span>
                </td>
                <td style={st.td}>{e.paidVia}</td>
                <td style={st.td}>{e.note || "—"}</td>
                <td style={{ ...st.td, textAlign: "right", fontWeight: 700 }}>{fmtINR(e.amount)}</td>
                <td style={{ ...st.td, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button onClick={() => openEdit(e)} style={st.actionBtn}>Edit</button>{" "}
                  <button onClick={() => setDeleteTarget(e)} style={st.actionBtnDanger}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Delete confirm */}
      {deleteTarget && (
        <div style={st.modalOverlay} onClick={() => setDeleteTarget(null)}>
          <div style={st.modalBox} onClick={e => e.stopPropagation()}>
            <div style={st.modalTitle}>Delete this expense?</div>
            <div style={st.modalBody}>
              {fmtINR(deleteTarget.amount)} · {CATEGORY_LABEL[deleteTarget.category]} · {deleteTarget.date}
            </div>
            <div style={st.panelActions}>
              <button onClick={handleDelete} style={st.deleteBtn}>Delete</button>
              <button onClick={() => setDeleteTarget(null)} style={st.cancelBtn}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const st: Record<string, React.CSSProperties> = {
  header:      { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 16, flexWrap: "wrap" as const },
  heading:     { fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 4 },
  subheading:  { fontSize: 13, color: "var(--color-text-secondary)" },
  addBtn:      { background: "var(--color-accent)", color: "#1a140d", border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" },

  cardGrid:   { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 20 },
  card:       { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" },
  cardAccent: { height: 4, width: "100%", background: "var(--color-accent)" },
  cardBody:   { padding: "14px 18px" },
  cardLabel:  { fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.04em" },
  cardValue:  { fontSize: 24, fontWeight: 700, color: "var(--color-accent-text)" },
  cardHint:   { fontSize: 10, color: "var(--color-text-muted)", marginTop: 4 },

  filterRow:   { display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" as const },
  filterInput: { padding: "7px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)", cursor: "pointer", minWidth: 150 },

  panel:       { background: "var(--color-surface)", border: "1px solid var(--color-accent-border)", borderRadius: 10, padding: "16px 18px", marginBottom: 16 },
  panelTitle:  { fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 14 },
  panelRow:    { display: "flex", gap: 14, flexWrap: "wrap" as const, marginBottom: 14 },
  panelActions:{ display: "flex", gap: 10, alignItems: "center" },
  field:       { display: "flex", flexDirection: "column" as const, gap: 5, flex: 1, minWidth: 120 },
  label:       { fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.04em" },
  input:       { padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface-2)", color: "var(--color-text-primary)" },

  confirmBtn:  { background: "var(--color-accent)", color: "#1a140d", border: "none", borderRadius: 6, padding: "9px 22px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  cancelBtn:   { background: "var(--color-surface-2)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: 6, padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  deleteBtn:   { background: "var(--color-danger)", color: "#fff", border: "none", borderRadius: 6, padding: "9px 22px", fontSize: 13, fontWeight: 700, cursor: "pointer" },

  tableWrapper: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "auto" },
  stateRow:     { padding: "24px 16px", textAlign: "center" as const, fontSize: 13, color: "var(--color-text-secondary)" },
  table:        { width: "100%", minWidth: 720, borderCollapse: "collapse" as const },
  th:           { padding: "11px 14px", textAlign: "left" as const, fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.04em", borderBottom: "1px solid var(--color-border)" },
  td:           { padding: "11px 14px", fontSize: 13, color: "var(--color-text-primary)", borderBottom: "1px solid var(--color-border)" },
  rowEven:      { background: "var(--color-surface)" },
  rowOdd:       { background: "var(--color-surface-2)" },
  badge:        { display: "inline-block", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600, background: "var(--color-accent-dim)", color: "var(--color-accent-text)" },

  actionBtn:      { padding: "4px 9px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 11.5, fontWeight: 600, cursor: "pointer", background: "var(--color-surface)", color: "var(--color-text-primary)" },
  actionBtnDanger:{ padding: "4px 9px", border: "1px solid var(--color-danger-border)", borderRadius: 6, fontSize: 11.5, fontWeight: 600, cursor: "pointer", background: "var(--color-danger-dim)", color: "var(--color-danger)" },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 500, padding: 16 },
  modalBox:     { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 20, maxWidth: 360, width: "100%" },
  modalTitle:   { fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 8 },
  modalBody:    { fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16 },
};
