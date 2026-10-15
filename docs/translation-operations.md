# 공지 자동 번역 운영

고정 메뉴·안내 문구는 직접 번역한 사이트 카탈로그를 사용합니다. 공지는 원문을 한 번 작성하고 선택 언어의 번역문을 DB에 저장합니다. 방문자가 늘어도 저장된 번역을 읽을 때는 번역 API를 호출하지 않습니다. 향후 게시판은 게시글 데이터·권한을 별도로 구현한 뒤 같은 번역/캐시 모듈을 재사용합니다.

## 기본 서비스: Azure Translator F0

Azure Translator의 **F0 무료 리소스**를 사용합니다. 알려진 무료 한도는 월 200만 자이며 일일 한도가 아닙니다. 사용량은 원문의 번역 대상 글자 수와 목표 언어 수에 비례합니다. 원문 합계 1,000자 × 11개 언어면 약 11,000자입니다. 기본 보호 상한인 월 190만 자에서는 이런 공지를 약 170건 번역할 수 있습니다. 수정·재번역과 실패한 예약도 사용량에 영향을 줍니다.

F0를 Azure Portal에서 직접 선택해야 합니다. 코드는 `AZURE_TRANSLATOR_TIER=F0`라는 명시적 설정을 요구하지만 **이 문자열로 실제 Azure 요금제를 검사하거나 변경할 수는 없습니다**. F0 전용 리소스를 만들고 다른 애플리케이션과 키를 공유하지 않는 구성을 권장합니다. 일반 상용 서비스용 API이며 실제 계약·지역·가격·가입 조건은 계정 생성 화면과 현재 Azure 약관을 확인하세요. 유료 S1 리소스로 대체하지 않습니다.

공식 자료: [가격표](https://azure.microsoft.com/pricing/details/cognitive-services/translator/), [리소스 만들기](https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation), [Microsoft 공식 REST 예제](https://github.com/MicrosoftTranslator/Text-Translation-API-V3-NodeJS). 이 환경에서는 가격표 접속이 제한되어 현행 가격 페이지를 직접 읽지 못했고, 공식 GitHub 예제에서 REST 인증 형식은 확인했습니다.

지원 목록은 게임과 같은 한국어 포함 12개입니다: ko, en, ja, zh-Hant, zh-Hans, th, vi, id, es, pt-BR, de, ru. 원문은 이 중 어느 언어여도 됩니다. Azure에는 브라질 포르투갈어를 `pt`로 매핑하고 결과는 `pt-BR`로 저장합니다. 중국어 간체/번체는 서로 다른 코드로 유지합니다.

## 활성화 순서

1. 홈페이지 기본 스키마와 게임의 `20261015180000_notice_admin.sql`이 적용된 Supabase 프로젝트에서 `20261016090000_notice_translation.sql`을 한 번 적용합니다. 현재 어드민에서 save_website_notice와 자동 번역 테이블이 404라면 이 단계가 아직 준비되지 않은 상태입니다.
2. 같은 프로젝트에 `20261016210000_translation_budget.sql`을 한 번 적용합니다. Web와 Admin 양쪽 폴더의 파일은 동일한 사본이므로 프로젝트당 각각 한 번만 적용합니다.
3. Azure Portal에서 Translator 리소스를 만들 때 **F0 무료 요금제**를 선택하고 키·리전을 확인합니다. 별도의 자체 번역 서버는 필요 없습니다.
4. **Web와 Admin 두 Vercel 프로젝트**의 서버 환경 변수에 아래 값을 넣고 재배포합니다. 키는 채팅·Git·VITE_ 변수에 넣지 않습니다.

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only Supabase key>
TRANSLATION_PROVIDER=azure
AZURE_TRANSLATOR_KEY=<server-only F0 resource key>
AZURE_TRANSLATOR_TIER=F0
AZURE_TRANSLATOR_REGION=<resource region; global resource can leave blank>
AZURE_TRANSLATOR_MONTHLY_LIMIT=1900000
```

기본 엔드포인트는 `https://api.cognitive.microsofttranslator.com`입니다. 필요하면 리소스에서 제공한 Microsoft HTTPS 주소를 `AZURE_TRANSLATOR_ENDPOINT`로 지정합니다.

5. 어드민을 새로고침해 DB 기능을 다시 확인하고 원문만 작성한 공지를 저장합니다. 원문·게시 설정·직접 쓴 번역은 하나의 RPC 트랜잭션으로 저장합니다. 다른 창에서 수정한 원고는 `stale_notice`로 덮어쓰기를 막습니다.
6. 저장 뒤 번역은 두 언어씩 준비합니다. 화면을 닫으면 남은 모든 작업이 완료된다고 보장하지 않으므로 현황을 확인합니다. 빠진 번역은 독자가 그 언어로 글을 열 때 생성·저장합니다. 이미 준비된 번역에는 API나 문자 사용량 예약이 발생하지 않습니다.

## 저장과 무료 한도 보호

- 수동 번역(`website_notice_translations`)이 자동 번역(`website_notice_auto_translations`)보다 우선합니다. 자동 결과가 수동 원고를 덮어쓰지 않습니다.
- 원문 언어·제목·요약·본문의 SHA-256을 함께 저장합니다. 원문이 바뀌면 낡은 자동 번역을 표시하지 않고 다음 저장/열람에서 다시 생성합니다. 변경되지 않은 글은 새 방문·언어 재선택·브라우저 새로고침에 의해 재번역되지 않습니다.
- 실제 Azure 요청 **직전**에 Supabase의 `reserve_translation_characters`로 문자 수를 원자적으로 예약합니다. 두 Vercel 프로젝트가 하나의 월별 카운터를 공유하므로 동시 요청으로 무료 보호 상한을 넘기지 않습니다. 기본 190만 자, 설정 최대 200만 자입니다. 보호 RPC가 없거나 실패하면 Azure를 호출하지 않습니다.
- 카운터는 UTC 월별 버킷으로 자동 갱신됩니다. 실패한 요청의 예약도 되돌리지 않는 보수적인 계산이며, 대리쌍을 포함한 문자열은 UTF-16 길이로 여유 있게 기록합니다. 실제 Azure 서비스의 사용량은 Azure Portal에서 확인합니다. 이 앱 밖에서 동일 키를 사용한 양은 이 DB 카운터가 알 수 없습니다.
- 인스턴스 내 중복 요청을 합치고 Postgres lease로 인스턴스 간 생성도 조정합니다. 서비스 전체 동시 번역은 4건입니다.
- 이미지 URL·마크다운 구조·빈 줄은 보존하고 본문 텍스트만 번역합니다. 긴 글은 요청 한도 안에서 나누고 대리쌍을 자르지 않습니다. 결과 타입·개수·길이를 검사하고 HTML로 신뢰하지 않습니다.
- 무료 한도·일시적 호출 제한·키/리전 오류·설정 누락은 구분해서 표시합니다. 공지 저장은 유지하고 나머지 일괄 번역은 중단합니다. 기존 번역 또는 원문은 계속 읽을 수 있습니다. 설정을 고친 뒤 어드민을 새로고침합니다.

## 권한과 기존 DB 호환

공개 API는 공지 slug와 언어만 받습니다. 임의 텍스트·외부 URL·임시저장·미래 예약 공지를 외부 API에 전달할 수 없습니다. 어드민 API는 Supabase 사용자 검증과 owner/operator 역할 검증을 거치며 cs/viewer는 읽기 전용입니다. 서비스 키와 Azure 키는 서버 함수에서만 사용합니다.

DB에 새 RPC가 없으면 정확한 PGRST202 오류일 때만 기존 한·영·일 저장 방식을 유지합니다. 이 방식은 원자적 저장·동시 편집 보호를 제공하지 않으므로 제한을 화면에 표시합니다. 새 공지는 원문을 저장한 다음 공개합니다. 신규 언어는 마이그레이션 적용 후 저장할 수 있습니다. 누락된 DB 기능은 페이지당 한 번 탐지하고 반복 조회나 번역 요청을 시작하지 않습니다.

## 선택 사항: 자체 번역 서버

이전 LibreTranslate 연결도 유지합니다. `TRANSLATION_PROVIDER=libretranslate`, `TRANSLATION_API_URL=https://your-engine/`, 선택적으로 `TRANSLATION_API_KEY`와 `TRANSLATION_LANGUAGE_MAP`을 설정합니다. Azure 키를 자동으로 사용하지 않습니다. AGPL 소프트웨어·모델 라이선스·서버 비용·실제 지원 언어 쌍을 따로 확인해야 합니다. 공개 무료 인스턴스를 무제한 상업용 API로 간주하지 않습니다.

## 검증 범위

실제 Azure 키·Supabase 쓰기 바인딩이 현재 클라우드에는 없습니다. REST 요청·캐시 재사용·11개 언어 매핑·문자 상한 차단은 모의 API로, 트랜잭션·월별 예약 RPC는 Postgres WASM 엔진으로 검사했습니다. 실제 운영 DB 마이그레이션, Azure 과금 등급, 실서비스 번역 성공은 설정 후 확인해야 합니다. 스텔라 사이트가 어떤 번역 사업자를 사용하는지는 확인하지 못했습니다.
