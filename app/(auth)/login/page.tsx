import { sendMagicLink } from './actions';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;

  return (
    <div className="auth-card">
      <div className="logo-row">
        <div className="logo-mark" />
        <span className="logo-text">ensl</span>
      </div>

      {sent ? (
        <div className="sent">
          <h1>메일을 확인해주세요</h1>
          <p className="sub">
            <span className="email">{sent}</span>로 로그인 링크를 보냈어요. 메일함에서
            링크를 눌러 로그인을 완료해주세요.
          </p>
        </div>
      ) : (
        <>
          <h1>로그인</h1>
          <p className="sub">이메일 주소를 입력하면 로그인 링크를 보내드려요.</p>
          <form action={sendMagicLink}>
            <input
              type="email"
              name="email"
              required
              placeholder="이메일 주소"
              autoFocus
            />
            {error && <p className="error">{error}</p>}
            <button type="submit">로그인 링크 받기</button>
          </form>
        </>
      )}
    </div>
  );
}
