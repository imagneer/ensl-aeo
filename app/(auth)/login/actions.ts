'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase';

export async function sendMagicLink(formData: FormData) {
  const email = formData.get('email');

  if (typeof email !== 'string' || !email.trim()) {
    redirect('/login?error=' + encodeURIComponent('이메일 주소를 입력해주세요.'));
  }

  const supabase = await createServerSupabaseClient();
  const origin = (await headers()).get('origin');

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    console.error('매직링크 발송 실패:', error);
    redirect(
      '/login?error=' +
        encodeURIComponent('로그인 링크 발송에 실패했어요. 잠시 후 다시 시도해주세요.')
    );
  }

  redirect('/login?sent=' + encodeURIComponent(email));
}
