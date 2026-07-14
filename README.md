# Chronicle Proof of Asset — 수집·분석 시스템

토큰화 자산 오라클(Ethereum·Base·Monad, ~18개)에서 검증 데이터를 **read-only**로 하루 1회 수집·정규화·분석하는 시스템. 전체 명세는 [`chronicle_poa_build_spec.md`](chronicle_poa_build_spec.md).

**원칙**: 비용 0(상시 서버·유료 RPC 없음), read-only(`eth_call`/`eth_getLogs`만), 온체인 트랜잭션·키 취급 없음.

## 현재 상태

- ✅ **Phase 0** — 스캐폴딩 + 레지스트리 + 멀티 RPC fallback + 주소 검증
- ✅ **Phase 1** — Tier-1 수집 → canonical 정규화 → **로컬 JSON/CSV 멱등 저장**
- ✅ **Phase 2** — attestation 메타데이터 + SQLite + **오프체인 holdings 커넥터**(USTB instrument-level 확보)
- ✅ **Phase 3** — 분석(WAM·만기버킷·집중도·look-through·교차체인) + **벤치마크 스프레드(투자판정)** + **오라클 신뢰도 스코어** + 무결성 게이트 + Slack 알림
- 🔶 **Phase 4** — 정적 대시보드 + **track record 백필(Centrifuge)** 완료. GitHub Actions cron은 저장소 push 후

> **저장소 관련 결정**: 조직 GCP 정책(`iam.disableServiceAccountKeyCreation`)이 서비스
> 계정 키 생성을 차단하여, Phase 1의 구글 시트 저장 대신 **로컬 JSON/CSV**로 저장한다.
> canonical 스키마(명세 4장)는 그대로 지키므로, 나중에 저장 계층(`SnapshotStore`)만
> 시트/SQLite/Lakehouse 구현으로 교체하면 된다(명세 8장 승격 경로).
>
> **Tier-2 관련 결정**: Chronicle VAO 오라클 스택(Router→Consumer→uScribe)은 **스칼라
> 오라클**이라 holdings·yield struct를 온체인에 발행하지 않는다. 실제로 읽히는 리치
> 데이터는 **attestation 메타데이터**(검증자 집합·쿼럼·피드명·latestPoke)이며, 이를
> Tier-1과 함께 SQLite에 저장한다(명세 부록 B의 신뢰 경계). 진짜 holdings(만기·시장가치·비중)는
> 발행사 오프체인 소스에서 가져와 `holdings` 테이블에 채운다.

### 오프체인 holdings 소스 조사 결과 (2026-07-13)

| 자산 | instrument-level holdings | 소스 | 상태 |
|---|---|---|---|
| **USTB** | ✅ 이름+만기+시장가치+비중+yield (CUSIP 없음) | Superstate 공개 API (무료·무인증) | **연동 완료** |
| **JTRSY** | ❌ (KYC 게이트 앱 UI에만) | 집계(AUM·NAV·온체인 cash)만 Centrifuge GraphQL 무료 | instruments 불가 |
| **BUIDL** | 🔶 Chronicle PoA 대시보드에만 존재, Vercel 봇체크 | — | **자동화 불가로 보류** |

> **BUIDL 스크래핑 보류 결정(2026-07-13)**: Chronicle Proof of Asset 대시보드
> (`/dashboard/proof-of-asset`)는 브라우저로 봇체크 통과는 되지만, instrument holdings가
> 초기 payload에 없고 인터랙션 시 번들 내부 엔드포인트로 동적 로드된다. 무료 cron이
> Vercel 봇체크를 통과할 수 없어 **자동 파이프라인 소스로 부적합**. BUIDL 속이 필요하면
> Chronicle에 공식 데이터 접근(온체인 read 화이트리스트/피드)을 요청하는 것이 정식 경로.

오프체인 소스는 `config/offchain/<oracle_id>.yaml` 정의로 추가한다(코드 수정 없이). 제너릭
JSON-HTTP 커넥터가 필드 매핑·파서(money/percent/date)를 해석한다.

## 빠른 시작

```bash
npm install
npm run verify      # 전 오라클의 decimals()/latestRoundData() 온체인 응답 확인
npm run collect     # 수집 → 정규화 → SQLite + data/latest.csv·json 갱신 (멱등)
npm run analyze     # SQLite → WAM·만기버킷·look-through·무결성 → data/analysis.json
npm run alert       # analysis.json의 위반을 Slack webhook 통지 (미설정 시 로그만)
npm run dashboard   # analysis.json 복사 후 localhost:4599 정적 대시보드 서빙
npm test            # 단위 테스트 (정규화·멱등·holdings·분석)
```

## 정적 대시보드

`dashboard/index.html` — 외부 의존 0의 자체 완결형 단일 페이지. `analysis.json`을 fetch해
4패널을 렌더한다: ① 밸류에이션(자산별 NAV·등급·검증자 쿼럼) ② 리스크 분해(WAM·만기버킷·
look-through) ③ 무결성 게이트(플래그·교차체인 일관성) ④ 벤치마크(후속). 다크/라이트 테마
자동. Cloudflare Pages / GitHub Pages에 `dashboard/`를 그대로 배포하면 된다(빌드 단계에서
`analysis.json`을 함께 배치).

```bash
npm run dashboard   # 로컬 미리보기 (http://localhost:4599)
```

수집 후 `data/latest.csv`(또는 `latest.json`)를 열면 자산별 최신 NAV·라운드·
관측시각·freshness·trust_grade가 한눈에 보인다 = **현재의 대시보드**.

## 구조

```
config/
  oracles.yaml   # 오라클 레지스트리 (명세 2.2) — 신규 추가 시 여기만 수정
  rpc.yaml       # 무료 공용 RPC 엔드포인트 + freshness 임계
  offchain/      # 오프체인 holdings 소스 정의 (자산당 1 YAML)
src/
  registry.ts    # 레지스트리 로더·파서 (<issuer>_<ticker>_<chain>)
  rpc.ts         # 멀티 RPC fallback 클라이언트 (viem)
  abi.ts         # Tier-1 인터페이스 ABI (IChainlinkAggregatorV3)
  types.ts       # canonical 데이터 모델 + 멱등 자연 키
  env.ts         # .env 로더 (의존성 없음)
  collect_tier1.ts      # Tier-1 스칼라 수집 (오라클별 try/catch)
  collect_attestation.ts # attestation 메타데이터 수집 (검증자·쿼럼·피드명)
  collect_holdings.ts    # 오프체인 holdings 제너릭 커넥터 (config 해석)
  normalize.ts   # raw → AssetSnapshot (NAV 스케일·freshness·trust_grade)
  store.ts       # 저장 계층 인터페이스 (SnapshotStore)
  store_json.ts  # 로컬 JSON/CSV 구현 (멱등, 대시보드)
  store_sqlite.ts # SQLite 구현 (snapshots + snapshot_validators + holdings)
  analyze.ts     # 분석 배치 (WAM·만기버킷·집중도·look-through·교차체인·무결성)
  alert.ts       # Slack webhook 알림 (무결성 위반 시)
  index.ts       # collect → normalize → store 오케스트레이션
  normalize.test.ts · analyze.test.ts  # 단위 테스트
scripts/
  verify_addresses.ts  # 전 오라클 온체인 검증 리포트
  test_fallback.ts     # RPC fallback 동작 증명
  inspect_contract.ts  # Etherscan V2 컨트랙트 인스펙터 (Tier-2 조사)
data/                  # 산출물 (gitignore)
  snapshots.json  # Tier-1 이력 (append)
  latest.csv/json # 오라클별 최신 = 대시보드
  poa.sqlite      # 구조화 질의용 DB (snapshots·validators·holdings)
  analysis.json   # 분석 산출물 (정적 대시보드가 소비)
```

## 벤치마크 스프레드 (투자판정)

토큰 yield를 **동일 만기 위험자유금리(미국채)** 와 비교해 "직접 국채 사는 게 나은가"를 판정한다.
- 토큰 yield: **USTB=Superstate API, Centrifuge 자산(JTRSY·JAAA·ACRDX 등)=Centrifuge GraphQL** (`config/benchmarks.yaml`)
- 위험자유금리: **US Treasury par yield curve** (무료·무인증 XML), WAM으로 테너 자동 선택
- **자산군별 해석**(`config/asset_class.yaml`): 국채=스프레드는 토큰화·운용 비용 / 크레딧·CLO=신용위험 프리미엄 / 주식=국채 벤치 부적합

예) 7개 자산 스프레드:
- **USTB/JTRSY(국채)** −22~−64bp → "직접 국채가 유리(토큰화 비용)"
- **ACRDX(크레딧)** +32bp → "신용위험 프리미엄"
- **JAAA(AAA CLO)** −31bp → "크레딧인데 국채보다 낮음, 이례적 — 점검 필요" (시스템이 이상 자동 감지)

SQLite `yields`·`benchmarks` 테이블에 이력 저장(시계열).

## 오라클 신뢰도 스코어

각 오라클을 0-100 점수 + 등급(높음/보통/낮음)으로 평가. **투명한 감점식**이라 약점을 숨기지 않는다.
- freshness: stale −30, expired −60
- 쿼럼(bar): <3 약함 −20, 3~12 −5 (현재 전 피드 bar=2 → 모두 "attestation 약함" 플래그)
- 교차체인 발산 −20

예) STAC=20(낮음, expired 갱신중단), 나머지=80(높음이나 쿼럼 2 약점 노출). 이력이 있으면
가동률(uptime)도 반영(<80% 감점).

## Track record (실적 시계열)

NAV·yield 이력으로 **실현 연율수익·변동성·최대낙폭·가동률**을 계산한다(`computeTrackRecord`).
- **백필**: 온체인 Poked 이벤트 백필은 무료 RPC의 archive 제약으로 불가 → **Centrifuge GraphQL
  TokenSnapshot 이력**(무료, ~300일)으로 `npm run backfill`. 비-Centrifuge는 cron이 forward-fill.
- **핵심 인사이트 — 광고 yield vs 실현수익 괴리**: 예) deCRDX 현재 yield 4.17% 인데 154일 실현
  연율수익은 **−0.17%** (대시보드에서 빨강 경고). JTRSY(국채)는 3.46% 실현·변동성 0.17%·낙폭 0%로 안정.
- 저장: `nav_history` 테이블 (일별, 멱등).

## 데이터 출처 (Provenance)

모든 데이터 항목의 출처를 세 곳에 명시한다 (명세 원칙 5 원천 보존, 부록 B 신뢰 경계):
- **[docs/SOURCES.md](docs/SOURCES.md)** — 사람이 읽는 데이터 사전 (항목별 출처·접근법·검증법)
- **`data/analysis.json`** — 기계가 읽는 항목별 출처 (`sources` 블록 + `assets[].source`: 온체인 주소·익스플로러 링크·holdings URL·as_of)
- **대시보드** — "출처(Provenance)" 패널 + 밸류에이션 표의 컨트랙트 익스플로러 링크

## 멱등 자연 키

`(oracle_id, round_id, observed_at)`. Chronicle 어댑터는 `roundId`를 1로 고정하는
경우가 많아, `updatedAt`(=observed_at)을 키에 포함해야 매일 갱신되는 값을 새
스냅샷으로 잡을 수 있다(명세 §1.4의 "roundId + updatedAt" 준수).

## 배포 (GitHub Actions + Pages) — Phase 4

[.github/workflows/daily.yml](.github/workflows/daily.yml) — 매일 06:00 UTC(수동 트리거도 가능)에
`backfill → collect → analyze → dashboard:build → alert`을 돌리고, 상태(SQLite)·대시보드 데이터를
커밋한 뒤 정적 대시보드를 **GitHub Pages**에 배포한다.

**필수 시크릿 없음** — 데일리 파이프라인은 무료 공용 RPC + 공개 API만 사용. (선택) 무결성 위반
알림을 원하면 repo Settings → Secrets에 `SLACK_WEBHOOK_URL` 추가.

올리는 절차:
```bash
git init && git add -A && git commit -m "init"
gh repo create chronicle-poa --private --source=. --push   # 또는 GitHub에서 repo 생성 후 remote 연결
```
1. repo **Settings → Pages → Source = GitHub Actions** 로 설정 (대시보드 배포 활성화)
2. **Actions 탭 → daily → Run workflow** 로 수동 실행하거나 다음 06:00 UTC 대기
3. (선택) `SLACK_WEBHOOK_URL` 시크릿 추가

> 상태 지속: `data/poa.sqlite`를 워크플로가 `git add -f`로 커밋해 forward-fill 이력을 보존한다.
> Centrifuge 이력은 매 실행 backfill로 재구성되므로 저장소 없이도 복원 가능.

## 설정

- **오라클 추가**: `config/oracles.yaml`에 항목 등록만 하면 됨 (코드 변경 불필요).
- **RPC 조정**: `config/rpc.yaml`의 체인별 배열 순서대로 fallback.
- **freshness 임계**: `config/rpc.yaml`의 `freshness` (기본 fresh≤26h, stale≤72h).

## 알려진 미해결 (Tier-1 read 불가 3건)

`centrifuge_despxa_eth`, `fission_nav_eth`(둘 다 adapter 없이 router만),
`keyring_pacrdx_eth`(adapter의 `latestRoundData` revert)는 Chainlink 인터페이스로
읽히지 않아 자동 스킵된다. adapter 주소 확보 또는 다른 read 함수 조사 필요.
