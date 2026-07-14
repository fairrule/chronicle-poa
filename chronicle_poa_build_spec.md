# Chronicle Proof of Asset — 수집·분석 시스템 빌드 명세

> **이 문서의 용도**: AI 코딩 에이전트(Claude Code 등)와 함께 바이브 코딩으로 이 시스템을 처음부터 구현하기 위한 실행 명세. 각 Phase는 독립적으로 완료·검증 가능하며, 순서대로 진행한다. 에이전트에게 "Phase N을 구현해줘"라고 지시하면 이 문서의 해당 섹션만으로 작업할 수 있도록 참조 데이터(주소·인터페이스·스키마)를 문서 안에 모두 포함했다.

**버전**: v0.2 기준 | **스택**: 최소비용 (상시 서버 0대) | **작성일**: 2026-07-13

---

## 0. 이 시스템이 하는 일 (한 문단 요약)

Chronicle Proof of Asset 오라클(Ethereum·Base·Monad에 배포된 ~18개)에서 토큰화 자산의 검증 데이터(NAV·holdings·yield·custody 등)를 하루 1회 온체인 read로 수집하고, 공통 스키마로 정규화하여 구글 시트(사람이 보는 신뢰 소스)와 SQLite(구조화 데이터)에 저장한 뒤, 평가·리스크·벤치마크 분석을 수행하고 이상 시 알림한다. **read-only**이며 온체인 트랜잭션·자금 이동은 하지 않는다.

---

## 1. 핵심 설계 제약 (에이전트가 반드시 지킬 것)

1. **비용 0 원칙**: 상시 구동 서버·유료 관리형 DB·유료 RPC·유료 인덱서를 쓰지 않는다. GitHub Actions cron + 무료 공용 RPC + 구글 시트 + SQLite + 무료 정적 호스팅만 사용.
2. **read-only**: `eth_call`(view 함수 호출)과 `eth_getLogs`만 사용. 트랜잭션 서명·전송 코드를 작성하지 않는다. 프라이빗 키를 다루지 않는다.
3. **두 개의 read 경로**:
   - **Tier-1** (모든 오라클 공통): Chainlink Adapter의 `latestRoundData()` / `latestAnswer()` / `decimals()` → 스칼라 값 1개(주로 NAV) + 라운드 메타.
   - **Tier-2** (자산별 상이): uScribe consumer의 커스텀 struct → holdings·yield 등. **Phase 2에서만** 다룬다. Phase 0~1은 Tier-1만.
4. **멱등성**: 온체인 `roundId`(+ `updatedAt`)를 자연 키로 사용. 같은 라운드를 중복 저장하지 않는다.
5. **원천 보존**: 정규화 전 raw 값을 항상 함께 저장(감사 추적용).
6. **주소는 문서값을 신뢰하되 런타임 검증**: 아래 표의 컨트랙트 주소는 온체인에서 코드 존재·응답을 확인한 뒤 사용. 응답이 없으면 스킵하고 로그.

---

## 2. 참조 데이터 (하드 팩트 — 코드에 그대로 반영)

### 2.1 온체인 read 경로

```
본 시스템(오프체인) --eth_call--> Adapter (IChainlinkAggregatorV3)
                                     또는 Router
                                        └--> uScribe Oracle
```

- **읽을 대상**: 항상 **Adapter**(Chainlink 호환) 또는 **Router** 주소. uScribe 오라클을 직접 read 하지 않는다.
- **Tier-1 인터페이스** (IChainlinkAggregatorV3, Adapter가 노출):

```solidity
function latestRoundData() external view returns (
    uint80 roundId,
    int256 answer,        // 스칼라 값 (NAV 또는 price), decimals() 만큼 스케일됨
    uint256 startedAt,
    uint256 updatedAt,    // freshness 판정 기준
    uint80 answeredInRound
);
function latestAnswer() external view returns (int256);
function decimals() external view returns (uint8);
```

### 2.2 오라클 레지스트리 (초기 시드 — 코드/설정에 그대로)

> 각 항목: `id`, `issuer`, `asset_ticker`, `chain`, `adapter_address`, `router_address`.
> Adapter가 있으면 Tier-1 read는 Adapter로, 없으면 Router로.

**Ethereum**

| id | issuer | ticker | Chainlink Adapter | Router |
|---|---|---|---|---|
| centrifuge_acrdx_eth | Centrifuge | ACRDX | 0x486A0A7676e966a77A32359134F11D95BBcF77dd | 0x87603527aeBbBDf46D73E524830bE81f93778FFa |
| centrifuge_jaaa_eth | Centrifuge | JAAA | 0x5A4BEEB8854442D69267C9a0a3A17BE60fDded04 | 0x5D44916E0Db13EcD661b20Df4D645904E57589C8 |
| centrifuge_jtrsy_eth | Centrifuge | JTRSY | 0x22d9527ad4489D3C760A6380a3c4dD06114B09aE | 0xE980a33EFA3EDDaa689eCbdCE4B2278D4DB94471 |
| centrifuge_dejaaa_eth | Centrifuge | deJAAA | 0xEC41d6BA0fCdae0E41A521F510907BF7E4a87694 | 0x25563a9F085975CC6B86F66F3c010c24c12B3Ffa |
| centrifuge_dejtrsy_eth | Centrifuge | deJTRSY | 0xb71e0Da4C6853718C04dAf58CA2ec22eB0fC4517 | 0x2EdD943484f104760591E18184CaBD53cdfBfC21 |
| centrifuge_despxa_eth | Centrifuge | deSPXA | — | 0x58AA442107ac268ffA1309D410fB9c6Be2b67783 |
| fission_nav_eth | Fission | NAV | — | 0xE7A65449bb4e68cBa274E92Df7607319DA669415 |
| galaxy_clo_eth | Galaxy | CLO | 0xA9D9fBB82900ec4F55Fe8d5213387456b7336974 | 0xBAAC5e7e609930922E52ff0F3DE94903CC98A5ab |
| keyring_pacrdx_eth | Keyring | pACRDX | 0x162D75665AA16526e4E509428333e4669A15119c | 0xa4A2E6472feb29b3b17f488Da6b5C5Fc1e34EC5A |
| superstate_ustb_eth | Superstate | USTB | 0x5D2edCaD212E2f480CD8E97d839b7D539249b6E5 | 0xDf8deCbDB89C95297ee6ef816Bd8A7B66973f254 |
| securitize_stac_eth | Securitize | STAC | 0xc5fc229d60c70420A0c5a64d0A7f59aA7F6f081d | 0x802CaCc19B9b3eb474C7DEf6f28c64AB67fb0753 |
| securitize_buidl_eth | Securitize | BUIDL | 0x35cE8603C90A4286CF91C4c05EfaE4565Daf7eFb | 0x8c68E0CacB61a065b99E2104457aCC829d61cbB0 |

**Base**

| id | issuer | ticker | Chainlink Adapter | Router |
|---|---|---|---|---|
| centrifuge_dejaaa_base | Centrifuge | deJAAA | 0xEC41d6BA0fCdae0E41A521F510907BF7E4a87694 | 0x25563a9F085975CC6B86F66F3c010c24c12B3Ffa |
| centrifuge_despxa724_base | Centrifuge | deSPXA 7/24 | 0x97165Ad36D96567a521958cc46914160B968752b | 0x7F316A3Da70b0b7ea3C450978c7c143e0Caf0469 |
| centrifuge_despxa_base | Centrifuge | deSPXA | 0x914b2E2953C4EdB87C164Fe1fddBdB3F6F34F971 | 0x58AA442107ac268ffA1309D410fB9c6Be2b67783 |

**Monad**

| id | issuer | ticker | Chainlink Adapter | Router |
|---|---|---|---|---|
| centrifuge_dejtrsy_monad | Centrifuge | deJTRSY | 0x1D2d52A40bDa48F2ae32F5f22F30C854A7312D96 | 0x6d0Df32190776224a9BD1e9AbF62b08D6f132905 |
| centrifuge_dejaaa_monad | Centrifuge | deJAAA | 0x9ff1007cbb2D793C6837E67Cd6B3AfEb62529ED0 | 0x5fA50241513e15dBF680B8980fb041eB2135b781 |
| centrifuge_decrdx_monad | Centrifuge | deCRDX | 0xAB13ABE3D2ecD94eB74DB2F35Cc4C5070CA949bB | 0x3d0Ec176032beFff3BA0E193F98489D7A039cfB4 |

> ⚠️ 주소는 2026-07 Chronicle 공식 문서 기준. 코드에서는 이 표를 `oracles.json`/`oracles.yaml`로 외부화하여, 신규 오라클 추가 시 코드 변경 없이 등록만 하도록 한다.

### 2.3 무료 공용 RPC 엔드포인트 (fallback 순회용)

체인별로 3~4개를 배열로 두고 순차 fallback. (실제 URL은 구현 시점에 확인 — 예: PublicNode, Ankr, drpc, LlamaRPC 등의 무료 엔드포인트.)

```yaml
rpc:
  ethereum: [ "<public_rpc_1>", "<public_rpc_2>", "<public_rpc_3>" ]
  base:     [ "<public_rpc_1>", "<public_rpc_2>", "<public_rpc_3>" ]
  monad:    [ "<public_rpc_1>", "<public_rpc_2>" ]
```

규칙: 한 엔드포인트가 실패/타임아웃/rate-limit이면 다음으로. 전부 실패하면 해당 오라클을 이번 실행에서 스킵하고 에러 로그(다음 cron이 재시도).

---

## 3. 최종 디렉터리 구조 (목표 형태)

```
chronicle-poa/
├─ README.md
├─ package.json
├─ config/
│  ├─ oracles.yaml          # 2.2 레지스트리
│  └─ rpc.yaml              # 2.3 RPC 엔드포인트
├─ src/
│  ├─ registry.ts           # 레지스트리 로더·파서
│  ├─ rpc.ts                # 멀티 RPC fallback 클라이언트 (viem)
│  ├─ collect_tier1.ts      # Tier-1 수집
│  ├─ normalize.ts          # canonical 매핑 + 검증등급
│  ├─ store_sheet.ts        # 구글 시트 write (멱등)
│  ├─ store_sqlite.ts       # SQLite write (Phase 2~)
│  ├─ decode_tier2.ts       # Tier-2 consumer 디코더 (Phase 2~)
│  ├─ analyze.ts            # 분석 배치 (Phase 3~)
│  ├─ alert.ts              # 알림 (Phase 3~)
│  └─ types.ts              # canonical 타입 정의
├─ scripts/
│  ├─ backfill.ts           # 초기 이력 백필 (eth_getLogs)
│  └─ verify_addresses.ts   # 주소 온체인 검증
├─ data/
│  └─ poa.sqlite            # (gitignore 또는 R2 동기화)
└─ .github/workflows/
   └─ daily.yml             # cron 워크플로
```

**기술 선택**: TypeScript + viem(온체인 read) + google-spreadsheet(시트) + better-sqlite3(SQLite). 실행 환경은 Node.js LTS, GitHub Actions `ubuntu-latest`.

---

## 4. Canonical 데이터 모델 (types.ts 에 반영)

```typescript
type Chain = "ethereum" | "base" | "monad";
type Freshness = "fresh" | "stale" | "expired";
type TrustGrade = "A" | "B" | "C";
type CustodyStatus = "verified" | "stale" | "failed" | "unknown";

interface AssetSnapshot {
  oracle_id: string;        // "securitize_buidl_eth"
  issuer: string;
  asset_ticker: string;
  chain: Chain;
  round_id: string;         // uint80 → 문자열 (정밀도 보존)
  observed_at: string;      // ISO8601, 온체인 updatedAt 기준
  ingested_at: string;      // ISO8601, 수집 시각
  // Tier-1
  nav: number | null;       // answer / 10**decimals
  raw_answer: string;       // 원천 int256 문자열
  decimals: number;
  // Tier-2 (Phase 2~, 없으면 null/빈 배열)
  aum: number | null;
  yield_7d: number | null;
  holdings: Holding[];
  custody_status: CustodyStatus;
  // 검증
  freshness: Freshness;     // observed_at 과 now 의 차이로 판정
  trust_grade: TrustGrade;
  source_address: string;   // 실제 read 한 adapter/router 주소
}

interface Holding {           // Phase 2~
  instrument_type: string;    // "treasury" | "repo" | "cash" | "clo" | ...
  identifier: string | null;  // CUSIP/ISIN 등
  units: number | null;
  price: number | null;
  market_value: number;
  maturity_date: string | null;
  weight_pct: number;         // 파생
}
```

**freshness 판정 규칙** (기본값, config로 조정 가능): `now - observed_at`
- ≤ 26h → `fresh` (일 1회 갱신 + 여유)
- ≤ 72h → `stale`
- \> 72h → `expired`

**trust_grade 판정 규칙** (초기 단순화):
- A: freshness=fresh 이고 answer > 0 이고 정상 응답
- B: freshness=stale
- C: freshness=expired 또는 값 이상(0/음수/디코딩 실패)

---

## 5. 개발 단계 (Phase별 상세)

각 Phase는 **목표 → 태스크 → 완료 기준(DoD) → 에이전트 지시 예시** 순으로 구성. DoD를 모두 만족하면 다음 Phase로.

---

### Phase 0 — 스캐폴딩 + 레지스트리 + RPC (반나절)

**목표**: 프로젝트 뼈대를 세우고, 레지스트리를 로드하고, 멀티 RPC fallback으로 아무 오라클 하나를 read 해본다.

**태스크**
1. `package.json` 초기화, TypeScript·viem·js-yaml 설치.
2. `config/oracles.yaml`에 2.2 표를 그대로 옮긴다.
3. `config/rpc.yaml`에 2.3 엔드포인트(플레이스홀더 → 실제 무료 RPC로 채움).
4. `src/registry.ts`: yaml을 읽어 `OracleEntry[]` 반환. `id` 명명규칙 파서 포함(`<issuer>_<ticker>_<chain>`).
5. `src/rpc.ts`: viem `createPublicClient` + 커스텀 transport로 배열 순회 fallback. `callWithFallback(chain, contract, abiFn, args)` 형태.
6. `scripts/verify_addresses.ts`: 전 레지스트리에 대해 `decimals()` 호출 시도 → 응답/무응답 리포트.

**완료 기준 (DoD)**
- [ ] `npx ts-node scripts/verify_addresses.ts` 실행 시, 각 오라클의 read 성공/실패가 테이블로 출력된다.
- [ ] 최소 1개 오라클(예: BUIDL Ethereum)에서 `decimals()`, `latestRoundData()`가 정상 값을 반환한다.
- [ ] 한 RPC를 일부러 잘못된 URL로 바꿔도 다음 fallback으로 성공한다.

**에이전트 지시 예시**
> "Phase 0을 구현해줘. 2.2의 레지스트리를 config/oracles.yaml로 만들고, viem으로 멀티 RPC fallback 클라이언트를 짜고, verify_addresses 스크립트로 전 오라클의 decimals() 응답을 확인하는 것까지. 실제 RPC URL은 무료 공용 엔드포인트로 채워줘."

> **⚠️ Phase 0에서 반드시 확인할 것 (미해결질문)**: Router/Adapter가 순수 오프체인 `eth_call`로 응답하는지, 아니면 whitelisting된 컨트랙트에서만 읽히는지. `latestRoundData()`가 revert 없이 값을 주면 오프체인 read로 충분(현재 가정). revert하면 → 이 경우에만 별도 대응 필요, 사용자에게 보고.

---

### Phase 1 — Tier-1 수집 + 정규화 + 구글 시트 저장 (1~2일)

**목표**: 전 오라클의 Tier-1 스칼라를 수집→정규화→구글 시트에 멱등 저장. 이 시점에 **시트가 곧 대시보드**가 된다.

**태스크**
1. `src/types.ts`: 4장 canonical 모델 정의.
2. `src/collect_tier1.ts`: 전 레지스트리 순회, 각 오라클에서 `latestRoundData()` + `decimals()` read → raw 결과 배열.
3. `src/normalize.ts`: raw → `AssetSnapshot`. `nav = answer / 10**decimals`, freshness·trust_grade 계산(4장 규칙).
4. `src/store_sheet.ts`: 구글 시트에 write. 서비스 계정 인증(GitHub Secrets). **멱등**: 쓰기 전 `(oracle_id, round_id)` 존재 조회 → 없을 때만 append.
   - 시트 구조: 헤더 1행 + 데이터 행. 컬럼 = AssetSnapshot 필드(holdings 제외, Tier-2는 나중).
5. `src/index.ts` 또는 `main.ts`: collect → normalize → store 파이프라인 오케스트레이션.

**완료 기준 (DoD)**
- [ ] `npm run collect` 1회 실행 시 전 오라클의 최신 스냅샷이 구글 시트에 한 행씩 추가된다.
- [ ] 같은 명령을 2번 실행해도 중복 행이 생기지 않는다(멱등 확인).
- [ ] NAV가 사람이 읽을 수 있는 값으로 스케일되어 있다(예: 1.0x 근처, raw int256이 아님).
- [ ] freshness·trust_grade 컬럼이 채워진다.
- [ ] 시트를 열면 자산별 최신 NAV·라운드·수집시각·등급이 한눈에 보인다.

**에이전트 지시 예시**
> "Phase 1을 구현해줘. 전 오라클의 Tier-1(latestRoundData)을 수집해서 canonical AssetSnapshot으로 정규화하고, 구글 시트에 멱등 저장하는 파이프라인. 멱등 키는 (oracle_id, round_id). 서비스 계정 인증은 환경변수로. 2번 돌려도 중복 안 생기는지 테스트도 넣어줘."

---

### Phase 2 — Tier-2 리치 디코더 + SQLite (2~4일, 자산별 반복)

**목표**: 우선 자산(BUIDL·USTB·JTRSY)의 holdings·yield 등 구조화 데이터를 디코딩하여 SQLite에 저장. **자산마다 스키마가 다르므로** 어댑터 플러그인 패턴으로.

**⚠️ 선행 작업 (에이전트가 코드 전에 할 것)**: 우선 자산의 **Router/consumer 컨트랙트를 Etherscan에서 확인**하여 실제 노출되는 read 함수와 반환 struct를 파악한다. Tier-2 필드·형식은 문서로 확정되어 있지 않고 오라클별로 다르다. 이 조사 결과를 `config/tier2/<oracle_id>.yaml`(매핑 정의)로 기록한 뒤 코드를 짠다.

**태스크**
1. 우선 자산별 consumer ABI·반환 struct 조사 → `config/tier2/<oracle_id>.yaml` 매핑 정의 작성.
2. `src/decode_tier2.ts`: 매핑 정의를 읽어 오라클별 read 함수 호출·struct 디코딩 → `Holding[]` + aum·yield.
   - 자산별 차이는 매핑 정의(YAML)로 흡수. 코드는 정의를 해석하는 제너릭 디코더.
3. `src/store_sqlite.ts`: better-sqlite3. 테이블 `snapshots`(Tier-1 미러) + `holdings`(1:N, FK=snapshot). roundId 멱등.
4. 단위·decimals 정규화, `weight_pct` 파생 계산.
5. 파이프라인에 Tier-2 단계 연결(있는 오라클만).

**완료 기준 (DoD)**
- [ ] 우선 자산 최소 1개(예: BUIDL)에서 holdings 배열이 SQLite에 저장된다.
- [ ] `SELECT`로 특정 스냅샷의 holdings를 조회하면 instrument_type·market_value·maturity가 나온다.
- [ ] weight_pct 합이 ~100%다(정규화 검증).
- [ ] Tier-2 게시가 없는 오라클은 에러 없이 Tier-1만 저장하고 넘어간다.
- [ ] 새 자산 추가가 매핑 YAML 작성만으로 되고 코드 수정이 없다.

**에이전트 지시 예시**
> "Phase 2를 BUIDL부터 구현해줘. 먼저 Securitize BUIDL Router(0x8c68…)를 Etherscan에서 확인해서 어떤 read 함수와 struct가 노출되는지 조사하고, 그 결과를 config/tier2/securitize_buidl_eth.yaml 매핑으로 정리한 다음, 그 정의를 해석해서 holdings를 SQLite에 저장하는 제너릭 디코더를 짜줘."

---

### Phase 3 — 분석 + 알림 (2~3일)

**목표**: 저장된 데이터로 평가·리스크·벤치마크 분석을 계산해 시트 요약탭/정적 JSON에 기록하고, 이상 시 알림.

**태스크**
1. `src/analyze.ts`:
   - **밸류에이션**: 보유수량 입력 시 NAV×수량 (수량은 별도 config, 없으면 NAV 추이만).
   - **리스크 분해**: holdings에서 만기 버킷 분포, WAM(가중평균만기), 자산유형 집중도.
   - **look-through**: 여러 오라클 holdings를 instrument 단위로 합산.
   - **벤치마크 스프레드**: 온체인 yield vs 외부 벤치마크(외부값은 수동 입력/무료 소스). 
   - **무결성 게이트**: freshness=expired 또는 custody=failed면 플래그.
2. 결과를 구글 시트 `summary` 탭 + `data/analysis.json`에 기록.
3. `src/alert.ts`: 조건(freshness 위반·custody 실패·교차검증 divergence) 발생 시 Slack/이메일 webhook. GitHub Actions에서 실패 step으로도 노출.

**완료 기준 (DoD)**
- [ ] summary 탭에 자산별 WAM·집중도·freshness 상태가 계산되어 나온다.
- [ ] look-through 국채 익스포저 합산값이 조회된다.
- [ ] 일부러 오래된 데이터를 넣으면 알림이 발화한다.
- [ ] analysis.json이 생성되어 정적 대시보드가 소비할 수 있다.

**에이전트 지시 예시**
> "Phase 3을 구현해줘. SQLite의 holdings로 WAM·만기버킷·집중도·look-through 합산을 계산해서 구글 시트 summary 탭과 analysis.json에 기록하고, freshness expired나 custody failed일 때 Slack webhook으로 알림을 보내는 것까지."

---

### Phase 4 — 자동화(cron) + 백필 + 정적 대시보드 (1~2일)

**목표**: 매일 자동 실행되게 하고, 초기 이력을 채우고, 무료 정적 대시보드를 띄운다.

**태스크**
1. `.github/workflows/daily.yml`: cron(1일 1회) → `npm run collect && npm run analyze`. Secrets로 시트 인증·webhook URL 주입. SQLite는 아티팩트/커밋 또는 R2 동기화.
2. `scripts/backfill.ts`: poke 이벤트를 `eth_getLogs`로 조회하여 과거 라운드 채움. **무료 RPC의 블록 범위 제한**(보통 ≤1만 블록)을 고려해 범위를 잘게 쪼개 반복. 멱등이라 여러 번 돌려도 안전.
3. 정적 대시보드: `analysis.json`을 fetch하는 단일 페이지(React/바닐라). Cloudflare Pages/GitHub Pages 무료 배포. 4패널(밸류에이션·리스크분해·무결성게이트·벤치마크).

**완료 기준 (DoD)**
- [ ] Actions가 스케줄대로 돌고, 수동 트리거(workflow_dispatch)도 된다.
- [ ] 백필 후 시트/SQLite에 과거 라운드가 채워진다.
- [ ] 무료 호스팅에 배포된 대시보드가 최신 데이터를 보여준다.
- [ ] 전체 파이프라인이 유료 리소스 0으로 동작한다(비용 원칙 최종 검증).

**에이전트 지시 예시**
> "Phase 4를 구현해줘. GitHub Actions 데일리 cron 워크플로, eth_getLogs 기반 백필 스크립트(무료 RPC 블록범위 제한 고려해 청크 분할), 그리고 analysis.json을 읽는 정적 대시보드를 Cloudflare Pages에 올리는 것까지."

---

## 6. 교차 관심사 (모든 Phase 공통)

- **에러 처리**: RPC 실패는 fallback→스킵→로그. 개별 오라클 실패가 전체 실행을 멈추지 않게(오라클별 try/catch).
- **로깅**: 오라클별 read 성공/실패, 스킵 사유, 저장 결과를 구조화 로그로.
- **시크릿**: 구글 서비스 계정 JSON·webhook URL은 GitHub Secrets. 절대 커밋 금지.
- **타입 안정성**: int256/uint80은 문자열/BigInt로 다뤄 정밀도 손실 방지. 표시용 스케일링만 number.
- **설정 외부화**: 오라클·RPC·freshness 임계는 전부 config. 코드 하드코딩 금지(2장 표는 config로).
- **테스트**: 최소한 정규화 로직(스케일링·freshness·grade)과 멱등 로직은 단위 테스트.

---

## 7. 리스크 및 유의사항 (구현 중 마주칠 것)

| 리스크 | 대응 |
|---|---|
| Router가 오프체인 read 거부(whitelisting) | Phase 0에서 즉시 확인. revert 시 사용자 보고 후 방안 재검토 |
| Tier-2 스키마가 자산마다 다름·비공지 변경 | 매핑 YAML로 흡수, 디코딩 실패 시 알림. 코드는 제너릭 유지 |
| 무료 RPC 불안정 | 다중 fallback + 다음 cron 재시도 |
| 시트 멱등 깨짐 | (oracle_id, round_id) 존재 조회 후 조건부 쓰기 |
| int256 정밀도 손실 | BigInt/문자열 보존, number는 표시용만 |
| 검증 경계 오해 | 분석 결과에 "attestation=전송 무결성이지 독립 회계감사 아님" 주석 |

---

## 8. 승격 경로 (지금은 구현 안 함, 문서로만)

이 데이터를 규제 맥락(K-ICS 자산 평가 근거 등)에 쓰는 시점에 저장·거버넌스 계층만 사내 Databricks Lakehouse(Unity Catalog)로 승격한다. 수집·스케줄러(GitHub Actions + viem)와 canonical 스키마는 그대로 재사용하므로, 마이그레이션은 `store_sheet`/`store_sqlite`를 `store_lakehouse`로 교체하는 수준. **그래서 처음부터 canonical 스키마(4장)를 엄격히 지키는 것이 중요.**

---

## 부록 A. 빠른 시작 (에이전트 온보딩)

새 세션에서 에이전트에게:
> "이 저장소는 chronicle_poa_build_spec.md 명세를 따라 만드는 중이야. 현재 Phase [N]까지 됐고, Phase [N+1]을 구현하려고 해. 명세의 해당 섹션을 읽고, DoD를 만족하도록 짜줘. 비용 0 원칙과 read-only 원칙은 반드시 지켜."

## 부록 B. 데이터 신뢰 경계 (분석·리포트에 항상 명시)

Chronicle Proof of Asset이 보장하는 것은 "커스터디언/관리자가 보고한 값이 조작 없이 온체인에 전달되었다"는 무결성이다. BUIDL처럼 custodian-direct 소싱은 발행사 self-report의 순환을 우회하지만, 그 자체가 감독당국이 인정하는 독립 회계감사는 아니다. 모든 분석 산출물에 이 경계를 데이터 등급과 함께 표기한다.
