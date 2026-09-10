// /review — 사람 검증 인프라 승인 화면 (작업지시서_사람검증_인프라_2026-09-08 §3)
// owner/admin 전용, 내부 도구. 9/11 데모 범위 밖(디자인 매니페스토 7원칙
// 적용 대상 아님) — 루아가 "사인/반려/수정 제안"만 하고 끝나면 되는 화면.

import { notFound } from 'next/navigation';
import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchPendingReviewItems,
  fetchReviewItemHistory,
  type PendingReviewItemWithBrand,
  type ReviewReasonCategory,
} from '@/lib/supabase';
import { MAX_GENERATION_ROUNDS } from '@/lib/diagnosis-display-state';
import { approveAction, rejectAction } from './actions';

const ITEM_TYPE_LABEL: Record<string, string> = {
  brand_one_liner: '브랜드 한 줄',
  brand_one_liner_conflict: '잘못된 인지',
  feature_conflict_summary: '서로 다르게 설명하는 지점',
  narrative_lesson: '엔슬의 제안',
};

const REASON_CATEGORIES: ReviewReasonCategory[] = ['과잉해석', '사실불일치', '표현누락', '문체톤', '기타'];

export default async function ReviewPage() {
  const sessionClient = await createServerSupabaseClient();
  const account = await fetchCurrentAccount(sessionClient);
  if (!account || (account.role !== 'owner' && account.role !== 'admin')) {
    notFound();
  }

  const [pending, history] = await Promise.all([fetchPendingReviewItems(), fetchReviewItemHistory(100)]);

  // "수동 처리 필요"(회차 상한 초과로 자동 재생성이 멈춘 항목)를 맨 위로 고정한다(§3-1)
  // — 사람이 직접 고쳐 써야만 풀리는 항목이라, 일반 대기 항목에 섞여 묻히면 안 된다.
  const sorted = [...pending].sort((a, b) => {
    const aManual = a.status === 'rejected' ? 0 : 1;
    const bManual = b.status === 'rejected' ? 0 : 1;
    return aManual - bManual;
  });

  const byBrand = new Map<string, PendingReviewItemWithBrand[]>();
  for (const item of sorted) {
    const list = byBrand.get(item.brandName) ?? [];
    list.push(item);
    byBrand.set(item.brandName, list);
  }
  const manualCount = pending.filter((i) => i.status === 'rejected').length;

  const rejectedCounts: Record<string, number> = {};
  for (const h of history) {
    if (h.status === 'rejected' && h.reasonCategory) {
      rejectedCounts[h.reasonCategory] = (rejectedCounts[h.reasonCategory] ?? 0) + 1;
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px', fontSize: 14, lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>검토 대기</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 24 }}>
        AI가 쓴 해석·제안 문장을 승인/수정/반려합니다. 대기 중 {pending.length}건
        {manualCount > 0 && ` (그중 수동 처리 필요 ${manualCount}건)`}.
      </p>

      {pending.length === 0 && <p style={{ color: '#888' }}>대기 중인 항목이 없습니다.</p>}

      {Array.from(byBrand.entries()).map(([brandName, items]) => (
        <section key={brandName} style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>{brandName}</h2>
          {items.map((item) => (
            <ReviewItemCard key={item.id} item={item} />
          ))}
        </section>
      ))}

      <details style={{ marginTop: 40 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>이력 ({history.length}건)</summary>
        <div style={{ marginTop: 12 }}>
          <p style={{ color: '#666', marginBottom: 12 }}>
            반려 사유별 집계: {REASON_CATEGORIES.map((r) => `${r} ${rejectedCounts[r] ?? 0}`).join(' · ')}
          </p>
          <ul style={{ paddingLeft: 18 }}>
            {history.map((h) => (
              <li key={h.id} style={{ marginBottom: 8 }}>
                [{h.status === 'approved' ? '승인' : '반려'}] {ITEM_TYPE_LABEL[h.itemType] ?? h.itemType} ·{' '}
                {h.brandName} — {h.finalText ?? h.aiText}
                {h.status === 'rejected' && h.reasonCategory && ` (사유: ${h.reasonCategory}${h.reviewerNote ? ` — ${h.reviewerNote}` : ''})`}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

function ReviewItemCard({ item }: { item: PendingReviewItemWithBrand }) {
  return (
    <div
      style={{
        border: item.status === 'rejected' ? '1px solid #d88' : '1px solid #ddd',
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
      }}
    >
      <p style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
        {ITEM_TYPE_LABEL[item.itemType] ?? item.itemType}
        {/* §3-1: pending인데 2회차 이상이면 "N차 · 반려 사유: [분류]" —
            직전 회차가 왜 반려됐는지 보여줘야 검토자가 맥락을 알고 판단함 */}
        {item.status === 'pending' && item.generationRound > 1 && (
          <> · {item.generationRound}차{item.previousReasonCategory && ` · 반려 사유: ${item.previousReasonCategory}${item.previousReviewerNote ? ` — ${item.previousReviewerNote}` : ''}`}</>
        )}
        {!item.autoRegeneratable && ' · 수동 수정 전용'}
        {item.status === 'rejected' && (
          <span style={{ color: '#b44', fontWeight: 600 }}> · 수동 처리 필요</span>
        )}
      </p>
      {item.status === 'rejected' && (
        <p style={{ fontSize: 12, color: '#b44', marginBottom: 8 }}>
          자동 재생성 {MAX_GENERATION_ROUNDS}회를 다 썼거나 재생성이 불가능한 항목이에요. 아래 &quot;수정 후
          승인&quot;으로 직접 고쳐 써야 클라이언트에게 노출됩니다.
          {item.reasonCategory && ` (마지막 반려 사유: ${item.reasonCategory}${item.reviewerNote ? ` — ${item.reviewerNote}` : ''})`}
        </p>
      )}
      <p style={{ fontSize: 15, marginBottom: 12 }}>{item.aiText}</p>

      {item.evidence != null && (
        <details style={{ marginBottom: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#888' }}>근거 보기</summary>
          <pre
            style={{
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              background: '#f7f7f7',
              padding: 8,
              borderRadius: 4,
              marginTop: 4,
            }}
          >
            {JSON.stringify(item.evidence, null, 2)}
          </pre>
        </details>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <form action={approveAction}>
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="finalText" value={item.aiText} />
          <button type="submit">승인</button>
        </form>

        <details>
          <summary style={{ cursor: 'pointer' }}>수정 후 승인</summary>
          <form action={approveAction} style={{ marginTop: 8 }}>
            <input type="hidden" name="id" value={item.id} />
            <textarea
              name="finalText"
              defaultValue={item.aiText}
              rows={2}
              style={{ width: '100%', marginBottom: 8, fontFamily: 'inherit', fontSize: 13 }}
            />
            <button type="submit">수정 내용으로 승인</button>
          </form>
        </details>

        {/* 이미 "수동 처리 필요"로 넘어간 항목은 다시 반려해봤자 재생성이 안 돌아서
            상태가 그대로다 — 혼란만 주므로 반려 버튼 자체를 숨긴다(§3-1). */}
        <details hidden={item.status === 'rejected'}>
          <summary style={{ cursor: 'pointer' }}>반려</summary>
          <form action={rejectAction} style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="hidden" name="id" value={item.id} />
            <select name="reasonCategory" required defaultValue="">
              <option value="" disabled>
                사유 선택
              </option>
              {REASON_CATEGORIES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <input type="text" name="reviewerNote" placeholder="메모(선택)" style={{ fontSize: 13 }} />
            <button type="submit">반려</button>
          </form>
          {!item.autoRegeneratable && (
            <p style={{ fontSize: 11, color: '#b44', marginTop: 4 }}>
              ⚠️ 이 문장은 고정 템플릿이라 반려해도 자동으로 다시 쓰지 않습니다 — 반려 후 위 &quot;수정 후 승인&quot;으로 직접
              고쳐주세요.
            </p>
          )}
          {item.autoRegeneratable && item.generationRound >= 3 && (
            <p style={{ fontSize: 11, color: '#b44', marginTop: 4 }}>
              ⚠️ 이미 3차까지 갔습니다 — 반려하면 더 재생성하지 않고 수동 처리로 넘어갑니다.
            </p>
          )}
        </details>
      </div>
    </div>
  );
}
