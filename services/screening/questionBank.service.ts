import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";

export type QuestionGrade = "High" | "Medium" | "Low";

export interface QuestionRubricEntry {
  grade: QuestionGrade;
  desc:  string;
  marks: number;
}

export interface FastTrackQuestion {
  id:     string;
  code:   string;
  title:  string;
  sub:    string;
  rubric: [QuestionRubricEntry, QuestionRubricEntry, QuestionRubricEntry];
}

export type ScreeningInstrument = "guitar" | "keyboard" | "drums";

export async function getQuestionBank(
  instrument: ScreeningInstrument,
): Promise<FastTrackQuestion[] | null> {
  const snap = await getDoc(doc(db, "screeningQuestionBanks", instrument));
  if (!snap.exists()) return null;
  const data = snap.data() as { fastTrackQuestions?: FastTrackQuestion[] };
  return data.fastTrackQuestions ?? null;
}

export async function saveQuestionBank(
  instrument: ScreeningInstrument,
  questions:  FastTrackQuestion[],
  uid:        string,
): Promise<void> {
  await setDoc(doc(db, "screeningQuestionBanks", instrument), {
    fastTrackQuestions: questions,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });
}

export function genQuestionId(prefix: string): string {
  return `${prefix.toLowerCase()}-${Date.now().toString(36)}`;
}

// ─── Marks distribution ─────────────────────────────────────────────────────
// Fast Track's total possible score is fixed regardless of how many questions
// exist — each question's High/Medium/Low marks are scaled so the per-question
// maxes always sum to this total, keeping the 5:3:1 High:Medium:Low ratio.
export const FAST_TRACK_TOTAL_MARKS = 15;

const GRADE_WEIGHT: Record<QuestionGrade, number> = { High: 1, Medium: 0.6, Low: 0.2 };

export function redistributeMarks(questions: FastTrackQuestion[]): FastTrackQuestion[] {
  if (questions.length === 0) return questions;
  const perQuestion = FAST_TRACK_TOTAL_MARKS / questions.length;
  return questions.map(q => ({
    ...q,
    rubric: q.rubric.map(r => ({
      ...r,
      marks: Math.round(perQuestion * GRADE_WEIGHT[r.grade] * 10) / 10,
    })) as FastTrackQuestion["rubric"],
  }));
}
