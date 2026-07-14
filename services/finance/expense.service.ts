import {
  collection,
  doc,
  addDoc,
  getDocs,
  getDocFromServer,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type { Expense, CreateExpenseInput, EditableExpenseInput } from "@/types/finance";
import { logAction } from "@/services/audit/audit.service";

const EXPENSES = "expenses";

export async function createExpense(
  data: CreateExpenseInput,
  initiatorId: string,
  initiatorRole: string,
): Promise<Expense> {
  const ref = await addDoc(collection(db, EXPENSES), {
    date:      data.date,
    category:  data.category,
    amount:    data.amount,
    paidVia:   data.paidVia,
    note:      data.note ?? null,
    loggedBy:  data.loggedBy,
    createdAt: serverTimestamp(),
  });

  const snap = await getDocFromServer(ref);
  if (!snap.exists()) {
    throw new Error("EXPENSE_CREATE_FAILED: document not found after write");
  }

  await logAction({
    action: "EXPENSE_LOGGED",
    initiatorId,
    initiatorRole: initiatorRole as import("@/types").Role,
    approverId: null,
    approverRole: null,
    reason: null,
    metadata: { expenseId: ref.id, amount: data.amount, category: data.category },
  });

  return { id: snap.id, ...snap.data() } as Expense;
}

export async function getExpenses(): Promise<Expense[]> {
  const snap = await getDocs(collection(db, EXPENSES));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Expense);
}

export async function updateExpense(
  expenseId: string,
  data: EditableExpenseInput,
): Promise<void> {
  await updateDoc(doc(db, EXPENSES, expenseId), {
    date:     data.date,
    category: data.category,
    amount:   data.amount,
    paidVia:  data.paidVia,
    note:     data.note ?? null,
  });
}

export async function deleteExpense(
  expenseId: string,
  initiatorId: string,
  initiatorRole: string,
): Promise<void> {
  await deleteDoc(doc(db, EXPENSES, expenseId));

  await logAction({
    action: "EXPENSE_DELETED",
    initiatorId,
    initiatorRole: initiatorRole as import("@/types").Role,
    approverId: null,
    approverRole: null,
    reason: null,
    metadata: { expenseId },
  });
}
