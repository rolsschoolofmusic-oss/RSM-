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
