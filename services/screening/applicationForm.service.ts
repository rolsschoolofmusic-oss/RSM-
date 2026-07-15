import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";

export type ApplicationFieldType = "text" | "textarea" | "single-select" | "multi-select" | "scale";

export interface ApplicationQuestion {
  id:        string;
  key:       string;
  label:     string;
  type:      ApplicationFieldType;
  options?:  string[];
  scaleMin?: number;
  scaleMax?: number;
  required:  boolean;
  /** True for the original seeded fields — their `key` is wired into the printed
   *  admission card and detail panel, so it can't be renamed, though the field
   *  itself can still be relabeled, reordered, or removed. */
  locked?:   boolean;
  /** When set, this question is only shown once the referenced question's answer
   *  matches one of `equals` (string compare; for multi-select, any overlap counts). */
  showIf?: { key: string; equals: string[] };
}

export function defaultApplicationQuestions(): ApplicationQuestion[] {
  return [
    {
      id: "aq-purpose", key: "purposeOfLearning", label: "Purpose of Learning",
      type: "single-select", required: false, locked: true,
      options: ["Formal Music Learning", "Skill Development", "Entertainment"],
    },
    {
      id: "aq-instruments-learn", key: "instrumentsToLearn", label: "Musical Instrument to Learn",
      type: "multi-select", required: false, locked: true,
      options: ["Piano", "Keyboard", "Guitar", "Drums", "Violin", "Vocal"],
    },
    {
      id: "aq-prev-experience", key: "previousExperience", label: "Previous Experience in Music",
      type: "single-select", required: false, locked: true,
      options: ["Well-Trained", "Average", "No Previous Experience"],
    },
    {
      id: "aq-instruments-played", key: "instrumentsPlayed", label: "Instruments You Already Play",
      type: "multi-select", required: false, locked: true,
      options: ["Guitar", "Drums", "Keyboard", "None of the Above"],
    },
    {
      id: "aq-musical-skill", key: "musicalSkill", label: "Explain Your Musical Skill",
      type: "single-select", required: false, locked: true,
      options: ["Excellent", "Average", "Poor"],
    },
    {
      id: "aq-how-heard", key: "howHeardAboutUs", label: "How Do You Know About ROL's School Of Music?",
      type: "single-select", required: false, locked: true,
      options: ["Google", "Instagram", "Family or Friends", "Demo Class"],
    },
    {
      id: "aq-initial-experience", key: "initialExperience", label: "How Do You Describe Your Initial Experience With Us?",
      type: "scale", required: false, locked: true, scaleMin: 1, scaleMax: 10,
    },
    {
      id: "aq-parent-partner", key: "parentPartnerProgram", label: "Would You Like to Participate in Our Parent Partner Program?",
      type: "single-select", required: false, locked: true,
      options: ["Yes", "No", "Want to Know More"],
    },
  ];
}

export async function getApplicationForm(): Promise<ApplicationQuestion[] | null> {
  const snap = await getDoc(doc(db, "applicationFormTemplates", "default"));
  if (!snap.exists()) return null;
  const data = snap.data() as { questions?: ApplicationQuestion[] };
  return data.questions ?? null;
}

export async function saveApplicationForm(
  questions: ApplicationQuestion[],
  uid: string,
): Promise<void> {
  await setDoc(doc(db, "applicationFormTemplates", "default"), {
    questions,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });
}

export function genFieldKey(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
  return `custom_${slug}_${Date.now().toString(36)}`;
}

export function genFieldId(): string {
  return `aq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function formatAnswerForDisplay(question: ApplicationQuestion, value: unknown): string {
  if (value == null) return "—";
  if (question.type === "multi-select") {
    return Array.isArray(value) && value.length > 0 ? value.map(String).join(", ") : "—";
  }
  if (question.type === "scale") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && value !== "" ? `${n} / ${question.scaleMax ?? 10}` : "—";
  }
  const s = typeof value === "string" ? value : String(value);
  return s.trim().length > 0 ? s : "—";
}
