# 운영 콘솔 v2 DB 적용 기록

2026-11-06 요청에 따라 `Bell7080/For-Garden-Admin` 최신 main `833f993`의
`supabase/migrations/20261119000000_ops_console_v2.sql`을 QA 검증 후 운영에 적용했다.
SQL 파일의 SHA-256은 `1ceb39ed2c15794fa8169ccb2f289d6ac31f0abbeeafcf03177f4fe76f9bfa99`다.

| 환경 | 프로젝트 | 원격 이력 version | name |
| --- | --- | --- | --- |
| QA | `rscxzfdnbdmftortrcqt` | `20261106145450` | `ops_console_v2` |
| 운영 | `udujahnlyhedlrfbaaow` | `20261106145704` | `ops_console_v2` |

원격 이력의 적용 시각은 원본 파일명과 다르다. 이름과 실제 스키마를 함께 확인해 중복 적용하지 않는다.

## 확인한 내용

- 적용 전 두 환경의 참조 표·열, `private.admin_can`·`audit`·`valid_rewards`를 확인했고 신규 표와 RPC는 없었다.
- 두 환경 모두 신규 표 2개 RLS, 접속 트리거 활성, 관리자 RPC 7개 존재와 권한을 확인했다. 비로그인 실행은 닫혀 있고 로그인 사용자는 각 함수 내부의 운영진 역할 검사를 통과해야 한다.
- 기존 계정의 마지막 KST 접속일 백필 누락 0건.
- QA 트랜잭션에서 같은 날 접속 중복 방지, 대시보드 14일 응답, FAQ 저장·조회·삭제, owner/operator/cs/viewer 및 일반 사용자 권한 제한을 확인하고 전부 롤백했다.
- 운영은 기존 소유자의 인증 역할 문맥으로 대시보드·운영진 목록의 읽기 호출을 실행해 성공을 확인했다. 개인정보는 검증 출력에 포함하지 않았다.
- `npm test`: 27개 통과. `npm run check`, `npm run build` 통과.
- 보안 advisor의 ERROR 0건. 신규 관리자 RPC의 `authenticated_security_definer_function_executable`과 FAQ 정책의 `auth_allow_anonymous_sign_ins` 경고는 역할 기반 RPC 설계에 따른 검토 항목이다. 실제 역할 검사를 QA에서 확인했으며, 일반 로그인 사용자는 FAQ를 읽거나 관리자 RPC를 실행할 수 없다. 관련 [SECURITY DEFINER 점검 안내](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [익명 로그인 정책 점검 안내](https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0012_auth_allow_anonymous_sign_ins).

## 운영 시 참고

- FAQ는 아직 0건이며 예시·임의 원고를 게시하지 않았다. 콘솔에서 원문과 필요한 언어 원고를 작성해 게시해야 홈페이지에 표시된다.
- 접속 기록은 기존 마지막 접속일 백필 외에는 적용 이후부터 수집한다. 과거 DAU·잔존율 전체가 복구되는 것은 아니다.
- 운영 역할 변경, 제재, 실제 보상 우편 발송은 수행하지 않았다.
- 브라우저의 관리자 로그인 이후 화면 조작은 이번 검증 범위에 포함하지 않았다. 운영 RPC는 실제 DB에서 검증했다.
- 결제·환불, 배너·푸시, 닉네임 강제 변경 등 다음 후보는 기존 계획대로 후속 범위다.
