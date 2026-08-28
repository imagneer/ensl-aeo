# Ensl AEO MVP — Day 9 결정 기록: 집계 로직 (aggregated_metrics)

**결정일:** 2026-08-17
**상태:** 확정 (구현·실측 검증 완료)

---

## 한 줄 요약

`snapshots`·`mentions`의 개별 관측치를 묶어서, **타겟 브랜드 1행 + 경쟁사는 jsonb 요약**
형태로 `aggregated_metrics`에 저장하는 로직을 만들고, 실제 데이터로 검산까지 마쳤다.

---

## 확정된 판정 규칙

### 규칙 A — 한 행이 대표하는 범위

(쿼리, 엔진, 기간, aggregation_level) 조합마다 그 쿼리의 타겟 브랜드
(`queries.brand_id`) 기준 1행만 만든다. 같은 기간 다른 등록 브랜드들의 노출률은
`competitor_data`(jsonb)에 요약해서 같은 행에 넣는다.

- **왜 이렇게:** 스키마가 애초에 `competitor_data` jsonb 칸을 갖고 있어서, Day 4
  설계 의도(타겟 중심 1행 + 경쟁사는 부가정보)와 일치한다고 판단.
- **한계:** 경쟁사 자체의 시계열 추이는 이 표만으로 못 뽑는다(jsonb는 시계열
  집계에 비효율적). 필요해지면 브랜드별 행 분리로 바꿔야 한다 — Day 8의
  jsonb→표 이관과 같은 유형의 부채.

### 규칙 B — 순위 지표는 overallRank

`avg_rank`/`rank_stddev`는 `mentions.rank`(=overallRank, 미등록 브랜드까지 포함한
절대 등장 순서)를 그대로 쓴다. `rankAmongKnown`(등록 브랜드끼리의 순위)은
**DB에 저장되지 않아서** 이번 범위에서 못 썼다 — 별도 과제로 남김.

- **언제 틀리는가:** 미등록 경쟁사가 답변마다 들쭉날쭉 등장하면, 등록 경쟁사
  대비 위치는 안 변했는데 overallRank만 흔들려서 "순위가 나빠졌다"는 착시가
  생길 수 있다.
- **클라이언트에게:** "AI 답변에 실제 등장한 순서 기준"이라고는 말할 수 있음.
  "추적 중인 경쟁사들 사이에서의 순위"라고는 말하면 안 됨.

### 규칙 C — 분모(total_runs) 정의

`status='success' AND search_performed=true`인 스냅샷만 유효 관측치로 센다.
실패와 검색-스킵은 분모·분자 모두에서 제외.

- 제외된 실패/스킵 건수는 이번엔 별도로 기록하지 않음 — **Day 12(알림) 때 재검토
  예정.** 지금은 "실패율이 높아서 표본이 적은 기간"과 "원래 표본이 적은 기간"을
  구분 못 함.

### 규칙 D — 표준편차

유효 관측치(정확히는 언급된 관측치)가 2개 미만이면 `rank_stddev`는 null.
계산 방식은 **표본표준편차(n-1)** — 매 관측을 "AI가 낼 수 있는 모든 응답 중
하나의 표본"으로 보는 PRD의 "확률 측정" 전제와 맞다고 판단. n이 작을 때(2~6)
모표준편차(n)와 차이가 꽤 크므로 통계적으로 사소한 선택이 아님을 명시해둔다.

### 규칙 E — 빈 기간 처리

- 그 기간에 스냅샷 시도가 있었지만 유효 관측치가 0건(전부 실패/스킵)이면
  → `total_runs=0`, `visibility_rate=null`인 행을 **그대로 저장**한다(건너뛰지 않음).
- 그 기간에 스냅샷 시도 자체가 없었으면(수집이 아예 안 돌았으면)
  → 행을 만들지 않는다(없던 일을 기록하지 않는다).

---

## 착수 전 실측으로 확인한 사실

### 발견 1 — 권한 문제 (진짜 블로커였음)

`aggregated_metrics` 표에 대해 service_role(쓰기 권한 계정)이 SELECT조차
안 되는 상태였다(`permission denied`). `snapshots`/`mentions`는 정상.
Supabase SQL Editor에서 아래 문구 실행 후 해결:

```sql
GRANT ALL ON public.aggregated_metrics TO service_role;
```

### 발견 2 — rank 필드의 실제 정체

`mentions.rank` 컬럼에 실제로 저장되는 값은 `overallRank`다.
`rankAmongKnown`은 `parser.ts`에서 계산은 되지만 저장 경로가 없어서 버려진다.
(→ 규칙 B로 이어짐)

### 발견 3 — `aggregated_metrics` 실제 컬럼 (설계만 있고 코드가 없던 표)

필수: `query_id, brand_id, engine, period_start, period_end, total_runs,
mention_count, aggregation_level`. 선택(null 허용): `visibility_rate, avg_rank,
rank_stddev, top_keywords, competitor_data, batch_id`.

---

## 구현

- `lib/supabase.ts`: `fetchActiveQueries`에 `brandId` 필드 추가(집계에 필요해서
  추가 — 이전엔 이 필드를 쓰는 곳이 없어서 select에서 빠져 있었음).
  집계 전용 읽기 함수(`fetchSnapshotsForAggregation`, `fetchMentionsForAggregation`)와
  저장 함수(`saveAggregatedMetric`) 추가.
  ⚠️ 이 두 읽기 함수는 `supabase`(anon)가 아니라 `supabaseAdmin`을 쓴다 —
  실측 결과 anon 키로 snapshots/mentions를 읽으면 permission denied가 나서
  (원시 응답을 담은 표라 anon 권한이 애초에 없음), AGENTS.md의 "읽기는 anon"
  원칙에서 예외로 명시.
- `lib/aggregator.ts` (신규): 핵심 집계 함수 `aggregateOne`, KST 날짜 경계 계산
  `kstDayBoundsUtc`, 하루 전체를 도는 오케스트레이터 `aggregateAllQueriesForDay`.
  엔진은 구현된 4개가 아니라 `ENGINE_NAMES` 전체(6개)를 돈다 — 나중에 Tier 1
  어댑터(구글 AI Overviews·네이버 AI브리핑)가 붙어도 이 파일은 코드 수정 없이
  그대로 동작한다(스냅샷이 없으면 규칙 E에 따라 자동으로 건너뜀).
- `app/api/test-aggregate-daily/route.ts` (신규): 수동 트리거용 테스트 라우트.
  Day 12에 진짜 Cron이 붙기 전까지 검증 수단.

## 검증

로컬 Next.js 개발 서버가 이 세션의 실행 환경에서 뜨지 않아(SWC 네이티브
바이너리 문제), 같은 소스 파일을 별도 환경에서 컴파일해 직접 실행하는 방식으로
검증함. 2026-08-17 daily 집계 실행 결과:

```
attempted: 30 (쿼리 5 × 엔진 6)
saved: 20
skipped: 10  (Tier 1 엔진 2개 × 쿼리 5 — 아직 스냅샷이 없어서 정상적으로 건너뜀)
failed: 0
```

원본 대조 1건 직접 검산: ChatGPT 응답에서 365서울원탑치과가 실제로 3번째로
등장 → 저장된 `avg_rank=3`, `mention_count=1` 일치. 같은 답변의 더와이즈치과병원
(2위)도 `competitor_data`에 정확히 반영됨. 미등록 브랜드 5곳(아이디마곡치과 등)은
의도대로 집계에서 빠짐.

⚠️ 이 검증 실행으로 실제 `aggregated_metrics`에 20개 행이 생성됨 — 테스트용
가짜 데이터가 아니라 실제 수집된 스냅샷을 집계한 진짜 첫 데이터임.

---

## 남은 부채 (Day 9 시점)

1. **batch 레벨 집계는 코드만 있고 의미 있게 검증 못 함.** 지금은 `collectAndSaveAll`이
   호출마다 새 `batchId`를 발급하고 `runIndex`가 1로 고정돼 있어서(Day 11 예정 수정),
   batch 레벨과 daily 레벨이 사실상 구분되지 않는다. Day 11에서 진짜 배치 구조가
   생긴 뒤 batch 레벨 집계를 다시 검증해야 함.
2. **실패/스킵 비율을 별도로 기록하지 않음** (규칙 C) — Day 12(알림) 때 재검토.
3. `rankAmongKnown`이 DB에 없어서 규칙 B의 한계가 그대로 남아있음.
4. `top_keywords`는 항상 null — 노출 키워드 추출(LLM 기반) 자체가 아직 미착수.
5. 이번 집계 함수는 순차 처리(30개 조합을 하나씩)라 데이터량이 늘면 느려질 수
   있음 — 지금 규모(하루 30건 이내)에서는 문제 없음.
