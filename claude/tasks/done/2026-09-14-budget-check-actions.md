# 작업 지시서 — 2026-09-14 예산 점검 후속 조치 (3건)

배경: 매주 자동 예산 점검 루틴(claude/budget-watch-log.md)에서 발견된 이상 3건.
코드를 직접 안 봐서 나온 추정 부분은 각 항목에 "확인 필요"로 명시함.

---

## 1. [긴급, 마감 9/27] Perplexity API 마이그레이션

**배경**
엔슬 AEO MVP의 Perplexity 데이터 수집이 쓰고 있는 것으로 추정되는 API(Sonar
Chat Completions, `POST /chat/completions` 방식)가 9월 27일부로 지원 종료됨.
이후엔 요청이 실패할 수 있어 Perplexity 관련 크론(수집 작업)이 멈출 위험 있음.

**할 일**
1. 레포에서 Perplexity 어댑터 코드 찾아서 지금 어떤 엔드포인트를 호출 중인지
   먼저 확인 (`/chat/completions` 쓰고 있는지 — 이미 Agent API면 이 작업 자체가
   불필요)
2. 옛날 방식이면 → 새 엔드포인트(`POST /v1/agent`)로 전환. 요청/응답 스키마가
   다름(예전=단순 chat completion 구조, 신규=web_search 등 도구를 쓰는 Agent
   구조) → 파싱 로직도 같이 점검
3. 공식 마이그레이션 가이드 참고: console.perplexity.ai 대시보드 배너 링크 /
   docs.perplexity.ai
4. 전환 후 스모크 테스트: 실제 브랜드 쿼리 1건 날려서 응답 파싱까지 정상 확인
5. 완료 후 확인: `mentions`/`snapshots` 테이블에 저장되는 데이터 구조(노출 여부,
   순위, 출처 등)가 전환 전후로 동일하게 나오는지 — 파싱이 깨지면 데이터가
   조용히 비거나 틀리게 쌓일 수 있음

**데드라인**: 9/27(일) 전 필수, 여유 두고 9/24 목표

**확인 안 된 부분**: 지금 코드가 정말 옛날 엔드포인트를 쓰는지는 대시보드
배너만 보고 추정한 것. 이미 새 API면 이 티켓은 종료.

---

## 2. Anthropic(Claude) 비용 초과 원인 확인 — Sonnet 5 지속 사용

**배경**
9월 14일 만에 이미 $25.80 지출(월 예산 $25 초과). 이 페이스면 월말 ~$55
(예산 2.2배) 예상. 원래는 Claude Haiku 4.5만 쓰는 걸로 설계됐는데, 9/4부터
`Claude Sonnet 5`가 나타나기 시작해서 9/4~5, 9/8~9, 9/10에 반복적으로 계속
호출됨(1회성 아님, 확인됨). Vercel `ensl-aeo` 프로젝트에 9/4 즈음 "fix: usage
로깅 실제 API 재검증 + dry-run 추정 토큰값 보정" 배포 이력이 있는데 시점이
겹침(정황상 연관 가능성 — 코드 미확인이라 추측 단계).

**할 일**
1. Anthropic 어댑터 코드에서 모델 지정 부분 확인 — Haiku 4.5로 고정돼 있는지,
   아니면 어떤 조건에서 Sonnet 5로 폴백/전환되는 로직이 있는지 확인
2. 9/4 "usage 로깅 재검증" 커밋 내용 직접 확인 — 이 커밋이 모델 지정 코드를
   건드렸는지, 아니면 정말 재검증용 일회성 스크립트였는데 뭔가 남아서 계속
   도는 건지 원인 특정
3. 원인 특정 후 두 가지 중 하나로 결론:
   - **의도된 변경이 아니면**: Haiku 4.5로 되돌리기
   - **의도된 변경이면**(예: 응답 품질 때문에 Sonnet 5가 필요했다면): 예산표를
     실측 기준(~$55/월)으로 갱신하고 루아한테 공유 — 계속 이 비용으로 갈지
     판단은 루아 몫

**데드라인**: 특별히 정해진 외부 마감은 없지만, 매주 예산이 계속 쌓이는
항목이라 다음 점검(9/21) 전까지 원인 파악 완료 권장

**확인 안 된 부분**: 배포 시점과 모델 전환 시점이 겹친다는 건 정황 증거일
뿐, 실제로 그 커밋이 원인인지는 코드를 봐야 확정됨.

---

## 3. Vercel Cron Jobs 2개 신규 추가 확인

**배경**
Cron Jobs가 지난주(9/7) 점검 시 5개였는데 이번 주(9/14) 7개로 늘어남. 원래
PRD 계획(collect-and-save×3 + aggregate-daily + check-alerts = 5개)에 없던
2개가 새로 생김:
- `/api/complete-diagnoses` (16:30 UTC)
- `/api/compute-placement-narrative` (16:50 UTC)

**할 일**
1. 배포 이력/커밋 로그에서 이 두 크론이 언제, 어떤 작업(PR/커밋)으로
   추가됐는지 확인
2. 의도된 기능 확장인지 확인 (이름으로 봐서 "진단 완료 처리"와 "노출 서사
   계산" 관련 기능으로 추정되는데, 확정은 아님)
3. 의도된 거면:
   - 추가 API 호출(OpenAI/Anthropic/SerpApi 등)이 발생하는 로직인지 확인하고,
     그렇다면 위 1·2번 비용 항목에 얼마나 기여하는지 가늠
   - PRD 문서(`docs/ensl-aeo-mvp-prd.md`)에 이 크론들도 반영해서 계획과 실제가
     다시 일치하도록 업데이트
4. 의도치 않게 남아있는 테스트/실험용 크론이면 제거

**데드라인**: 급하지 않음, 다음 점검(9/21) 전까지 확인

**확인 안 된 부분**: 이 크론들이 실제로 외부 API를 호출하는지, 아니면 DB
내부 연산만 하는지는 코드를 안 봐서 모름 — 이름만 보고 추정한 것.

---

## 완료 시
각 항목 처리 후, 이 파일 맨 아래에 "## 처리 결과" 섹션을 추가해서 원인
확인 결과 + 조치 내용을 짧게 남길 것. 세 건 모두 끝나면 이 파일을
`claude/tasks/done/`으로 옮길 것.

---

## 처리 결과 (2026-09-14, 코난)

### 1. Perplexity API 마이그레이션 — **완료**

확인된 사실: 지금 코드([lib/adapters/perplexity.ts](../../lib/adapters/perplexity.ts))는
정말 구 엔드포인트(`/chat/completions`, `sonar`)를 씀. 새 엔드포인트는
`POST https://api.perplexity.ai/v1/agent`.

실제 API에 테스트 콜을 4번 날려서(문서만 믿지 않고 실측, CLAUDE.md 원칙대로)
`model=perplexity/sonar` 고정 시 검색은 정상 수행되지만 답변 본문에 `[n]`
인용 마커가 4/4 전부 0개인 것을 확인 — "본 것/사용한 것" 구분(Day8 결정)의
근거였던 인용 마커가 이 모델/API 조합에서는 구조적으로 안 나온다는 뜻.
루아 확인 후 **A안 확정**: `model=perplexity/sonar` 고정 유지, "사용한 것"은
Perplexity에 한해 `citation_confidence='unavailable'`이라는 명시적 값으로
저장(null과 구분), 대시보드에 "인용 출처 미제공" 배지, PRD·Day8 결정 기록에
반영.

**구현 완료 내용**:
- 어댑터 전체 재작성(`lib/adapters/perplexity.ts`) — 새 엔드포인트·요청
  스키마·응답 파싱, `citationTrackingUnavailable` 플래그 추가
- `lib/types.ts`(AdapterResponse), `lib/citation-linker.ts`(CitationConfidence
  타입에 `'unavailable'` 추가), `lib/collector.ts`(플래그 감지 시 판정 함수
  건너뛰고 바로 unavailable 처리)
- DB: `mentions.citation_confidence` CHECK 제약에 `unavailable` 추가
  (`docs/perplexity-citation-unavailable-schema.sql`, 프로덕션 적용 완료)
- `lib/aggregator.ts`의 M/S/C 뱃지용 `hasCitation`을 `boolean|null`로 확장
  (Perplexity처럼 엔진 전체가 unavailable이면 null — hasSource와 같은 패턴).
  ⚠️ M/S/C 뱃지 자체는 아직 어느 화면에도 렌더링 UI가 없어(데이터 레이어만
  존재) 이 부분은 화면으로 검증은 못 함
- 질문상세 화면("출처 분석 카드")에 "인용 출처 미제공" 배지 추가
  (`app/(dashboard)/query/[id]/page.tsx`, `components/QueryEvidenceList.tsx`)
- 문서 반영: `docs/ensl-aeo-mvp-prd.md`(측정 정확성 리스크),
  `docs/claude_day8-decision-citation-linking.md`("2026-09-14 갱신" 절 +
  남은 부채 11번 완료 처리)
- 검증: `npx tsc --noEmit` 클린 통과, 신규 코드 eslint 에러 없음, 실제 API
  응답 fixture로 파싱 로직 재검증(retrievedSources 15건 정상 추출 확인)

**후속(코드 아님, 지켜볼 것)**: Perplexity Agent API가 신생 API라 향후
인용 마커 지원이 추가될 수 있음 — 수개월 뒤 재확인 권장(Day8 문서에 기록).

### 2. Anthropic Sonnet 5 비용 — **완료**

원인 특정 완료(회귀 아님, 8/17 결정대로 설계된 진단종료 비용이 첫 진단
완료로 실현된 것 + mention-feature-roles.ts 개발 중 실측 검증 비용 추정 혼재).
실측 데이터·per-진단 비용 추정·갱신된 월 예산을 `claude/budget-watch-log.md`
2026-09-14 항목에 기록함. 루아 결정: Sonnet 5 유지, Haiku로 되돌리지 않음.
⚠️ 정정: 작업지시서의 "9/10 반복 호출" 관측은 실측 결과 부정확했음(9/10
Sonnet 지출은 $0) — budget-watch-log.md에 정정 기록함.

### 3. Vercel Cron 2개 — **완료**

둘 다 의도된 분리(9/8 `complete-diagnoses`, 9/10 `compute-placement-narrative`,
둘 다 타임아웃 회피 목적)였음을 코드 주석·git 커밋으로 확인. 테스트/실험용
잔재 아님, 제거 불필요. 두 크론 다 `docs/day4-decision-schedule.md`에 아직
빠져있던 것을 이번에 추가해서 로드맵 문서와 실제를 일치시킴
(`compute-placement-narrative`는 이번에 처음 기록됨). 외부 API 호출 여부도
확인: Haiku만 쓰고 Sonnet과 무관해 비용 부담 작음.

**세 건 모두 완료 — `claude/tasks/done/`으로 이동.**
