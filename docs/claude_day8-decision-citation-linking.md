# Ensl AEO MVP — Day 8 결정 기록: 출처 연결(link 감지)

**결정일:** 2026-08-17
**상태:** 확정 (구현·검증 완료) — **2026-09-14 Perplexity 관련 예외 추가 (아래 참고)**
**Notion:** ENSL AEO MVP 개발 Day8

---

## 한 줄 요약

AI 답변의 출처를 **"본 것"과 "사용한 것"으로 분리**하고, **브랜드별로 갈라 붙이되 확신도를 함께 기록**하도록 확정.

---

## 확정된 판정 규칙

### 규칙 1 — 출처는 두 종류다

| 용어 | 뜻 |
|---|---|
| **본 것 (retrieved)** | AI가 검색해서 받아온 후보 출처 목록 |
| **사용한 것 (cited)** | AI가 답변에 실제 근거로 붙인 출처 |

- 절대 같은 컬럼에 넣지 않는다.
- **엔진 간 비교는 "사용한 것" 기준으로만** 한다 — ChatGPT가 "본 것"을 제공하지 않기 때문. (2026-09-14부터 Perplexity도 이 예외에 합류 — 아래 참고)
- 셀 때 **구간 개수**와 **고유 출처 개수**를 구분한다.

### 규칙 2 — 브랜드와 출처는 같은 문단 안에서만 연결한다

- 문단 = **줄바꿈(`\n`) 단위** (빈 줄 단위 아님)
- 이유: AI 답변은 `- 병원이름: 설명[1][3]` 형태의 목록으로 답하는 경우가 많다. 빈 줄 기준이면 목록 전체가 한 덩어리가 되어 서로 다른 병원의 출처가 섞인다.

### 규칙 3 — 확신도를 함께 기록한다

| 값 | 조건 |
|---|---|
| `confirmed` | 그 문단에 브랜드가 하나뿐 |
| `estimated` | 그 문단에 브랜드가 여럿 (어느 출처가 누구 근거인지 알 수 없음) |
| `none` | 그 문단에 출처 구간이 없음 |

**이 확신도는 엔슬의 판정이지 AI가 알려준 값이 아니다.** AI는 "이 문장의 근거는 이 출처"까지만 알려주고, 그 문장 안의 어느 브랜드 얘기인지는 알려주지 않는다. `confirmed`조차 추론이다. 클라이언트 자료에는 판정 기준임을 밝힌다.

### 규칙 4 — 출처가 없으면 끌어오지 않는다

문단에 출처가 없으면 `none`. "AI가 근거 없이 이름만 언급했다"도 사실이며 그 자체가 정보다.

---

## 실측으로 확인한 사실 (2026-08-17)

착수 전 `app/api/probe-citations`로 4개 엔진 원본 응답을 확인. "문서만 믿고 시작하지 않는다" 원칙 적용.

### 엔진별 인용 구조 — 4/4 전부 구간↔출처 매핑 제공

| 엔진 | 본 것 | 사용한 것 | 형태 |
|---|---|---|---|
| Perplexity | 20개 | 10개 참조 | 본문 `[n]` 마커 → citations 1-based 인덱스 (⚠️ 이건 **구 Sonar Chat Completions API** 기준. 2026-09-27 지원 종료로 Agent API 전환 후에는 아래 "2026-09-14 갱신" 참고 — 이 표와 다름) |
| ChatGPT | **제공 안 함** | 7구간 | `annotations[].url_citation.start_index/end_index` |
| Claude | 8개 | 7구간 / 고유 5개 | text 블록의 `citations[]` |
| Gemini | 7개 | 19구간 | `groundingSupports[].segment` |

### 문서에 없던 함정

- **OpenAI가 URL에 `?utm_source=openai`를 붙여서 돌려줌** → 정규화 없으면 같은 홈페이지가 다른 출처 2개로 집계
- **Gemini의 `segment` 인덱스는 UTF-8 바이트 오프셋** (한글 1글자=3바이트). 변환 없이 `slice`하면 좌표가 3배로 밀림. 19/19 구간 검산 완료
- **Gemini의 출처 uri는 구글 중계 주소**(`vertexaisearch.cloud.google.com/grounding-api-redirect/...`). 실제 도메인은 `title`에만 있음(10/10 확인) → **Gemini는 도메인까지만 알 수 있고 페이지 단위 비교에 참여 불가**
- **Day 7까지 4개 엔진 중 3개(Perplexity·Claude·Gemini)가 "본 것"을 저장하고 있었음.** Perplexity의 `citations`는 `search_results`와 20/20 일치 = 후보 목록
- **ChatGPT의 구간은 인용 표시 `([도메인](URL))` 자체만 가리킴.** 브랜드명은 그 앞에 있어서, "구간 안에서 브랜드 찾기"로 짜면 ChatGPT만 결과 0건 → 문단 단위 매칭을 택한 이유

---

## 2026-09-14 갱신: Perplexity Agent API 전환에 따른 예외

**배경**: Perplexity가 Sonar Chat Completions를 2026-09-27부로 지원 종료, Agent API(`POST /v1/agent`)로 강제 전환. 위 표의 Perplexity 행("본문 `[n]` 마커 → citations 인덱스")은 구 API 기준이라 더 이상 유효하지 않음.

**실측 확인 (코난, 2026-09-14, 응답 전수/재귀 검색)**:
- `model: "perplexity/sonar"`(원래 모델과 동일)로 고정 시: `web_search` 도구 정상 작동, `search_results` 15건씩 정상 수신("본 것"은 유지). 그러나 답변 본문에 `[n]` 인용 마커가 **4/4 테스트 전부 0개**.
- 응답 전체 재귀 검색 결과 `citations`/`annotations` 등 대체 필드 없음 확인 — `annotations`는 5개 응답 전부(아래 preset 케이스 포함) 항상 빈 배열. `source` 필드는 "web"이라는 고정값일 뿐 실제 인용 여부와 무관.
- `preset` 파라미터로 다른 회사 모델(OpenAI)에 라우팅하면 인용 마커가 정상적으로 나옴(5/5) — 그러나 이 경우 "Perplexity" 라벨로 저장되는 데이터가 실제로는 OpenAI 모델의 응답이 되어, 이미 별도로 수집 중인 OpenAI 엔진 데이터와 실질적으로 중복·오분류됨.

**결론**: `perplexity/sonar` 모델 자체가 Agent API를 통해서는 인용 마커를 제공하지 않는 것으로 확인됨(4/4). 필드 누락이 아니라 API/모델 조합의 구조적 한계.

**판정 규칙 예외 (확정)**:
- Perplexity는 `model=perplexity/sonar` 고정 유지 — 이름과 실제 응답 모델을 반드시 일치시킨다(다른 회사 모델로 라우팅 금지 — 그러면 "Perplexity" 이름으로 사실상 OpenAI 데이터를 중복 수집하게 되어 원칙 1 위반이자 데이터 오염).
- **"사용한 것"(cited) 판정은 Perplexity에 한해 규칙 1의 예외로, 측정 불가로 처리한다.** `null`이 아니라 명시적 플래그(예: `citation_status = 'unavailable'`)로 저장 — 단순 NULL은 "수집 실패"와 구분이 안 되므로 반드시 구분.
- "본 것"(retrieved/search_results)은 계속 정상 수집·저장한다.
- 엔진 간 "사용한 것" 비교 지표에서 Perplexity는 ChatGPT와 마찬가지로 제외 대상에 합류(규칙 1 갱신 반영).
- 대시보드/클라이언트 리포트에 "Perplexity는 API 제약으로 인용 출처 판정 미제공(노출 여부만 측정)" 배지 표시.
- **이 갭은 Perplexity 서비스 자체의 특성이 아니라 API 경로의 한계로 추정** — 실제 perplexity.ai 웹 UI에서는 각주가 표시됨. PRD의 "API ≠ 웹 제품 경험" 리스크(OpenAI 항목과 동일 패턴)로 함께 문서화할 것.
- (선택) 브랜드명 텍스트 직접 언급 여부를 보조 신호로 추가 가능 — 단, 각주 기반 판정과 신뢰도를 절대 동일시하지 말고 별도 필드로 분리.
- **재검토 시점**: Perplexity Agent API가 신생 API라 향후 인용 마커 지원이 추가될 수 있음. 수개월 뒤 재확인 권장.

---

## 저장 형식 결정: jsonb (별도 표 아님)

`snapshots.retrieved_sources`, `snapshots.cited_spans`를 별도 표가 아니라 `jsonb` 한 칸에 저장.

- **대가:** 출처 단위 집계("우리를 띄우는 출처 상위 10개")가 어려움. 이건 엔슬 상품의 핵심 질문이라 언젠가 표로 옮겨야 함
- **그래도 지금 jsonb인 이유:** 정보를 버리지 않으므로 나중에 언제든 펼칠 수 있고, 옮기는 비용은 데이터 양에 비례. 지금 표로 쪼개면 표가 2~3개 늘고 저장 로직이 복잡해짐(2단계 저장 → 중간 실패 처리 필요)
- **⚠️ 이관 시점: 대시보드(Week 4) 착수 시.** 미루면 안 하게 됨

---

## DB 변경

```sql
-- snapshots
alter table snapshots
  add column if not exists retrieved_sources jsonb,
  add column if not exists cited_spans jsonb,
  add column if not exists search_performed boolean;

-- mentions
alter table mentions
  add column if not exists citation_confidence text,
  add column if not exists source_domains text[];

alter table mentions
  add constraint mentions_citation_confidence_check
  check (citation_confidence in ('confirmed', 'estimated', 'none'));
```

기본값을 주지 않음 — 기존 행이 NULL로 남는 게 맞다. 0이나 빈 목록으로 채우면 "쟀는데 0이었다"는 거짓말이 된다.

`retrieved_sources`의 NULL은 두 뜻이며 `status` 칸으로 구분: `success`+NULL = 엔진이 제공 안 함(ChatGPT, 2026-09-14부터 Perplexity도 해당), `failed`+NULL = 수집 실패.
수집 실패 시 `search_performed`는 `false`가 아니라 **NULL**(모름).

**2026-09-14 추가 → 구현 완료(코난)**: 별도 컬럼 대신 기존 체크 제약에 `unavailable` 추가로 확정(`docs/perplexity-citation-unavailable-schema.sql`, 프로덕션 DB 적용 완료). 별도 컬럼을 안 쓴 이유: `unavailable`은 citation_confidence가 이미 표현하는 개념(이 멘션의 출처 확신도)의 네 번째 값일 뿐이라, 컬럼을 나누면 두 컬럼이 서로 모순되는 상태(예: confidence='none'인데 status='unavailable')가 가능해져 오히려 실수를 유발함.

**구현 반영 범위(2026-09-14, 코난)**:
- `lib/adapters/perplexity.ts` — Agent API(`POST /v1/agent`, `model=perplexity/sonar`, `tools:[{type:'web_search'}]`)로 전환, `citationTrackingUnavailable: true` 명시
- `lib/types.ts` — `AdapterResponse.citationTrackingUnavailable?: boolean` 추가
- `lib/collector.ts` — 이 플래그가 true면 `linkCitationsToMentions`를 아예 안 부르고 바로 `confidence: 'unavailable'`로 채움
- `lib/aggregator.ts` — M/S/C 뱃지용 `hasCitation`을 `boolean` → `boolean | null`로 확장(hasSource와 같은 패턴), Perplexity처럼 엔진 전체가 unavailable이면 null(확인 불가)
- `app/(dashboard)/query/[id]/page.tsx` + `components/QueryEvidenceList.tsx` — "출처 분석 카드"에 "인용 출처 미제공" 배지(`.badge.unavailable`) 추가
- ⚠️ M/S/C 뱃지 자체는 아직 어느 화면에도 렌더링되는 UI가 없음(데이터 레이어만 존재) — 나중에 그 UI를 만들 때 `hasCitation===null` 케이스를 반드시 반영할 것

---

## 결과

```
365서울원탑치과   confirmed  [onetopdental.com]
서울리더스치과    confirmed  [blog.naver.com]
강서모아치과      confirmed  [gsmoredent.com]
더와이즈치과병원  estimated  [dentalroad.kr, onetopdental.com, ...]
```

확신도 분포: confirmed 58 / estimated 33 / none 14

- 브랜드마다 출처가 다르게 붙음 (이전엔 전부 동일)
- 서울리더스치과는 홈페이지가 아니라 **네이버 블로그로** 인용되고 있음
- 마지막 줄이 등급 분리가 필요했던 이유: 경쟁사 줄에 원탑 홈페이지가 섞여 들어감. `estimated` 표시로 걸러낼 수 있음

---

## 남은 부채

1. **어댑터 4개(1,089줄)를 서브에이전트가 작성했고 사람이 검토하지 않음.** 타입체크·자체 검산은 통과
2. `runIndex` 1로 고정 — Day 4 설계(3배치 × 2반복)가 코드에 없음 (Day 11)
3. **Tier 1 어댑터 미착수** — 구글 AI Overviews, 네이버 AI브리핑 (SerpApi)
4. 노출 키워드 추출(LLM 기반) 미착수
5. jsonb → 표 이관 (대시보드 착수 시점)
6. `app/todos/page.tsx` 타입 에러 6건 — Day 2 연습 파일, 삭제 여부 결정 필요
7. Anthropic: 검색 2회 이상 시 중간 text 블록과 그 citations 유실 (미관측)
8. OpenAI: 서로게이트 페어(이모지) 섞인 답변에서 인덱스 밀림 가능성 (미검증)
9. Gemini: `parts` 2개 이상일 때 구간 좌표 기준 미검증 (경고 로그로 감지)
10. **정규식·position의 실제 정확도 미검증** — 코드는 있으나 미등록 브랜드를 제대로 잡는지 실데이터로 확인한 적 없음. `probe-output/`의 답변 본문으로 검증 가능
11. ~~**(2026-09-14 추가) Perplexity Agent API 전환 구현**~~ **→ 완료(2026-09-14, 코난)** — 어댑터·DB(CHECK 제약)·질문상세 화면 배지까지 반영. M/S/C 뱃지 UI 자체가 아직 없어 그 화면은 못 검증함(위 "구현 반영 범위" 참고). Perplexity Agent API가 신생 API라 향후 인용 마커 지원이 추가될 수 있음 — 수개월 뒤 재확인 권장(claude/tasks/done/2026-09-14-budget-check-actions.md 참고)

---

## 작업 방식 합의 (2026-08-17)

Cowork 환경에서 에일이 로컬 폴더에 직접 접근할 수 있게 되면서, 기존의 "제안 → 루아가 넣고 확인 → 문제 해결" 흐름이 빠졌고 루아가 진행 내용을 따라가기 어려워짐.

- 코드는 에일이 작성한다 (루아의 목적은 개발자가 되는 것이 아님)
- 단 **판정 규칙은 코드 작성 전에 합의**한다
- 보고는 구현 세부(필드명·인덱스 단위)가 아니라 **규칙 수준**으로: 무슨 규칙인가 / 언제 틀리는가 / 클라이언트에게 뭐라고 말할 수 있고 뭐라고 말하면 안 되는가
- 한 번에 하나씩
