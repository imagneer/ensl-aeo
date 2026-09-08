import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase';

/**
 * 루트("/") — 로그인 여부만 보고 보낼 곳으로 보낸다.
 *
 * 2026-09-08 수정: 여기엔 Day 8 시절 프로토타입 대시보드(엔진 카드 그리드)가
 * 그대로 남아 있었다. 그게 `fetchTargetBrands()`를 세션 없이(=anon 클라이언트로)
 * 부르는 바람에 RLS에 막혀 항상 빈 배열이 왔고, 그래서 **로그인하든 안 하든
 * 누구에게나 "등록된 브랜드가 없습니다"만 보이는 상태**였다. 도메인
 * (www.oddfish.co.kr)을 붙이고 나서야 "첫 화면에 아무것도 없다"로 드러남.
 *
 * 로그인 안 한 방문자는 로그인 화면으로, 로그인한 사람은 대시보드로 보낸다.
 * 계정(account_members)이 없는 경우까지 여기서 처리하면 로그인 화면과
 * 무한 왕복이 될 수 있어서, 그 판단은 대시보드 화면 쪽에 맡긴다
 * (거기서 "계정 정보를 확인할 수 없습니다" 안내를 이미 하고 있음).
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const sessionClient = await createServerSupabaseClient();
  const {
    data: { user },
  } = await sessionClient.auth.getUser();

  redirect(user ? '/brand-awareness' : '/login');
}
