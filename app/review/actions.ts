'use server';

// /review 화면(사람 검증 인프라, 작업지시서_사람검증_인프라_2026-09-08 §3)의
// 승인/반려 액션. owner/admin만 부를 수 있다 — 페이지 자체도 404로 막혀
// 있지만, 서버 액션은 URL을 몰라도 직접 호출될 수 있어서 여기서도 다시 확인한다.

import { revalidatePath } from 'next/cache';
import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchReviewItemById,
  approveReviewItem,
  type ReviewReasonCategory,
} from '@/lib/supabase';
import { handleReviewItemRejection } from '@/lib/brand-one-liner';

async function requireOwner(): Promise<{ id: string } | null> {
  const sessionClient = await createServerSupabaseClient();
  const account = await fetchCurrentAccount(sessionClient);
  if (!account || (account.role !== 'owner' && account.role !== 'admin')) return null;

  const {
    data: { user },
  } = await sessionClient.auth.getUser();
  return user ? { id: user.id } : null;
}

export async function approveAction(formData: FormData): Promise<void> {
  const reviewer = await requireOwner();
  if (!reviewer) throw new Error('권한이 없습니다.');

  const id = String(formData.get('id') ?? '');
  const finalText = String(formData.get('finalText') ?? '').trim();
  if (!id || !finalText) throw new Error('필수 값이 비어 있습니다.');

  const item = await fetchReviewItemById(id);
  if (!item) throw new Error('항목을 찾을 수 없습니다.');

  await approveReviewItem(id, finalText, finalText !== item.aiText, reviewer.id);
  revalidatePath('/review');
  revalidatePath('/brand-awareness');
}

const REASON_CATEGORIES: ReviewReasonCategory[] = ['과잉해석', '사실불일치', '표현누락', '문체톤', '기타'];

export async function rejectAction(formData: FormData): Promise<void> {
  const reviewer = await requireOwner();
  if (!reviewer) throw new Error('권한이 없습니다.');

  const id = String(formData.get('id') ?? '');
  const reasonInput = String(formData.get('reasonCategory') ?? '');
  const reviewerNote = String(formData.get('reviewerNote') ?? '').trim() || null;
  if (!id || !REASON_CATEGORIES.includes(reasonInput as ReviewReasonCategory)) {
    throw new Error('필수 값이 비어 있거나 잘못됐습니다.');
  }

  await handleReviewItemRejection(id, reasonInput as ReviewReasonCategory, reviewerNote, reviewer.id);
  revalidatePath('/review');
  revalidatePath('/brand-awareness');
}
