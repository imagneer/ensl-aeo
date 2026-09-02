// app/api/dashboard-status/route.ts

import { NextResponse } from 'next/server';
import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchTargetBrands,
  fetchDiagnosesForBrand,
  fetchLastSuccessfulSnapshotAt,
} from '@/lib/supabase';
import { todayKST } from '@/lib/aggregator';

/**
 * 상단바(Day21, "진단 N일차 · 7일 중" / "HH:MM 기준 업데이트")용 API 라우트.
 *
 * ⚠️ layout.tsx(공통 topbar가 사는 곳)는 Next.js 구조상 searchParams를
 * 못 읽는다(page.tsx만 읽을 수 있음) — 그래서 ?brand=가 바뀔 때마다
 * 반응해야 하는 이 정보는 클라이언트 컴포넌트(DashboardTopbar)가
 * useSearchParams로 brand를 읽어 이 라우트를 호출하는 방식으로 구현했다
 * (Sidebar.tsx가 이미 쓰고 있는 것과 같은 패턴 — 다만 Sidebar는 서버가
 * 미리 내려준 목록을 클라이언트에서 고르기만 하고, 여기는 브랜드별로
 * 매번 새로 조회해야 해서 API 라우트가 추가로 필요했다).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const brandId = searchParams.get('brand');
  if (!brandId) {
    return NextResponse.json({ error: 'brand 파라미터가 필요합니다.' }, { status: 400 });
  }

  const sessionClient = await createServerSupabaseClient();
  const account = await fetchCurrentAccount(sessionClient);
  if (!account) {
    return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  // 이 계정 소속 브랜드인지 확인 — RLS가 이미 막아주지만(diagnoses_select_own_account),
  // 400/401과 구분되는 "권한 없음"을 명확히 응답하려고 한 번 더 확인한다.
  const brands = await fetchTargetBrands(account.id, sessionClient);
  if (!brands.some((b) => b.id === brandId)) {
    return NextResponse.json({ error: '이 브랜드에 접근할 권한이 없습니다.' }, { status: 403 });
  }

  const diagnoses = await fetchDiagnosesForBrand(brandId, sessionClient);
  if (diagnoses.length === 0) {
    return NextResponse.json({ dayLabel: null, updatedLabel: null });
  }

  const latest = diagnoses[diagnoses.length - 1];
  const start = new Date(`${latest.startedAt}T00:00:00Z`);
  const todayKstStr = todayKST();
  const now = new Date(`${todayKstStr}T00:00:00Z`);
  const daysElapsed = Math.round((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const dayCount = Math.min(Math.max(daysElapsed, 1), 7);
  const dayLabel = `진단 ${dayCount}일차 · 7일 중`;

  const lastSuccessAt = await fetchLastSuccessfulSnapshotAt(brandId, sessionClient);
  const updatedLabel = lastSuccessAt
    ? `${new Date(lastSuccessAt).toLocaleTimeString('ko-KR', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })} 기준 업데이트`
    : null;

  return NextResponse.json({ dayLabel, updatedLabel });
}
