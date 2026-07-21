"use client";

import { useState, useEffect, useCallback } from "react";
import {
  collection, getDocs, query, where,
  addDoc, serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import { useAuthContext } from "@/features/auth/AuthContext";
import { ROLES } from "@/config/constants";
import {
  getQuestionBank, saveQuestionBank, genQuestionId, redistributeMarks,
  FAST_TRACK_TOTAL_MARKS, type FastTrackQuestion,
  getTrackQuestionBank, saveTrackQuestionBank, type TrackTestQuestion,
} from "@/services/screening/questionBank.service";

// ─── Types ────────────────────────────────────────────────────────────────────
type DrumStream = "little-mozarts" | "fast-track" | "joyful-track" | "creative-track";
type Grade = "High" | "Medium" | "Low";

interface StudentOption { uid: string; name: string; studentID: string; }

interface DrumConfig {
  track: string;
  syllabusStrategy: string;
  metronome: boolean;
  metronomeBpm: number;
  stickType: "Drumsticks" | "Brushes" | "Mallets";
  kickPedalTechnique: "Heel Down" | "Heel Up" | "Both";
  tempoRange: "Slow (< 80 BPM)" | "Medium (80–120 BPM)" | "Fast (120+ BPM)";
  grooveComplexity: "Basic 4/4" | "Syncopated Patterns" | "Polyrhythmic";
}

// ─── Constants ────────────────────────────────────────────────────────────────
const GRADE_SCORE: Record<Grade, number> = { High: 5, Medium: 3, Low: 1 };

const GRADE_CFG: Record<Grade, { border: string; bg: string; color: string }> = {
  High:   { border: "#16a34a", bg: "#f0fdf4", color: "#15803d" },
  Medium: { border: "#a05a2c", bg: "#f7ece1", color: "#7a4a1f" },
  Low:    { border: "#dc2626", bg: "#fef2f2", color: "#991b1b" },
};

const SLAB_CFG: Record<string, { border: string; bg: string; color: string; glow: string }> = {
  "Zeta Slab":    { border: "#16a34a", bg: "#f0fdf4", color: "#15803d", glow: "rgba(22,163,74,0.12)"  },
  "Epsilon Slab": { border: "#a05a2c", bg: "#f7ece1", color: "#7a4a1f", glow: "rgba(160,90,44,0.12)"  },
  "Delta Slab":   { border: "#dc2626", bg: "#fef2f2", color: "#991b1b", glow: "rgba(220,38,38,0.12)"  },
};

const STREAM_CFG = {
  "little-mozarts": { label: "Little Mozarts",  accent: "#059669", prefix: "DM-LM", age: "Ages 3–6"  },
  "fast-track":     { label: "Fast Track",       accent: "#a05a2c", prefix: "DM-FT", age: "Ages 7–30" },
  "joyful-track":   { label: "Joyful Track",     accent: "#db2777", prefix: "DM-JT", age: "Ages 31+"  },
  "creative-track": { label: "Creative Track",   accent: "#a85064", prefix: "DM-CT", age: "Adaptive"  },
} as const;

const STEP_LABELS: Record<DrumStream, string[]> = {
  "little-mozarts": ["Student Info", "Early Rhythm",    "Config & Save"],
  "fast-track":     ["Student Info", "Background",      "Assessment & Save"],
  "joyful-track":   ["Student Info", "Background",      "Pattern & Save"],
  "creative-track": ["Student Info", "Sensory Eval",    "Config & Save"],
};

const PERF_GOALS = [
  { id: "exams",    label: "Formal Exams",         desc: "Grade exams, certifications"        },
  { id: "stage",    label: "Stage Performances",   desc: "Live bands, recitals, showcases"    },
  { id: "both",     label: "Both",                 desc: "Exam certification & stage ready"   },
  { id: "personal", label: "Personal Development", desc: "Skill-building without pressure"    },
] as const;

const JT_GENRES = [
  "Bollywood", "Rock / Pop", "Jazz / Blues", "Classical (Percussion)",
  "Folk / World", "Carnatic", "Electronic / EDM", "Other",
] as const;

const DR_NOTATION_OPTIONS = ["Rhythm Notation", "Chord Charts / Tabs", "Numbers / Solfa", "None"] as const;
const YES_SOMEWHAT_NO = ["Yes", "Somewhat", "No"] as const;

// ─── Track question banks (editable, mirrors Fast Track's question bank) ──────
const GRADE_OPTIONS = ["High", "Medium", "Low"];
const SENSORY_OPTIONS = ["Positive", "Neutral", "Withdrawal", "Distress"];

const LM_QUESTIONS: TrackTestQuestion[] = [
  {
    id: "lm-01", code: "LM-01", title: "Sound Impact Sensitivity",
    sub: "Strike a practice pad once with a mallet — observe the child's immediate reaction without prompting.",
    options: SENSORY_OPTIONS,
    optionDescs: {
      Positive: "Reaches out readily, curious or pleased.",
      Neutral: "Notices without a strong reaction either way.",
      Withdrawal: "Hesitates or pulls back, but can be coaxed.",
      Distress: "Covers ears or reacts negatively.",
    },
  },
  {
    id: "lm-02", code: "LM-02", title: "Rhythmic Tapping Response",
    sub: "Teacher taps a 4-beat pulse on a practice pad — observe if the child joins in.",
    options: GRADE_OPTIONS,
    optionDescs: {
      High: "Joins the tapping with clear timing and enthusiasm.",
      Medium: "Attempts to join with some timing drift.",
      Low: "Little to no attempt to match the pulse.",
    },
  },
  {
    id: "lm-03", code: "LM-03", title: "Stick Grip Comfort",
    sub: "Hand the child a mallet or stick and observe how they hold and explore it.",
    options: GRADE_OPTIONS,
    optionDescs: {
      High: "Grips comfortably, explores confidently.",
      Medium: "Holds adequately, needs some guidance.",
      Low: "Struggles to hold or shows little interest.",
    },
  },
];

const JT_QUESTIONS: TrackTestQuestion[] = [
  {
    id: "jt-01", code: "JT-01", title: "Seated Posture at Kit",
    sub: "Observe posture and comfort while seated at the drum kit.",
    options: SENSORY_OPTIONS,
    optionDescs: {
      Positive: "Settles into a comfortable, relaxed seated posture quickly.",
      Neutral: "Sits adequately, no strong signal.",
      Withdrawal: "Some visible discomfort or repositioning.",
      Distress: "Clear discomfort or pain, avoids sitting properly.",
    },
  },
  {
    id: "jt-02", code: "JT-02", title: "Wrist & Arm Flexibility Check",
    sub: "Ask the student to rotate both wrists in full circles, then extend arms outward for 5 seconds. Observe range of motion and any discomfort.",
    options: SENSORY_OPTIONS,
    optionDescs: {
      Positive: "Full range, held comfortably without strain.",
      Neutral: "Adequate range, mild effort.",
      Withdrawal: "Limited range or visible strain.",
      Distress: "Significant difficulty or discomfort.",
    },
  },
];

const CT_QUESTIONS: TrackTestQuestion[] = [
  {
    id: "ct-01", code: "CT-01", title: "Sound Impact Response",
    sub: "Strike a snare drum at medium force — observe the student's immediate reaction. Strike once without warning; note flinching, covering ears, leaning toward the sound, or no reaction.",
    options: SENSORY_OPTIONS,
    optionDescs: {
      Positive: "Engaged, curious, or visibly enjoys the sound.",
      Neutral: "Attentive without a strong reaction.",
      Withdrawal: "Mild discomfort, looks away, covers ears briefly.",
      Distress: "Strong aversive reaction, needs the sound stopped.",
    },
  },
  {
    id: "ct-02", code: "CT-02", title: "Vibration & Tactile Sensitivity",
    sub: "Place the student's hand on the drumhead while you tap lightly — note their response. Observe tolerance to vibration through the hand; note hesitation, withdrawal, or curiosity.",
    options: SENSORY_OPTIONS,
    optionDescs: {
      Positive: "Reaches out readily, curious or pleased.",
      Neutral: "Tolerates the vibration without a strong reaction.",
      Withdrawal: "Hesitates or pulls back, but can be coaxed.",
      Distress: "Refuses contact or reacts negatively.",
    },
  },
  {
    id: "ct-03", code: "CT-03", title: "Rhythmic Mirror Response",
    sub: "Tap a 4-beat pulse on a practice pad — invite the student to mirror it. Hand the student a stick or invite them to use their hand; observe whether they mirror immediately, delay, or avoid.",
    options: SENSORY_OPTIONS,
    optionDescs: {
      Positive: "Mirrors the pulse readily and stays in sync.",
      Neutral: "Joins in with inconsistent timing.",
      Withdrawal: "Delayed or minimal participation.",
      Distress: "Avoids or ignores the pattern entirely.",
    },
  },
];

const DRUM_TESTS: FastTrackQuestion[] = [
  {
    id: "dr-01", code: "DR-01", title: "Steady Beat Maintenance",
    sub: "Basic kick + snare on beats 1 & 3 / 2 & 4 · 80 BPM · 8 bars",
    rubric: [
      { grade: "High",   desc: "Locked-in pulse from bar 1. Zero rushing or dragging through all 8 bars.",             marks: GRADE_SCORE.High },
      { grade: "Medium", desc: "Generally steady with minor rushes in bars 5–6. Self-corrects by bar 7.",              marks: GRADE_SCORE.Medium },
      { grade: "Low",    desc: "Cannot maintain steady pulse — either speeds up consistently or loses the beat.",      marks: GRADE_SCORE.Low },
    ],
  },
  {
    id: "dr-02", code: "DR-02", title: "Limb Independence",
    sub: "Hi-hat 8th notes + kick on beat 1 + snare on beat 3 · simultaneously",
    rubric: [
      { grade: "High",   desc: "All three limbs operate independently. No tension or stiffness between limbs.",  marks: GRADE_SCORE.High },
      { grade: "Medium", desc: "Hi-hat slows when kick or snare fires. Minor sympathy movement but recovers.",   marks: GRADE_SCORE.Medium },
      { grade: "Low",    desc: "Cannot maintain two limbs simultaneously. One limb stops when another plays.",   marks: GRADE_SCORE.Low },
    ],
  },
  {
    id: "dr-03", code: "DR-03", title: "Rudiment Execution",
    sub: "Single stroke roll (R-L-R-L) then double stroke roll (R-R-L-L) · 4 bars each",
    rubric: [
      { grade: "High",   desc: "Clean alternation on single strokes. Doubles rebound naturally without forcing.",              marks: GRADE_SCORE.High },
      { grade: "Medium", desc: "Singles clean, but doubles require effort — wrist tension visible at faster tempo.",           marks: GRADE_SCORE.Medium },
      { grade: "Low",    desc: "Strokes uneven or arm-heavy. Rebound not used — pushing each stroke manually.",                marks: GRADE_SCORE.Low },
    ],
  },
];

// ─── Config computations ──────────────────────────────────────────────────────
function computeFtConfig(all: Grade[]): DrumConfig {
  if (all.length > 0 && all.every(g => g === "High")) return {
    track: "Zeta Slab", syllabusStrategy: "Advanced Performance Track — Stage & Exam Ready",
    metronome: true, metronomeBpm: 100, stickType: "Drumsticks",
    kickPedalTechnique: "Both", tempoRange: "Fast (120+ BPM)", grooveComplexity: "Polyrhythmic",
  };
  if (all.some(g => g === "Low")) return {
    track: "Delta Slab", syllabusStrategy: "Structured Foundations — Rhythm Groundwork First",
    metronome: true, metronomeBpm: 60, stickType: "Drumsticks",
    kickPedalTechnique: "Heel Down", tempoRange: "Slow (< 80 BPM)", grooveComplexity: "Basic 4/4",
  };
  return {
    track: "Epsilon Slab", syllabusStrategy: "Accelerated Integration — Groove to Performance",
    metronome: true, metronomeBpm: 80, stickType: "Drumsticks",
    kickPedalTechnique: "Heel Down", tempoRange: "Medium (80–120 BPM)", grooveComplexity: "Syncopated Patterns",
  };
}

function computeJtConfig(answers: string[]): DrumConfig {
  const low = answers.some(a => a === "Distress" || a === "Withdrawal");
  return low
    ? {
        track: "Delta Slab", syllabusStrategy: "Gentle Engagement — Comfort-First Approach",
        metronome: false, metronomeBpm: 60, stickType: "Brushes",
        kickPedalTechnique: "Heel Down", tempoRange: "Slow (< 80 BPM)", grooveComplexity: "Basic 4/4",
      }
    : {
        track: "Epsilon Slab", syllabusStrategy: "Joyful Groove — Leisure & Wellness Track",
        metronome: true, metronomeBpm: 70, stickType: "Drumsticks",
        kickPedalTechnique: "Heel Down", tempoRange: "Medium (80–120 BPM)", grooveComplexity: "Basic 4/4",
      };
}

function lmConfig(): DrumConfig {
  return {
    track: "Delta Slab", syllabusStrategy: "Early Rhythm Foundations — Play, Tap, Explore",
    metronome: false, metronomeBpm: 60, stickType: "Mallets",
    kickPedalTechnique: "Heel Down", tempoRange: "Slow (< 80 BPM)", grooveComplexity: "Basic 4/4",
  };
}

function ctConfig(enabled: boolean, bpm: number, stick: DrumConfig["stickType"]): DrumConfig {
  return {
    track: "Delta Slab", syllabusStrategy: "Creative Adaptive Track — Sensory-Safe Percussion Exploration",
    metronome: enabled, metronomeBpm: bpm, stickType: stick,
    kickPedalTechnique: "Heel Down", tempoRange: "Slow (< 80 BPM)", grooveComplexity: "Basic 4/4",
  };
}

function genId(prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

// ─── Design primitives ────────────────────────────────────────────────────────
const card: React.CSSProperties = {
  background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18, padding: 24,
  boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
};
const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1.5px solid #f0f0f0", borderRadius: 10,
  padding: "10px 13px", fontSize: 13, outline: "none", fontFamily: "inherit", color: "#111", background: "#fafafa",
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: "0.09em", display: "block", marginBottom: 8,
};
const grid12: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 };

// ─── Sub-components ───────────────────────────────────────────────────────────
function GradeCard({ question, value, onChange, accent, editable, onQuestionChange, onRemove, canRemove }: {
  question: FastTrackQuestion;
  value: Grade | null; onChange: (g: Grade) => void; accent: string;
  editable?: boolean;
  onQuestionChange?: (q: FastTrackQuestion) => void;
  onRemove?: () => void;
  canRemove?: boolean;
}) {
  const { code, title, sub, rubric } = question;

  if (editable) {
    const setRubricField = (i: number, field: "desc", val: string) => {
      const nextRubric = rubric.map((r, ii) => ii === i ? { ...r, [field]: val } : r) as FastTrackQuestion["rubric"];
      onQuestionChange?.({ ...question, rubric: nextRubric });
    };
    return (
      <div style={{ ...card, gridColumn: "span 4", border: `1.5px dashed ${accent}55` }}>
        <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          <input value={code} onChange={e => onQuestionChange?.({ ...question, code: e.target.value })}
            placeholder="Code" style={{ ...inputStyle, fontSize: 11, fontWeight: 800, padding: "5px 9px", width: 90 }} />
          <input value={title} onChange={e => onQuestionChange?.({ ...question, title: e.target.value })}
            placeholder="Question title" style={{ ...inputStyle, fontWeight: 700, fontSize: 13 }} />
          <textarea value={sub} onChange={e => onQuestionChange?.({ ...question, sub: e.target.value })}
            placeholder="Instructions / setup" rows={2} style={{ ...inputStyle, resize: "vertical", fontSize: 12, lineHeight: 1.5 }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {rubric.map((r, i) => (
            <div key={r.grade} style={{ border: "1.5px solid #f0f0f0", borderRadius: 10, padding: "8px 10px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#374151" }}>{r.grade}</span>
                <span style={{ padding: "3px 8px", fontSize: 11, fontWeight: 700, color: "#6b7280",
                  background: "#f3f4f6", borderRadius: 6 }} title="Auto-distributed — not editable">
                  {r.marks.toFixed(1)} pts
                </span>
              </div>
              <textarea value={r.desc} rows={2}
                onChange={e => setRubricField(i, "desc", e.target.value)}
                style={{ ...inputStyle, fontSize: 11, resize: "vertical", padding: "6px 8px", lineHeight: 1.4 }} />
            </div>
          ))}
        </div>
        {onRemove && (
          <button type="button" onClick={onRemove} disabled={!canRemove}
            style={{ marginTop: 10, width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid #fecaca",
              background: canRemove ? "#fef2f2" : "#f9fafb", color: canRemove ? "#dc2626" : "#d1d5db",
              fontSize: 11, fontWeight: 700, cursor: canRemove ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
            🗑 Remove Question
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ ...card, gridColumn: "span 4" }}>
      <div style={{ marginBottom: 14 }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: accent, letterSpacing: "0.1em",
          textTransform: "uppercase", background: `${accent}18`, padding: "2px 8px", borderRadius: 6 }}>
          {code}
        </span>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#111", marginTop: 8 }}>{title}</div>
        <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{sub}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {rubric.map(({ grade, desc }) => {
          const sel = value === grade; const cfg = GRADE_CFG[grade];
          return (
            <button key={grade} onClick={() => onChange(grade)}
              style={{ textAlign: "left", border: `1.5px solid ${sel ? cfg.border : "#f0f0f0"}`,
                background: sel ? cfg.bg : "#fafafa", borderRadius: 10, padding: "9px 12px",
                cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: sel ? cfg.color : "#374151" }}>{grade}</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const OPTION_COLORS: Record<string, { border: string; bg: string; color: string }> = {
  High:       { border: "#16a34a", bg: "#f0fdf4", color: "#15803d" },
  Medium:     { border: "#a05a2c", bg: "#f7ece1", color: "#7a4a1f" },
  Low:        { border: "#dc2626", bg: "#fef2f2", color: "#991b1b" },
  Positive:   { border: "#16a34a", bg: "#f0fdf4", color: "#15803d" },
  Neutral:    { border: "#2563eb", bg: "#eff6ff", color: "#1d4ed8" },
  Withdrawal: { border: "#a05a2c", bg: "#f7ece1", color: "#7a4a1f" },
  Distress:   { border: "#dc2626", bg: "#fef2f2", color: "#991b1b" },
};
function optionColor(opt: string) {
  return OPTION_COLORS[opt] ?? { border: "#6b7280", bg: "#f3f4f6", color: "#374151" };
}

// ─── Generic editable test card (Little Mozarts / Joyful Track / Creative Track) ──
function TestCard({ question, value, onChange, accent, editable, onQuestionChange, onRemove, canRemove }: {
  question: TrackTestQuestion;
  value: string | null; onChange: (opt: string) => void; accent: string;
  editable?: boolean;
  onQuestionChange?: (q: TrackTestQuestion) => void;
  onRemove?: () => void;
  canRemove?: boolean;
}) {
  const { code, title, sub, options, optionDescs } = question;

  if (editable) {
    const setOptionDesc = (opt: string, val: string) => {
      onQuestionChange?.({ ...question, optionDescs: { ...optionDescs, [opt]: val } });
    };
    return (
      <div style={{ ...card, gridColumn: "span 12", border: `1.5px dashed ${accent}55` }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }} className="scr-sensory-grid">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <input value={code} onChange={e => onQuestionChange?.({ ...question, code: e.target.value })}
              placeholder="Code" style={{ ...inputStyle, fontSize: 11, fontWeight: 800, padding: "5px 9px", width: 90 }} />
            <input value={title} onChange={e => onQuestionChange?.({ ...question, title: e.target.value })}
              placeholder="Question title" style={{ ...inputStyle, fontWeight: 700, fontSize: 13 }} />
            <textarea value={sub} onChange={e => onQuestionChange?.({ ...question, sub: e.target.value })}
              placeholder="Instructions / setup" rows={3} style={{ ...inputStyle, resize: "vertical", fontSize: 12, lineHeight: 1.5 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {options.map(opt => (
              <div key={opt} style={{ border: "1.5px solid #f0f0f0", borderRadius: 10, padding: "8px 10px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 5 }}>{opt}</div>
                <textarea value={optionDescs[opt] ?? ""} rows={2}
                  onChange={e => setOptionDesc(opt, e.target.value)}
                  style={{ ...inputStyle, fontSize: 11, resize: "vertical", padding: "6px 8px", lineHeight: 1.4 }} />
              </div>
            ))}
          </div>
        </div>
        {onRemove && (
          <button type="button" onClick={onRemove} disabled={!canRemove}
            style={{ marginTop: 10, width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid #fecaca",
              background: canRemove ? "#fef2f2" : "#f9fafb", color: canRemove ? "#dc2626" : "#d1d5db",
              fontSize: 11, fontWeight: 700, cursor: canRemove ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
            🗑 Remove Question
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ ...card, gridColumn: "span 12" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }} className="scr-sensory-grid">
        <div>
          <span style={{ fontSize: 10, fontWeight: 800, color: accent, letterSpacing: "0.1em",
            textTransform: "uppercase", background: `${accent}18`, padding: "2px 8px", borderRadius: 6 }}>
            {code}
          </span>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#111", marginTop: 8 }}>{title}</div>
          <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{sub}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7, justifyContent: "center" }}>
          {options.map(opt => {
            const sel = value === opt;
            const c = optionColor(opt);
            return (
              <button key={opt} onClick={() => onChange(opt)}
                style={{ textAlign: "left", border: `1.5px solid ${sel ? c.border : "#f0f0f0"}`,
                  background: sel ? c.bg : "#fafafa", borderRadius: 10, padding: "9px 14px",
                  cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: sel ? c.color : "#374151" }}>{opt}</div>
                {optionDescs[opt] && (
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, lineHeight: 1.4 }}>{optionDescs[opt]}</div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stepper({ steps, current, accent }: { steps: string[]; current: number; accent: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", marginBottom: 28 }}>
      {steps.map((label, i) => {
        const n = i + 1; const done = current > n; const active = current === n;
        return (
          <div key={n} style={{ display: "flex", alignItems: "flex-start", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
              <div style={{ width: 34, height: 34, borderRadius: "50%",
                background: done || active ? accent : "#f3f4f6",
                color: done || active ? "#fff" : "#9ca3af",
                boxShadow: active ? `0 0 0 5px ${accent}1a` : "none",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 700, flexShrink: 0, transition: "all 0.2s" }}>
                {done ? "✓" : n}
              </div>
              <div style={{ fontSize: 11, marginTop: 6, fontWeight: active ? 700 : 400,
                color: active ? accent : done ? "#6b7280" : "#9ca3af" }}>
                {label}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div style={{ height: 2, width: 48, flexShrink: 0, alignSelf: "flex-start", marginTop: 16,
                background: done ? accent : "#f0f0f0", transition: "background 0.3s" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StudentSearch({ value, onChange, onSelect, onBlur, results, loading, showDropdown }: {
  value: string; onChange: (v: string) => void; onSelect: (s: StudentOption) => void;
  onBlur: () => void; results: StudentOption[]; loading: boolean; showDropdown: boolean;
}) {
  return (
    <div style={{ position: "relative" }}>
      <input value={value} onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder="Search and select from the list…"
        style={{ ...inputStyle, paddingRight: loading ? 36 : 13 }} />
      {loading && (
        <div style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
          width: 14, height: 14, border: "2px solid #e5e7eb", borderTopColor: "#6b7280",
          borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      )}
      {showDropdown && results.length > 0 && (
        <div style={{ position: "absolute", zIndex: 50, top: "100%", left: 0, right: 0,
          background: "#fff", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 12,
          boxShadow: "0 8px 24px rgba(0,0,0,0.1)", marginTop: 4, overflow: "hidden" }}>
          {results.map(s => (
            <button key={s.uid}
              onMouseDown={e => e.preventDefault()}
              onClick={() => onSelect(s)}
              style={{ width: "100%", textAlign: "left", padding: "10px 14px", border: "none",
                background: "none", cursor: "pointer", fontFamily: "inherit", display: "flex",
                alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #f3f4f6" }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: "#111" }}>{s.name}</span>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>{s.studentID}</span>
            </button>
          ))}
        </div>
      )}
      {showDropdown && !loading && results.length === 0 && (
        <div style={{ position: "absolute", zIndex: 50, top: "100%", left: 0, right: 0,
          background: "#fff", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 12,
          padding: "12px 14px", marginTop: 4, fontSize: 13, color: "#9ca3af",
          boxShadow: "0 8px 24px rgba(0,0,0,0.1)" }}>
          No students found.
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function DrumScreeningContent({ onBack }: { onBack?: () => void }) {
  const { user } = useAuthContext();
  const [stream, setStream]     = useState<DrumStream>("fast-track");
  const [step, setStep]         = useState(1);
  const [assessmentId, setAssessmentId] = useState(() => genId(STREAM_CFG["fast-track"].prefix));

  // Student search
  const [studentName,   setStudentName]   = useState("");
  const [allStudents,   setAllStudents]   = useState<StudentOption[]>([]);
  const [studsLoading,  setStudsLoading]  = useState(false);
  const [showDropdown,  setShowDropdown]  = useState(false);
  const [linkedStudent, setLinkedStudent] = useState<StudentOption | null>(null);

  // Save state
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [saveErr, setSaveErr] = useState("");

  // ── LM state ──────────────────────────────────────────────────────────────
  const [lm_devFocus,         setLmDevFocus]    = useState("");
  const [lm_attention,        setLmAttention]   = useState("");
  const [lm_interactionStyle, setLmInteraction] = useState("");
  const [lm_grossMotor,       setLmGrossMotor]  = useState("");
  const [lm_questions,   setLmQuestions]   = useState<TrackTestQuestion[]>(LM_QUESTIONS);
  const [lmAnswers,      setLmAnswers]     = useState<Record<string, string>>({});
  const [lmEditMode,     setLmEditMode]    = useState(false);
  const [lmDraftQuestions, setLmDraftQuestions] = useState<TrackTestQuestion[]>(LM_QUESTIONS);
  const [lmBankSaving,   setLmBankSaving]  = useState(false);

  // ── FT state ──────────────────────────────────────────────────────────────
  const [ft_notation,         setFtNotation] = useState<string[]>([]);
  const [ft_performanceGoal,  setFtGoal]    = useState("");
  const [ft_rhythmSense,      setFtRhythm]  = useState("");
  const [ft_earSense,         setFtEar]     = useState("");
  const [ft_questions,   setFtQuestions]   = useState<FastTrackQuestion[]>(() => redistributeMarks(DRUM_TESTS));
  const [ftGradeMap,     setFtGradeMap]    = useState<Record<string, Grade | null>>({});
  const [ftEditMode,     setFtEditMode]    = useState(false);
  const [ftDraftQuestions, setFtDraftQuestions] = useState<FastTrackQuestion[]>(() => redistributeMarks(DRUM_TESTS));
  const [ftBankSaving,   setFtBankSaving]  = useState(false);

  // ── JT state ──────────────────────────────────────────────────────────────
  const [jt_genres,          setJtGenres]     = useState<string[]>([]);
  const [jt_motivation,      setJtMotivation] = useState("");
  const [jt_practiceTime,    setJtPractice]   = useState("");
  const [jt_physicalNotes,   setJtPhysical]   = useState("");
  const [jt_questions,   setJtQuestions]   = useState<TrackTestQuestion[]>(JT_QUESTIONS);
  const [jtAnswers,      setJtAnswers]     = useState<Record<string, string>>({});
  const [jtEditMode,     setJtEditMode]    = useState(false);
  const [jtDraftQuestions, setJtDraftQuestions] = useState<TrackTestQuestion[]>(JT_QUESTIONS);
  const [jtBankSaving,   setJtBankSaving]  = useState(false);

  // ── CT state ──────────────────────────────────────────────────────────────
  const [ct_emotionalTriggers, setCtTriggers]  = useState("");
  const [ct_soundThreshold,    setCtSound]     = useState("");
  const [ct_visualMods,        setCtVisual]    = useState("");
  const [ct_questions,   setCtQuestions]   = useState<TrackTestQuestion[]>(CT_QUESTIONS);
  const [ctAnswers,      setCtAnswers]     = useState<Record<string, string>>({});
  const [ctEditMode,     setCtEditMode]    = useState(false);
  const [ctDraftQuestions, setCtDraftQuestions] = useState<TrackTestQuestion[]>(CT_QUESTIONS);
  const [ctBankSaving,   setCtBankSaving]  = useState(false);
  const [ct_metronomeEnabled,  setCtMetronome] = useState(false);
  const [ct_metronomeBpm,      setCtBpm]       = useState(60);
  const [ct_stickType,         setCtStick]     = useState<DrumConfig["stickType"]>("Mallets");

  // ── Reset on stream change ─────────────────────────────────────────────────
  const resetAll = useCallback((s: DrumStream) => {
    setStep(1); setAssessmentId(genId(STREAM_CFG[s].prefix));
    setStudentName(""); setLinkedStudent(null); setShowDropdown(false);
    setSaved(false); setSaveErr(""); setSaving(false);
    setLmDevFocus(""); setLmAttention(""); setLmInteraction(""); setLmGrossMotor("");
    setLmAnswers({}); setLmEditMode(false);
    setFtNotation([]); setFtGoal(""); setFtRhythm(""); setFtEar("");
    setFtGradeMap({}); setFtEditMode(false);
    setJtGenres([]); setJtMotivation(""); setJtPractice(""); setJtPhysical("");
    setJtAnswers({}); setJtEditMode(false);
    setCtTriggers(""); setCtSound(""); setCtVisual("");
    setCtAnswers({}); setCtEditMode(false);
    setCtMetronome(false); setCtBpm(60); setCtStick("Mallets");
  }, []);

  useEffect(() => { resetAll(stream); }, [stream, resetAll]);

  // ── Load question banks (falls back to defaults if unsaved) ─────────────────
  useEffect(() => {
    getQuestionBank("drums").then(qs => {
      if (qs && qs.length > 0) {
        const balanced = redistributeMarks(qs);
        setFtQuestions(balanced); setFtDraftQuestions(balanced);
      }
    }).catch(() => {});
    getTrackQuestionBank("drums", "lmQuestions").then(qs => {
      if (qs && qs.length > 0) { setLmQuestions(qs); setLmDraftQuestions(qs); }
    }).catch(() => {});
    getTrackQuestionBank("drums", "jtQuestions").then(qs => {
      if (qs && qs.length > 0) { setJtQuestions(qs); setJtDraftQuestions(qs); }
    }).catch(() => {});
    getTrackQuestionBank("drums", "ctQuestions").then(qs => {
      if (qs && qs.length > 0) { setCtQuestions(qs); setCtDraftQuestions(qs); }
    }).catch(() => {});
  }, []);

  // ── Student search (users + admissions) ───────────────────────────────────
  useEffect(() => {
    if (!studentName.trim() || linkedStudent) { setAllStudents([]); setShowDropdown(false); return; }
    const t = setTimeout(async () => {
      setStudsLoading(true);
      try {
        const term = studentName.toLowerCase();
        const uq = query(collection(db, "users"), where("role", "==", "student"));
        const [uSnap, aSnap] = await Promise.all([getDocs(uq), getDocs(collection(db, "admissions"))]);
        const users: StudentOption[] = uSnap.docs
          .map(d => ({ uid: d.id, ...(d.data() as { name: string; studentID: string }) }))
          .filter(s => s.name?.toLowerCase().includes(term) || s.studentID?.toLowerCase().includes(term));
        const applicants: StudentOption[] = aSnap.docs
          .map(d => {
            const data = d.data() as Record<string, string>;
            return { uid: d.id, name: data.fullName ?? "", studentID: "Applicant" };
          })
          .filter(s => s.name?.toLowerCase().includes(term) && s.name);
        const seen = new Set<string>();
        const merged: StudentOption[] = [];
        for (const s of [...users, ...applicants]) {
          if (!seen.has(s.name)) { seen.add(s.name); merged.push(s); }
          if (merged.length >= 8) break;
        }
        setAllStudents(merged); setShowDropdown(true);
      } finally { setStudsLoading(false); }
    }, 280);
    return () => clearTimeout(t);
  }, [studentName, linkedStudent]);

  const selectStudent = (s: StudentOption) => {
    setLinkedStudent(s); setStudentName(s.name); setShowDropdown(false);
  };

  // ── Config derivation ──────────────────────────────────────────────────────
  const ftAnsweredGrades: Grade[] = ft_questions
    .map(q => ftGradeMap[q.id])
    .filter((g): g is Grade => g != null);
  const ftAllAnswered = ft_questions.length > 0 && ftAnsweredGrades.length === ft_questions.length;

  const derivedConfig: DrumConfig | null = (() => {
    if (stream === "little-mozarts") return lmConfig();
    if (stream === "fast-track" && ftAllAnswered) return computeFtConfig(ftAnsweredGrades);
    if (stream === "joyful-track") return computeJtConfig(Object.values(jtAnswers));
    if (stream === "creative-track") return ctConfig(ct_metronomeEnabled, ct_metronomeBpm, ct_stickType);
    return null;
  })();

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!derivedConfig) return;
    setSaving(true); setSaveErr("");
    try {
      const payload: Record<string, unknown> = {
        assessmentId, stream, instrument: "drums",
        teacherId: user?.uid, teacherEmail: user?.email,
        studentId: linkedStudent?.uid ?? null,
        studentName: linkedStudent?.name ?? studentName,
        config: derivedConfig, createdAt: serverTimestamp(),
      };
      if (stream === "little-mozarts") Object.assign(payload, {
        lm_devFocus, lm_attention, lm_interactionStyle, lm_grossMotor,
        lm_answers: lm_questions.map(q => ({ questionId: q.id, code: q.code, title: q.title, answer: lmAnswers[q.id] ?? null })),
      });
      if (stream === "fast-track") {
        const gradeAnswers = ft_questions.map(q => {
          const g   = ftGradeMap[q.id] ?? null;
          const rub = g ? q.rubric.find(r => r.grade === g) : undefined;
          return { questionId: q.id, code: q.code, title: q.title, grade: g, marks: rub?.marks ?? 0 };
        });
        Object.assign(payload, {
          ft_notation, ft_performanceGoal, ft_rhythmSense, ft_earSense,
          ft_gradeAnswers: gradeAnswers,
          ft_totalScore: gradeAnswers.reduce((a, g) => a + g.marks, 0),
          ft_maxScore: ft_questions.reduce((a, q) => a + Math.max(...q.rubric.map(r => r.marks)), 0),
        });
      }
      if (stream === "joyful-track") Object.assign(payload, {
        jt_genres, jt_motivation, jt_practiceTime, jt_physicalNotes,
        jt_answers: jt_questions.map(q => ({ questionId: q.id, code: q.code, title: q.title, answer: jtAnswers[q.id] ?? null })),
      });
      if (stream === "creative-track") Object.assign(payload, {
        ct_emotionalTriggers, ct_soundThreshold, ct_visualMods,
        ct_answers: ct_questions.map(q => ({ questionId: q.id, code: q.code, title: q.title, answer: ctAnswers[q.id] ?? null })),
        ct_metronomeEnabled, ct_metronomeBpm, ct_stickType,
      });
      await addDoc(collection(db, "drum-screenings"), payload);
      setSaved(true);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  };

  // ── Fast Track question bank editing (admin only) ───────────────────────────
  const isAdmin = user?.role === ROLES.ADMIN || user?.role === ROLES.SUPER_ADMIN;

  function addFtQuestion() {
    const n = ftDraftQuestions.length + 1;
    const newQ: FastTrackQuestion = {
      id: genQuestionId("dr"),
      code: `DR-${String(n).padStart(2, "0")}`,
      title: "New Question", sub: "",
      rubric: [
        { grade: "High",   desc: "", marks: 0 },
        { grade: "Medium", desc: "", marks: 0 },
        { grade: "Low",    desc: "", marks: 0 },
      ],
    };
    setFtDraftQuestions(qs => redistributeMarks([...qs, newQ]));
  }

  function removeFtQuestion(id: string) {
    setFtDraftQuestions(qs => qs.length > 1 ? redistributeMarks(qs.filter(q => q.id !== id)) : qs);
  }

  function updateFtDraftQuestion(id: string, updated: FastTrackQuestion) {
    setFtDraftQuestions(qs => qs.map(q => q.id === id ? updated : q));
  }

  function cancelFtEdit() {
    setFtDraftQuestions(ft_questions);
    setFtEditMode(false);
  }

  async function saveFtQuestions() {
    setFtBankSaving(true);
    try {
      await saveQuestionBank("drums", ftDraftQuestions, user?.uid ?? "unknown");
      setFtQuestions(ftDraftQuestions);
      setFtGradeMap({});
      setFtEditMode(false);
    } catch (e) {
      console.error("Failed to save drums question bank:", e);
    } finally {
      setFtBankSaving(false);
    }
  }

  const sc = STREAM_CFG[stream];
  const ACCENT = sc.accent;
  const stepLabels = STEP_LABELS[stream];

  const btnPrimary: React.CSSProperties = {
    padding: "11px 22px", borderRadius: 12, border: "none", fontSize: 13, fontWeight: 700,
    cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center",
    background: ACCENT, color: "#fff", transition: "opacity 0.15s",
  };
  const btnSec: React.CSSProperties = { ...btnPrimary, background: "#f3f4f6", color: "#374151" };

  function ConfigRows({ cfg }: { cfg: DrumConfig }) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {[
          { label: "Track",            val: cfg.track },
          { label: "Strategy",         val: cfg.syllabusStrategy },
          { label: "Metronome",        val: cfg.metronome ? `Yes @ ${cfg.metronomeBpm} BPM` : "No" },
          { label: "Stick Type",       val: cfg.stickType },
          { label: "Kick Pedal",       val: cfg.kickPedalTechnique },
          { label: "Tempo Range",      val: cfg.tempoRange },
          { label: "Groove Complexity",val: cfg.grooveComplexity },
        ].map(({ label, val }) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "8px 12px", background: "#f8f9fa", borderRadius: 10 }}>
            <span style={{ fontSize: 12, color: "#6b7280" }}>{label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{val}</span>
          </div>
        ))}
      </div>
    );
  }

  function renderSaveRow() {
    if (saved) {
      return (
        <div style={{ ...card, gridColumn: "span 12", textAlign: "center", borderColor: "#16a34a", background: "#f0fdf4" }}>
          <div style={{ fontSize: 20, marginBottom: 6 }}>✓</div>
          <div style={{ fontWeight: 700, color: "#15803d", fontSize: 15 }}>Screening Saved</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>Assessment ID: {assessmentId}</div>
        </div>
      );
    }
    return (
      <div style={{ ...card, gridColumn: "span 12" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#111" }}>Save to Firebase</div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
              Saves to{" "}
              <code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: 4 }}>drum-screenings</code>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <button onClick={handleSave} disabled={saving || !derivedConfig}
              style={{ ...btnPrimary, opacity: saving || !derivedConfig ? 0.5 : 1, minWidth: 160 }}>
              {saving ? "Saving…" : "Save Screening"}
            </button>
            {saveErr && <div style={{ fontSize: 12, color: "#dc2626" }}>{saveErr}</div>}
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#f8f9fa", padding: "24px 0" }}>
      <style>{`@keyframes spin{to{transform:translateY(-50%) rotate(360deg)}}`}</style>

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 24px" }} className="scr-outer">

        {/* Back + ID row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
          {onBack
            ? <button onClick={onBack} style={{ ...btnSec, padding: "8px 16px", fontSize: 12 }}>← Back</button>
            : <Link href="/dashboard/screening" style={{ ...btnSec, padding: "8px 16px", fontSize: 12, textDecoration: "none" }}>← Back</Link>
          }
          <div style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, letterSpacing: "0.06em" }}>
            ID: {assessmentId}
          </div>
        </div>

        {/* Gradient header */}
        <div style={{ background: "linear-gradient(135deg, #dc2626 0%, #dc262699 100%)",
          borderRadius: 20, padding: "28px 32px", marginBottom: 22, color: "#fff",
          boxShadow: "0 8px 32px rgba(220,38,38,0.35)" }} className="scr-hero">
          <div style={{ fontSize: 11, fontWeight: 800, opacity: 0.75, textTransform: "uppercase",
            letterSpacing: "0.12em", marginBottom: 6 }}>Drum Screening</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>{sc.label}</div>
          <div style={{ fontSize: 13, opacity: 0.8 }}>{sc.age} · Drum-specific adaptive questionnaire</div>
        </div>

        {/* Stream tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
          {(Object.entries(STREAM_CFG) as [DrumStream, typeof STREAM_CFG["fast-track"]][]).map(([key, cfg]) => {
            const active = stream === key;
            return (
              <button key={key} onClick={() => setStream(key)}
                style={{ padding: "9px 18px", borderRadius: 12,
                  border: `1.5px solid ${active ? cfg.accent : "#e5e7eb"}`,
                  background: active ? cfg.accent : "#fff",
                  color: active ? "#fff" : "#6b7280",
                  fontSize: 12, fontWeight: active ? 700 : 500, cursor: "pointer",
                  fontFamily: "inherit", transition: "all 0.18s" }}>
                {cfg.label}
              </button>
            );
          })}
        </div>

        {isAdmin && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
            {stream === "little-mozarts" && !lmEditMode && (
              <button type="button"
                onClick={() => { setLmDraftQuestions(lm_questions); setLmEditMode(true); setStep(3); }}
                style={{ ...btnSec, padding: "8px 16px", fontSize: 12 }}>
                ✎ Edit Screening Questions
              </button>
            )}
            {stream === "fast-track" && !ftEditMode && (
              <button type="button"
                onClick={() => { setFtDraftQuestions(ft_questions); setFtEditMode(true); setStep(3); }}
                style={{ ...btnSec, padding: "8px 16px", fontSize: 12 }}>
                ✎ Edit Screening Questions
              </button>
            )}
            {stream === "joyful-track" && !jtEditMode && (
              <button type="button"
                onClick={() => { setJtDraftQuestions(jt_questions); setJtEditMode(true); setStep(3); }}
                style={{ ...btnSec, padding: "8px 16px", fontSize: 12 }}>
                ✎ Edit Screening Questions
              </button>
            )}
            {stream === "creative-track" && !ctEditMode && (
              <button type="button"
                onClick={() => { setCtDraftQuestions(ct_questions); setCtEditMode(true); setStep(3); }}
                style={{ ...btnSec, padding: "8px 16px", fontSize: 12 }}>
                ✎ Edit Screening Questions
              </button>
            )}
          </div>
        )}

        {/* Stepper */}
        <Stepper steps={stepLabels} current={step} accent={ACCENT} />

        {/* ── Step 1: Student Info ─────────────────────────────────────────── */}
        {step === 1 && (
          <div style={grid12} className="scr-grid">
            <div style={{ ...card, gridColumn: "span 7" }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#111", marginBottom: 18 }}>
                Student Information
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Search Student</label>
                <StudentSearch value={studentName}
                  onChange={v => { setStudentName(v); setLinkedStudent(null); }}
                  onSelect={selectStudent} results={allStudents}
                  loading={studsLoading} showDropdown={showDropdown}
                  onBlur={() => { if (!linkedStudent) { setStudentName(""); setShowDropdown(false); } }} />
                {linkedStudent && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#059669", fontWeight: 600 }}>
                    ✓ Linked: {linkedStudent.name} ({linkedStudent.studentID})
                  </div>
                )}
              </div>
            </div>

            <div style={{ ...card, gridColumn: "span 5" }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#111", marginBottom: 14 }}>
                Stream Overview
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { label: "Instrument", val: "Drums" },
                  { label: "Stream",     val: sc.label },
                  { label: "Age Group",  val: sc.age   },
                  { label: "Steps",      val: `${stepLabels.length} phases` },
                ].map(({ label, val }) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "9px 13px", background: "#f8f9fa", borderRadius: 10 }}>
                    <span style={{ fontSize: 12, color: "#6b7280" }}>{label}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{val}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => setStep(2)} disabled={!linkedStudent}
                style={{ ...btnPrimary, opacity: !linkedStudent ? 0.4 : 1 }}>
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Stream questionnaire ─────────────────────────────────── */}
        {step === 2 && (
          <>
            {/* LITTLE MOZARTS */}
            {stream === "little-mozarts" && (
              <div style={grid12} className="scr-grid">
                <div style={{ ...card, gridColumn: "span 12" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Early Development Profile
                  </div>
                  {[
                    { label: "Developmental Focus",   val: lm_devFocus,        set: setLmDevFocus,    ph: "Gross motor, exploratory play, social…"        },
                    { label: "Attention Span",         val: lm_attention,       set: setLmAttention,   ph: "Estimated in minutes, context…"                },
                    { label: "Interaction Style",      val: lm_interactionStyle,set: setLmInteraction, ph: "Verbal, guided, observer, parallel play…"      },
                    { label: "Gross Motor Observation",val: lm_grossMotor,      set: setLmGrossMotor,  ph: "Arm reach, bilateral coordination, energy…"    },
                  ].map(({ label, val, set, ph }) => (
                    <div key={label} style={{ marginBottom: 14 }}>
                      <label style={labelStyle}>{label}</label>
                      <input value={val} onChange={e => set(e.target.value)} placeholder={ph} style={inputStyle} />
                    </div>
                  ))}
                </div>

                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
                  <button onClick={() => setStep(1)} style={btnSec}>← Back</button>
                  <button onClick={() => setStep(3)} style={btnPrimary}>Continue →</button>
                </div>
              </div>
            )}

            {/* FAST TRACK */}
            {stream === "fast-track" && (
              <div style={grid12} className="scr-grid">
                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Background Information
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={labelStyle}>Notation Familiarity</label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                      {DR_NOTATION_OPTIONS.map(opt => {
                        const sel = ft_notation.includes(opt);
                        return (
                          <button key={opt}
                            onClick={() => setFtNotation(p => sel ? p.filter(x => x !== opt) : [...p, opt])}
                            style={{ padding: "6px 12px", borderRadius: 8,
                              border: `1.5px solid ${sel ? ACCENT : "#e5e7eb"}`,
                              background: sel ? `${ACCENT}18` : "#fafafa",
                              color: sel ? ACCENT : "#6b7280",
                              fontSize: 12, fontWeight: sel ? 700 : 400, cursor: "pointer", fontFamily: "inherit" }}>
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={labelStyle}>Can Keep a Steady Beat / Rhythm</label>
                    <select value={ft_rhythmSense} onChange={e => setFtRhythm(e.target.value)}
                      style={{ ...inputStyle, appearance: "none" }}>
                      <option value="">Select…</option>
                      {YES_SOMEWHAT_NO.map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Notices When a Note Sounds Out of Tune</label>
                    <select value={ft_earSense} onChange={e => setFtEar(e.target.value)}
                      style={{ ...inputStyle, appearance: "none" }}>
                      <option value="">Select…</option>
                      {YES_SOMEWHAT_NO.map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Performance Goals
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {PERF_GOALS.map(g => {
                      const sel = ft_performanceGoal === g.id;
                      return (
                        <button key={g.id} onClick={() => setFtGoal(g.id)}
                          style={{ textAlign: "left", border: `1.5px solid ${sel ? ACCENT : "#f0f0f0"}`,
                            background: sel ? `${ACCENT}10` : "#fafafa", borderRadius: 10,
                            padding: "10px 14px", cursor: "pointer", fontFamily: "inherit" }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: sel ? ACCENT : "#111" }}>{g.label}</div>
                          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{g.desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
                  <button onClick={() => setStep(1)} style={btnSec}>← Back</button>
                  <button onClick={() => setStep(3)} disabled={!ft_rhythmSense || !ft_performanceGoal}
                    style={{ ...btnPrimary, opacity: !ft_rhythmSense || !ft_performanceGoal ? 0.4 : 1 }}>
                    Continue →
                  </button>
                </div>
              </div>
            )}

            {/* JOYFUL TRACK */}
            {stream === "joyful-track" && (
              <div style={grid12} className="scr-grid">
                <div style={{ ...card, gridColumn: "span 7" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Musical Background
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={labelStyle}>Favourite Genres</label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                      {JT_GENRES.map(g => {
                        const sel = jt_genres.includes(g);
                        return (
                          <button key={g}
                            onClick={() => setJtGenres(gs => sel ? gs.filter(x => x !== g) : [...gs, g])}
                            style={{ padding: "6px 12px", borderRadius: 8,
                              border: `1.5px solid ${sel ? ACCENT : "#e5e7eb"}`,
                              background: sel ? `${ACCENT}18` : "#fafafa",
                              color: sel ? ACCENT : "#6b7280",
                              fontSize: 12, fontWeight: sel ? 700 : 400, cursor: "pointer", fontFamily: "inherit" }}>
                            {g}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={labelStyle}>Motivation for Drums</label>
                    <textarea value={jt_motivation} onChange={e => setJtMotivation(e.target.value)}
                      rows={3} placeholder="Why do they want to learn drums at this stage of life?"
                      style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Available Practice Time (per week)</label>
                    <select value={jt_practiceTime} onChange={e => setJtPractice(e.target.value)}
                      style={{ ...inputStyle, appearance: "none" }}>
                      <option value="">Select…</option>
                      {["< 1 hour", "1–2 hours", "3–5 hours", "5+ hours"].map(v =>
                        <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ ...card, gridColumn: "span 5" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Physical Considerations
                  </div>
                  <label style={labelStyle}>Physical Notes</label>
                  <textarea value={jt_physicalNotes} onChange={e => setJtPhysical(e.target.value)}
                    rows={3} placeholder="Shoulder/wrist issues, grip strength, stamina, joint mobility…"
                    style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
                </div>

                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
                  <button onClick={() => setStep(1)} style={btnSec}>← Back</button>
                  <button onClick={() => setStep(3)} style={btnPrimary}>Continue →</button>
                </div>
              </div>
            )}

            {/* CREATIVE TRACK */}
            {stream === "creative-track" && (
              <div style={grid12} className="scr-grid">
                <div style={{ ...card, gridColumn: "span 12" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Sensory Profile
                  </div>
                  {[
                    { label: "Emotional Triggers",          val: ct_emotionalTriggers, set: setCtTriggers,
                      ph: "Loud sounds, sudden impacts, vibration sensitivity…"        },
                    { label: "Sound / Volume Threshold",    val: ct_soundThreshold,    set: setCtSound,
                      ph: "Reactions to snare crack, cymbal wash, bass drum thud…"    },
                    { label: "Visual Modifications Needed", val: ct_visualMods,        set: setCtVisual,
                      ph: "Low-light preference, visual clutter, music stand needs…"  },
                  ].map(({ label, val, set, ph }) => (
                    <div key={label} style={{ marginBottom: 14 }}>
                      <label style={labelStyle}>{label}</label>
                      <textarea value={val} onChange={e => set(e.target.value)} rows={3}
                        placeholder={ph} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
                    </div>
                  ))}
                </div>

                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
                  <button onClick={() => setStep(1)} style={btnSec}>← Back</button>
                  <button onClick={() => setStep(3)} style={btnPrimary}>Continue →</button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Step 3: Assessment / Config & Save ───────────────────────────── */}
        {step === 3 && (
          <>
            {/* LITTLE MOZARTS */}
            {stream === "little-mozarts" && (
              <div style={grid12} className="scr-grid">
                {isAdmin && (
                  <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {!lmEditMode ? (
                      <button type="button" onClick={() => { setLmDraftQuestions(lm_questions); setLmEditMode(true); }}
                        style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>✎ Edit Questions</button>
                    ) : (
                      <>
                        <button type="button" onClick={() => setLmDraftQuestions(qs => [...qs, {
                            id: genQuestionId("lm"), code: `LM-${String(qs.length + 1).padStart(2, "0")}`,
                            title: "New Question", sub: "", options: GRADE_OPTIONS, optionDescs: {},
                          }])} style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>+ Add Question</button>
                        <button type="button" onClick={() => { setLmDraftQuestions(lm_questions); setLmEditMode(false); }}
                          disabled={lmBankSaving} style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>Cancel</button>
                        <button type="button" disabled={lmBankSaving}
                          onClick={async () => {
                            setLmBankSaving(true);
                            try {
                              await saveTrackQuestionBank("drums", "lmQuestions", lmDraftQuestions, user?.uid ?? "unknown");
                              setLmQuestions(lmDraftQuestions); setLmAnswers({}); setLmEditMode(false);
                            } finally { setLmBankSaving(false); }
                          }}
                          style={{ ...btnPrimary, padding: "7px 14px", fontSize: 12, opacity: lmBankSaving ? 0.6 : 1 }}>
                          {lmBankSaving ? "Saving…" : "💾 Save Questions"}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {lmEditMode
                  ? lmDraftQuestions.map(q => (
                      <TestCard key={q.id} question={q} value={null} onChange={() => {}} accent={ACCENT}
                        editable onQuestionChange={updated => setLmDraftQuestions(qs => qs.map(x => x.id === q.id ? updated : x))}
                        onRemove={() => setLmDraftQuestions(qs => qs.length > 1 ? qs.filter(x => x.id !== q.id) : qs)}
                        canRemove={lmDraftQuestions.length > 1} />
                    ))
                  : lm_questions.map(q => (
                      <TestCard key={q.id} question={q} accent={ACCENT}
                        value={lmAnswers[q.id] ?? null}
                        onChange={opt => setLmAnswers(prev => ({ ...prev, [q.id]: opt }))} />
                    ))}

                {!lmEditMode && (
                  <div style={{ ...card, gridColumn: "span 12" }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 14 }}>
                      Recommended Config
                    </div>
                    <ConfigRows cfg={lmConfig()} />
                  </div>
                )}

                {!lmEditMode && renderSaveRow()}
                {!lmEditMode && (
                  <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-start" }}>
                    <button onClick={() => setStep(2)} style={btnSec}>← Back</button>
                  </div>
                )}
              </div>
            )}

            {/* FAST TRACK */}
            {stream === "fast-track" && (
              <div style={grid12} className="scr-grid">
                {isAdmin && (
                  <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {ftEditMode && (
                      <span style={{ fontSize: 11, color: "#9ca3af", marginRight: "auto" }}>
                        Marks auto-distribute evenly across all questions — total {FAST_TRACK_TOTAL_MARKS} pts
                      </span>
                    )}
                    {!ftEditMode ? (
                      <button type="button" onClick={() => { setFtDraftQuestions(ft_questions); setFtEditMode(true); }}
                        style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>✎ Edit Questions</button>
                    ) : (
                      <>
                        <button type="button" onClick={addFtQuestion} style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>+ Add Question</button>
                        <button type="button" onClick={cancelFtEdit} disabled={ftBankSaving} style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>Cancel</button>
                        <button type="button" onClick={saveFtQuestions} disabled={ftBankSaving}
                          style={{ ...btnPrimary, padding: "7px 14px", fontSize: 12, opacity: ftBankSaving ? 0.6 : 1 }}>
                          {ftBankSaving ? "Saving…" : "💾 Save Questions"}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {ftEditMode
                  ? ftDraftQuestions.map(q => (
                      <GradeCard key={q.id} question={q} value={null} onChange={() => {}} accent={ACCENT}
                        editable onQuestionChange={updated => updateFtDraftQuestion(q.id, updated)}
                        onRemove={() => removeFtQuestion(q.id)} canRemove={ftDraftQuestions.length > 1} />
                    ))
                  : ft_questions.map(q => (
                      <GradeCard key={q.id} question={q} accent={ACCENT}
                        value={ftGradeMap[q.id] ?? null}
                        onChange={g => setFtGradeMap(prev => ({ ...prev, [q.id]: g }))} />
                    ))}

                {!ftEditMode && ftAllAnswered && (() => {
                  const cfg = computeFtConfig(ftAnsweredGrades);
                  const sc2 = SLAB_CFG[cfg.track];
                  const total = ft_questions.reduce((a, q) => {
                    const g = ftGradeMap[q.id];
                    const rub = g ? q.rubric.find(r => r.grade === g) : undefined;
                    return a + (rub?.marks ?? 0);
                  }, 0);
                  const maxTotal = ft_questions.reduce((a, q) => a + Math.max(...q.rubric.map(r => r.marks)), 0);
                  return (
                    <>
                      <div style={{ ...card, gridColumn: "span 12",
                        border: `2px solid ${sc2.border}`, background: sc2.bg,
                        boxShadow: `0 0 0 4px ${sc2.glow}, 0 4px 14px rgba(0,0,0,0.04)` }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <div>
                            <div style={{ fontSize: 18, fontWeight: 800, color: sc2.color }}>{cfg.track}</div>
                            <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>{cfg.syllabusStrategy}</div>
                          </div>
                          <div style={{ background: sc2.border, color: "#fff",
                            padding: "6px 16px", borderRadius: 10, fontSize: 14, fontWeight: 800 }}>
                            {total}/{maxTotal}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
                          {[
                            { label: "Stick Type",        val: cfg.stickType },
                            { label: "Kick Pedal",        val: cfg.kickPedalTechnique },
                            { label: "Tempo Range",       val: cfg.tempoRange },
                            { label: "Groove Complexity", val: cfg.grooveComplexity },
                          ].map(({ label, val }) => (
                            <div key={label} style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.08)",
                              borderRadius: 10, padding: "7px 14px" }}>
                              <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: sc2.color, marginTop: 2 }}>{val}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      {renderSaveRow()}
                    </>
                  );
                })()}

                {!ftEditMode && (
                  <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-start" }}>
                    <button onClick={() => setStep(2)} style={btnSec}>← Back</button>
                  </div>
                )}
              </div>
            )}

            {/* JOYFUL TRACK */}
            {stream === "joyful-track" && (
              <div style={grid12} className="scr-grid">
                {isAdmin && (
                  <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {!jtEditMode ? (
                      <button type="button" onClick={() => { setJtDraftQuestions(jt_questions); setJtEditMode(true); }}
                        style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>✎ Edit Questions</button>
                    ) : (
                      <>
                        <button type="button" onClick={() => setJtDraftQuestions(qs => [...qs, {
                            id: genQuestionId("jt"), code: `JT-${String(qs.length + 1).padStart(2, "0")}`,
                            title: "New Question", sub: "", options: SENSORY_OPTIONS, optionDescs: {},
                          }])} style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>+ Add Question</button>
                        <button type="button" onClick={() => { setJtDraftQuestions(jt_questions); setJtEditMode(false); }}
                          disabled={jtBankSaving} style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>Cancel</button>
                        <button type="button" disabled={jtBankSaving}
                          onClick={async () => {
                            setJtBankSaving(true);
                            try {
                              await saveTrackQuestionBank("drums", "jtQuestions", jtDraftQuestions, user?.uid ?? "unknown");
                              setJtQuestions(jtDraftQuestions); setJtAnswers({}); setJtEditMode(false);
                            } finally { setJtBankSaving(false); }
                          }}
                          style={{ ...btnPrimary, padding: "7px 14px", fontSize: 12, opacity: jtBankSaving ? 0.6 : 1 }}>
                          {jtBankSaving ? "Saving…" : "💾 Save Questions"}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {jtEditMode
                  ? jtDraftQuestions.map(q => (
                      <TestCard key={q.id} question={q} value={null} onChange={() => {}} accent={ACCENT}
                        editable onQuestionChange={updated => setJtDraftQuestions(qs => qs.map(x => x.id === q.id ? updated : x))}
                        onRemove={() => setJtDraftQuestions(qs => qs.length > 1 ? qs.filter(x => x.id !== q.id) : qs)}
                        canRemove={jtDraftQuestions.length > 1} />
                    ))
                  : jt_questions.map(q => (
                      <TestCard key={q.id} question={q} accent={ACCENT}
                        value={jtAnswers[q.id] ?? null}
                        onChange={opt => setJtAnswers(prev => ({ ...prev, [q.id]: opt }))} />
                    ))}

                {!jtEditMode && (
                  <div style={{ ...card, gridColumn: "span 12" }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                      Recommended Config
                    </div>
                    {(() => {
                      const cfg = computeJtConfig(Object.values(jtAnswers));
                      const sc2 = SLAB_CFG[cfg.track];
                      return (
                        <>
                          <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 12,
                            background: sc2.bg, border: `1.5px solid ${sc2.border}` }}>
                            <div style={{ fontWeight: 800, fontSize: 16, color: sc2.color }}>{cfg.track}</div>
                            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{cfg.syllabusStrategy}</div>
                          </div>
                          <ConfigRows cfg={cfg} />
                        </>
                      );
                    })()}
                  </div>
                )}

                {!jtEditMode && renderSaveRow()}
                {!jtEditMode && (
                  <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-start" }}>
                    <button onClick={() => setStep(2)} style={btnSec}>← Back</button>
                  </div>
                )}
              </div>
            )}

            {/* CREATIVE TRACK */}
            {stream === "creative-track" && (
              <div style={grid12} className="scr-grid">
                {isAdmin && (
                  <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {!ctEditMode ? (
                      <button type="button" onClick={() => { setCtDraftQuestions(ct_questions); setCtEditMode(true); }}
                        style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>✎ Edit Questions</button>
                    ) : (
                      <>
                        <button type="button" onClick={() => setCtDraftQuestions(qs => [...qs, {
                            id: genQuestionId("ct"), code: `CT-${String(qs.length + 1).padStart(2, "0")}`,
                            title: "New Question", sub: "", options: SENSORY_OPTIONS, optionDescs: {},
                          }])} style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>+ Add Question</button>
                        <button type="button" onClick={() => { setCtDraftQuestions(ct_questions); setCtEditMode(false); }}
                          disabled={ctBankSaving} style={{ ...btnSec, padding: "7px 14px", fontSize: 12 }}>Cancel</button>
                        <button type="button" disabled={ctBankSaving}
                          onClick={async () => {
                            setCtBankSaving(true);
                            try {
                              await saveTrackQuestionBank("drums", "ctQuestions", ctDraftQuestions, user?.uid ?? "unknown");
                              setCtQuestions(ctDraftQuestions); setCtAnswers({}); setCtEditMode(false);
                            } finally { setCtBankSaving(false); }
                          }}
                          style={{ ...btnPrimary, padding: "7px 14px", fontSize: 12, opacity: ctBankSaving ? 0.6 : 1 }}>
                          {ctBankSaving ? "Saving…" : "💾 Save Questions"}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {ctEditMode
                  ? ctDraftQuestions.map(q => (
                      <TestCard key={q.id} question={q} value={null} onChange={() => {}} accent={ACCENT}
                        editable onQuestionChange={updated => setCtDraftQuestions(qs => qs.map(x => x.id === q.id ? updated : x))}
                        onRemove={() => setCtDraftQuestions(qs => qs.length > 1 ? qs.filter(x => x.id !== q.id) : qs)}
                        canRemove={ctDraftQuestions.length > 1} />
                    ))
                  : ct_questions.map(q => (
                      <TestCard key={q.id} question={q} accent={ACCENT}
                        value={ctAnswers[q.id] ?? null}
                        onChange={opt => setCtAnswers(prev => ({ ...prev, [q.id]: opt }))} />
                    ))}

                {ctEditMode ? null : <>
                <div style={{ ...card, gridColumn: "span 7" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Teacher Overrides
                  </div>

                  <div style={{ marginBottom: 18, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "#111" }}>Enable Metronome / Click Track</div>
                      <div style={{ fontSize: 12, color: "#9ca3af" }}>Only if the student shows no pulse sensitivity</div>
                    </div>
                    <div onClick={() => setCtMetronome(m => !m)}
                      style={{ width: 42, height: 24, borderRadius: 12, cursor: "pointer",
                        background: ct_metronomeEnabled ? ACCENT : "#e5e7eb", position: "relative",
                        transition: "background 0.2s" }}>
                      <div style={{ position: "absolute", top: 3, width: 18, height: 18, borderRadius: "50%",
                        background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", transition: "left 0.2s",
                        left: ct_metronomeEnabled ? 21 : 3 }} />
                    </div>
                  </div>

                  {ct_metronomeEnabled && (
                    <div style={{ marginBottom: 18 }}>
                      <label style={labelStyle}>Click Track BPM</label>
                      <input type="number" min={40} max={120} value={ct_metronomeBpm}
                        onChange={e => setCtBpm(Number(e.target.value))} style={inputStyle} />
                    </div>
                  )}

                  <div>
                    <label style={labelStyle}>Stick / Mallet Type</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      {(["Drumsticks", "Brushes", "Mallets"] as DrumConfig["stickType"][]).map(opt => {
                        const sel = ct_stickType === opt;
                        return (
                          <button key={opt} onClick={() => setCtStick(opt)}
                            style={{ flex: 1, padding: "9px 10px", borderRadius: 10, cursor: "pointer",
                              fontFamily: "inherit", border: `1.5px solid ${sel ? ACCENT : "#e5e7eb"}`,
                              background: sel ? `${ACCENT}14` : "#fafafa",
                              color: sel ? ACCENT : "#6b7280", fontSize: 12, fontWeight: sel ? 700 : 400 }}>
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div style={{ ...card, gridColumn: "span 5" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 14 }}>
                    Adaptive Config
                  </div>
                  {(() => {
                    const cfg = ctConfig(ct_metronomeEnabled, ct_metronomeBpm, ct_stickType);
                    const sc2 = SLAB_CFG[cfg.track];
                    return (
                      <>
                        <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 12,
                          background: sc2.bg, border: `1.5px solid ${sc2.border}` }}>
                          <div style={{ fontWeight: 800, fontSize: 16, color: sc2.color }}>{cfg.track}</div>
                          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{cfg.syllabusStrategy}</div>
                        </div>
                        <ConfigRows cfg={cfg} />
                      </>
                    );
                  })()}
                </div>

                {renderSaveRow()}
                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-start" }}>
                  <button onClick={() => setStep(2)} style={btnSec}>← Back</button>
                </div>
                </>}
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}
