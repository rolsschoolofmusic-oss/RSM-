"use client";

import { useEffect, useState } from "react";
import { useAuthContext } from "@/features/auth/AuthContext";
import {
  getApplicationForm, saveApplicationForm, defaultApplicationQuestions,
  genFieldId, genFieldKey, formatAnswerForDisplay,
  type ApplicationQuestion, type ApplicationFieldType,
} from "@/services/screening/applicationForm.service";

// ─── Shared pill-choice primitives ─────────────────────────────────────────────
export function OptionGroup({ options, value, onChange }: {
  options: string[];
  value:   string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
      {options.map(opt => {
        const sel = value === opt;
        return (
          <button key={opt} type="button" onClick={() => onChange(sel ? "" : opt)} style={{
            padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13,
            border:     sel ? "2px solid #8b3a4a" : "1px solid #e5e7eb",
            background: sel ? "#f0dde1" : "#f9fafb",
            color:      sel ? "#8b3a4a" : "#374151",
            fontWeight: sel ? 700 : 400,
          }}>
            {opt}
          </button>
        );
      })}
    </div>
  );
}

export function MultiOptionGroup({ options, values, onChange }: {
  options:  string[];
  values:   string[];
  onChange: (vals: string[]) => void;
}) {
  function toggle(opt: string) {
    onChange(values.includes(opt) ? values.filter(v => v !== opt) : [...values, opt]);
  }
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
      {options.map(opt => {
        const sel = values.includes(opt);
        return (
          <button key={opt} type="button" onClick={() => toggle(opt)} style={{
            padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13,
            border:     sel ? "2px solid #8b3a4a" : "1px solid #e5e7eb",
            background: sel ? "#f0dde1" : "#f9fafb",
            color:      sel ? "#8b3a4a" : "#374151",
            fontWeight: sel ? 700 : 400,
          }}>
            {sel ? "✓ " : ""}{opt}
          </button>
        );
      })}
    </div>
  );
}

export function ScaleGroup({ min = 1, max = 10, value, onChange }: {
  min?: number; max?: number;
  value: number | null;
  onChange: (n: number | null) => void;
}) {
  const nums = Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i);
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
        {nums.map(n => (
          <button key={n} type="button" onClick={() => onChange(value === n ? null : n)} style={{
            width: 42, height: 42, borderRadius: 8, cursor: "pointer", fontSize: 14,
            border: "none",
            background: value === n ? "#8b3a4a" : "#f3f4f6",
            color:      value === n ? "#fff" : "#374151",
            fontWeight: value === n ? 800 : 500,
          }}>
            {n}
          </button>
        ))}
      </div>
      {value !== null && (
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>Selected: {value} / {max}</div>
      )}
    </div>
  );
}

// ─── Style tokens (mirrors the `s` map in page.tsx) ────────────────────────────
const qLabelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 };
const qInputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1.5px solid #f0f0f0", borderRadius: 10,
  padding: "10px 13px", fontSize: 13, outline: "none", fontFamily: "inherit", color: "#111", background: "#fafafa",
};

// ─── Dynamic answer input (create / edit forms) ────────────────────────────────
export function ApplicationQuestionInput({ question, value, onChange }: {
  question: ApplicationQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const hint =
    question.type === "multi-select" ? " (select all that apply)" :
    question.type === "scale"        ? ` ( / ${question.scaleMax ?? 10})` : "";
  return (
    <div style={{ marginBottom: 20 }}>
      <label style={qLabelStyle}>
        {question.label}
        {question.required && <span style={{ color: "#dc2626" }}> *</span>}
        {hint && <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 12 }}>{hint}</span>}
      </label>
      {question.type === "text" && (
        <input value={typeof value === "string" ? value : ""} onChange={e => onChange(e.target.value)} style={qInputStyle} />
      )}
      {question.type === "textarea" && (
        <textarea rows={3} value={typeof value === "string" ? value : ""} onChange={e => onChange(e.target.value)}
          style={{ ...qInputStyle, resize: "vertical" as const }} />
      )}
      {question.type === "single-select" && (
        <OptionGroup options={question.options ?? []} value={typeof value === "string" ? value : ""} onChange={onChange} />
      )}
      {question.type === "multi-select" && (
        <MultiOptionGroup options={question.options ?? []} values={Array.isArray(value) ? value.map(String) : []} onChange={onChange} />
      )}
      {question.type === "scale" && (
        <ScaleGroup min={question.scaleMin ?? 1} max={question.scaleMax ?? 10}
          value={typeof value === "number" ? value : null} onChange={onChange} />
      )}
    </div>
  );
}

// ─── Read-only answer display (detail panel) ───────────────────────────────────
export function ApplicationQuestionDisplay({ question, value }: {
  question: ApplicationQuestion;
  value: unknown;
}) {
  if (question.type === "multi-select") {
    const vals = Array.isArray(value) ? value.map(String) : [];
    if (vals.length === 0) return null;
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", minWidth: 160, flexShrink: 0 }}>
          {question.label}
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
          {vals.map(v => (
            <span key={v} style={{ background: "#f0dde1", color: "#8b3a4a", fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99 }}>{v}</span>
          ))}
        </div>
      </div>
    );
  }
  const display = formatAnswerForDisplay(question, value);
  if (display === "—") return null;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", minWidth: 160, flexShrink: 0 }}>
        {question.label}
      </div>
      <div style={question.type === "scale"
        ? { fontSize: 15, fontWeight: 800, color: "#8b3a4a" }
        : { fontSize: 13, color: "#374151" }}>
        {display}
      </div>
    </div>
  );
}

// ─── Admin editor modal ─────────────────────────────────────────────────────────
const FIELD_TYPES: { value: ApplicationFieldType; label: string }[] = [
  { value: "single-select", label: "Single choice" },
  { value: "multi-select",  label: "Multiple choice" },
  { value: "text",          label: "Short text" },
  { value: "textarea",      label: "Paragraph" },
  { value: "scale",         label: "1–10 scale" },
];

export function ApplicationFormEditor({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: (questions: ApplicationQuestion[]) => void;
}) {
  const { user } = useAuthContext();
  const [draft,   setDraft]   = useState<ApplicationQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState("");

  useEffect(() => {
    getApplicationForm()
      .then(qs => setDraft(qs && qs.length > 0 ? qs : defaultApplicationQuestions()))
      .catch(() => setDraft(defaultApplicationQuestions()))
      .finally(() => setLoading(false));
  }, []);

  function update(id: string, patch: Partial<ApplicationQuestion>) {
    setDraft(qs => qs.map(q => q.id === id ? { ...q, ...patch } : q));
  }

  function move(id: string, dir: -1 | 1) {
    setDraft(qs => {
      const i = qs.findIndex(q => q.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= qs.length) return qs;
      const next = [...qs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function remove(id: string) {
    setDraft(qs => qs.filter(q => q.id !== id));
  }

  function addQuestion() {
    const label = "New Question";
    const q: ApplicationQuestion = {
      id: genFieldId(), key: genFieldKey(label), label,
      type: "text", required: false, locked: false,
    };
    setDraft(qs => [...qs, q]);
  }

  async function handleSave() {
    setSaving(true); setError("");
    try {
      await saveApplicationForm(draft, user?.uid ?? "unknown");
      onSaved(draft);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save application form");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.55)", overflowY: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 720, borderRadius: 16, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", background: "#fff", margin: "20px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>⚙ Edit Application Form</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6b7280", lineHeight: 1, padding: 4 }}>✕</button>
        </div>

        <div style={{ padding: 20 }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: "24px 0", color: "#9ca3af", fontSize: 13 }}>Loading…</div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 16, lineHeight: 1.5 }}>
                These questions appear under &quot;Musical Skills&quot; on the New Admission form. Personal, contact, and photo
                fields are fixed and not editable here.
              </div>

              <div style={{ display: "flex", flexDirection: "column" as const, gap: 12 }}>
                {draft.map((q, i) => (
                  <div key={q.id} style={{ border: "1.5px dashed #8b3a4a55", borderRadius: 12, padding: 14 }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                      <input value={q.label} onChange={e => update(q.id, { label: e.target.value })}
                        placeholder="Question label" style={{ ...qInputStyle, fontWeight: 700, flex: 1 }} />
                      <select value={q.type} onChange={e => update(q.id, { type: e.target.value as ApplicationFieldType })}
                        style={{ ...qInputStyle, width: 160, cursor: "pointer" }}>
                        {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>

                    {(q.type === "single-select" || q.type === "multi-select") && (
                      <div style={{ marginBottom: 10 }}>
                        <label style={{ ...qLabelStyle, fontSize: 11 }}>Options (comma-separated)</label>
                        <input
                          value={(q.options ?? []).join(", ")}
                          onChange={e => update(q.id, { options: e.target.value.split(",").map(o => o.trim()).filter(Boolean) })}
                          placeholder="Option A, Option B, Option C" style={qInputStyle} />
                      </div>
                    )}

                    {q.type === "scale" && (
                      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ ...qLabelStyle, fontSize: 11 }}>Min</label>
                          <input type="number" value={q.scaleMin ?? 1}
                            onChange={e => update(q.id, { scaleMin: Number(e.target.value) || 1 })} style={qInputStyle} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ ...qLabelStyle, fontSize: 11 }}>Max</label>
                          <input type="number" value={q.scaleMax ?? 10}
                            onChange={e => update(q.id, { scaleMax: Number(e.target.value) || 10 })} style={qInputStyle} />
                        </div>
                      </div>
                    )}

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#374151", cursor: "pointer" }}>
                        <input type="checkbox" checked={q.required} onChange={e => update(q.id, { required: e.target.checked })} />
                        Required
                      </label>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button type="button" onClick={() => move(q.id, -1)} disabled={i === 0}
                          style={{ padding: "5px 9px", borderRadius: 6, border: "1px solid #e5e7eb", background: "#fff", cursor: i === 0 ? "not-allowed" : "pointer", opacity: i === 0 ? 0.4 : 1, fontSize: 12 }}>↑</button>
                        <button type="button" onClick={() => move(q.id, 1)} disabled={i === draft.length - 1}
                          style={{ padding: "5px 9px", borderRadius: 6, border: "1px solid #e5e7eb", background: "#fff", cursor: i === draft.length - 1 ? "not-allowed" : "pointer", opacity: i === draft.length - 1 ? 0.4 : 1, fontSize: 12 }}>↓</button>
                        <button type="button" onClick={() => remove(q.id)}
                          style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                          🗑 Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <button type="button" onClick={addQuestion}
                style={{ marginTop: 14, padding: "9px 16px", borderRadius: 10, border: "1px dashed #8b3a4a", background: "#fff", color: "#8b3a4a", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                + Add Question
              </button>

              {error && <div style={{ marginTop: 12, fontSize: 12, color: "#dc2626" }}>{error}</div>}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
                <button type="button" onClick={onClose} disabled={saving}
                  style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "#f3f4f6", color: "#6b7280", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  Cancel
                </button>
                <button type="button" onClick={handleSave} disabled={saving}
                  style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "#8b3a4a", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: saving ? 0.6 : 1 }}>
                  {saving ? "Saving…" : "💾 Save Application Form"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
