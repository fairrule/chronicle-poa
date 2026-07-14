# 데이터 출처 · 데이터 사전 (Provenance)

이 시스템이 산출하는 **모든 데이터 항목의 출처**를 명시한다. 명세 원칙 5(원천 보존)와
부록 B(신뢰 경계)에 따른 감사 추적용. 출처는 세 곳에 이중으로 기록된다:

1. **이 문서** — 사람이 읽는 데이터 사전
2. **`data/analysis.json`** — 기계가 읽는 항목별 출처 (`sources` 블록 + `assets[].source`)
3. **정적 대시보드** — "출처(Provenance)" 패널 + 밸류에이션 표의 익스플로러 링크

최종 갱신: 2026-07-13

---

## 1. 데이터 항목별 출처

| 데이터 항목 | 출처 | 접근 방법 | 저장 위치 | 신뢰 경계 |
|---|---|---|---|---|
| **오라클 주소** (adapter/router) | Chronicle 공식 문서 (2026-07) | 문서값 → 런타임 온체인 검증 | `config/oracles.yaml` | `decimals()` 응답으로 존재 검증 |
| **NAV, roundId, updatedAt, decimals** | 온체인 Chronicle VAO adapter/router | `eth_call latestRoundData()` / `decimals()` | `snapshots` 테이블, `raw_answer`에 원천 int256 보존 | 커스터디언 보고값의 **전송 무결성**. 독립 회계감사 아님 |
| **검증자 집합, 쿼럼(bar), 피드명, latestPoke** | 온체인 Chronicle VAO consumer | `eth_call validatorsECDSA()` / `barECDSA()` / `name()` / `latestPoke()` | `snapshots`(요약) + `snapshot_validators`(1:N) | "몇 명의 독립 검증자가 이 값에 서명하는가" |
| **holdings** (만기·시장가치·비중·yield) | 발행사 오프체인 공개 소스 | 자산별 상이 (아래 §2) | `holdings` 테이블, 행마다 `source` 태그 | **온체인 read-only 경계 밖**. 발행사 self-report |
| **freshness / trust_grade** | 파생 (계산값) | `updatedAt`과 수집시각 차이, `config/rpc.yaml` 임계 | `snapshots` 테이블 | 명세 4장 규칙 |
| **WAM · 만기버킷 · 집중도 · look-through** | 파생 (holdings 기반) | `src/analyze.ts` 순수 함수 | `data/analysis.json` | holdings 출처의 신뢰도를 상속 |
| **토큰 yield** | 발행사/집계 소스 | USTB=Superstate API · Centrifuge 자산=Centrifuge GraphQL(`yield30d365`) · **BUIDL=수동(rwa.xyz 7D APY)** | `yields` 테이블 (`source` 컬럼에 출처) | 발행사 self-report. 수동값은 `is_manual` 플래그+as_of로 표시 |
| **자산군 (asset_class)** | Centrifuge pool명 + 발행사 정보 | `config/asset_class.yaml` | 분석 시 매핑 | treasury/clo/credit/equity — 벤치마크 해석 결정 |
| **위험자유금리 (국채)** | US Treasury | par yield curve XML (무료·무인증) | `benchmarks` 테이블 | 공식 정부 데이터 |
| **벤치마크 스프레드** | 파생 (yield − 국채) | `src/analyze.ts` `computeSpread` | `data/analysis.json` `benchmark` | 투자판정 지표 |
| **교차체인 NAV 발산** | 파생 (온체인 NAV 기반) | 같은 ticker의 체인별 NAV 비교 | `data/analysis.json` `cross_chain` | 온체인 read 무결성 |
| **RPC 응답** | 무료 공용 RPC | 다중 fallback | — | `config/rpc.yaml` |

---

## 2. 오프체인 holdings 소스 (자산별)

조사일 2026-07-13. 상세 조사 결과는 [README](../README.md#오프체인-holdings-소스-조사-결과-2026-07-13) 참조.

| 오라클 | 소스 | URL | 형식 | 인증 | 상태 |
|---|---|---|---|---|---|
| `superstate_ustb_eth` (USTB) | Superstate 공개 API | `https://api.superstate.com/v2/funds/1/holdings` | JSON | 없음(무료) | ✅ 연동 (이름+만기+시장가치+비중, CUSIP 없음) |
| `centrifuge_jtrsy_eth` (JTRSY) | Centrifuge V3 GraphQL | `https://api.centrifuge.io` | GraphQL | 없음(무료) | 🔴 instrument 불가, 집계(AUM·cash)만 가능 |
| `securitize_buidl_eth` (BUIDL) | Chronicle PoA 대시보드 | `https://chroniclelabs.org/dashboard/proof-of-asset` | SPA(봇체크) | — | 🔶 자동화 불가로 보류 |

> 오프체인 소스 정의는 `config/offchain/<oracle_id>.yaml`. 신규 추가는 YAML만 작성(코드 무수정).

---

## 3. 검증 방법 (출처를 직접 확인하려면)

- **온체인 주소·NAV·attestation**: `data/analysis.json`의 각 `assets[].source.nav.explorer` /
  `assets[].source.attestation.explorer` 링크로 블록 익스플로러에서 컨트랙트·값을 직접 확인.
  또는 `npm run verify`로 전 오라클 응답 재검증.
- **오프체인 holdings**: `assets[].source.holdings.url` 을 브라우저/`curl`로 직접 열어
  `as_of` 날짜와 함께 대조. `holdings` 테이블의 `source` 컬럼이 어느 소스에서 왔는지 기록.
- **파생 지표**: `src/analyze.ts`의 순수 함수 + `src/analyze.test.ts` 단위 테스트로 계산 로직 검증.

---

## 4. 신뢰 경계 (모든 분석 산출물에 명시)

Chronicle Proof of Asset이 보장하는 것은 **"커스터디언/관리자가 보고한 값이 조작 없이
온체인에 전달되었다"**는 무결성이다. BUIDL처럼 custodian-direct 소싱은 발행사 self-report의
순환을 우회하지만, 그 자체가 감독당국이 인정하는 **독립 회계감사는 아니다**. 오프체인 holdings는
발행사 공개 데이터로, 온체인 read-only 무결성 밖에 있다. 모든 분석 산출물에 이 경계를
데이터 등급과 함께 표기한다. (`analysis.json`의 `note` 필드, 대시보드 상단 주석)
