# For-Garden-Admin
포가든 관리자 페이지 웹사이트

## 현재 상태 (뼈대)
- `index.html` 한 장: 이메일/비밀번호 로그인 → `is_admin()` 확인 → 역할(`admin_roles`)과 백엔드 서버 시각 표시.
- 공개(publishable) 키만 사용한다. `service_role` 키는 이 저장소에 넣지 않는다. 토큰은 메모리에만 둔다.
- DB 스키마 원본은 게임 저장소 `For-Garden/supabase/`. 현재 연결: 테스트 프로젝트 `forgarden-test`.
- 관리자 만들기: Supabase 대시보드 Authentication에서 사용자를 만든 뒤 SQL로 역할을 준다.
  `insert into public.admin_roles (user_id, role) select id, 'owner' from auth.users where email = '<이메일>';`
- 프레임워크는 아직 정하지 않았다(정적 페이지).
