# 2026-11-11 운영 DB 적용 완료

게임 main과 관리자 main `c5823fc`의 SQL 원본을 확인해, QA에 이미 적용된 8개 마이그레이션을 운영에도 순서대로 적용했다.
SQL 원본은 기존 QA 검증과 Git blob SHA가 모두 같고, QA SQL은 재실행하지 않았다.

| 순서 | 저장소 / 이름 | QA 실제 버전 | 운영 실제 버전 |
| --- | --- | --- | --- |
| 1 | Game / `ops_moderation` | `20261109084123` | `20261111021658` |
| 2 | Admin / `ops_console_v3` | `20261109084231` | `20261111021756` |
| 3 | Admin / `ops_console_v4` | `20261109084300` | `20261111021812` |
| 4 | Game / `game_events` | `20261109084531` | `20261111021825` |
| 5 | Admin / `ops_analytics` | `20261109084548` | `20261111021830` |
| 6 | Game / `live_schedule` | `20261109084602` | `20261111021840` |
| 7 | Admin / `ops_schedule` | `20261110071057` | `20261111021857` |
| 8 | Game / `launch_at` | `20261110071224` | `20261111021903` |

QA: `rscxzfdnbdmftortrcqt` / 운영: `udujahnlyhedlrfbaaow`.

- 양쪽 신규 표 10개 RLS 활성화, anon/authenticated 직접 접근 권한 위반 0건.
- 공개 설정·서버 일정 일치, 출시 시각 null 보존, 서버 전용 RPC와 관리자 RPC 권한 확인.
- 운영 소유자 역할 문맥에서 대시보드·분석·일정·이상 징후·결제 요약 조회 성공. 게임 수신함 필드도 확인했다.
- 어드민 테스트 44개, 문법 검사, 정적 빌드 통과.
- 보안 advisor ERROR 0건. 내부 표 RLS 정책 없음 안내, 역할 검사로 보호되는 SECURITY DEFINER RPC와 기존 인증 설정 경고는 남아 있다. [DB advisor 안내](https://supabase.com/docs/guides/database/database-linter).
- 실제 환불·보상 발송·계정/길드 조치·일정 변경·출시 초기화는 수행하지 않았다. 브라우저 로그인 이후 조작은 이번 검증 범위에 포함하지 않았다.

게임 저장소의 [상세 적용 기록](https://github.com/Bell7080/For-Garden/blob/main/docs/migrations-2026-11-11.md)에 원본 파일명·기존 검증과의 비교를 남겼다.
