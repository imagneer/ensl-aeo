# Ensl AEO MVP — Day 8 결정 기록: 출처 연결(link 감지)

**결정일:** 2026-08-17
**상태:** 확정 (구현·검증 완료)
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
- **엔진 간 비교는 "사용한 것" 기준으로만** 한다 — ChatGPT가 "본 것"을 제공하지 않기 때문.
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
| Perplexity | 20개 | 10개 참조 | 본문 `[n]` 마커 → citations 1-based 인덱스 |
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

`retrieved_sources`의 NULL은 두 뜻이며 `status` 칸으로 구분: `success`+NULL = 엔진이 제공 안 함(ChatGPT), `failed`+NULL = 수집 실패.
수집 실패 시 `search_performed`는 `false`가 아니라 **NULL**(모름).

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

---

## 작업 방식 합의 (2026-08-17)

Cowork 환경에서 에일이 로컬 폴더에 직접 접근할 수 있게 되면서, 기존의 "제안 → 루아가 넣고 확인 → 문제 해결" 흐름이 빠졌고 루아가 진행 내용을 따라가기 어려워짐.

- 코드는 에일이 작성한다 (루아의 목적은 개발자가 되는 것이 아님)
- 단 **판정 규칙은 코드 작성 전에 합의**한다
- 보고는 구현 세부(필드명·인덱스 단위)가 아니라 **규칙 수준**으로: 무슨 규칙인가 / 언제 틀리는가 / 클라이언트에게 뭐라고 말할 수 있고 뭐라고 말하면 안 되는가
- 한 번에 하나씩
