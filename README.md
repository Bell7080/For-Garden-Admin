# For-Garden Admin

포가든 백엔드(Supabase)를 다루는 어드민 사이트. 빌드 없이 `index.html` + `admin.css` + `admin.js`로 돈다.

## 기능
- 로그인(이메일/비밀번호) 후 `admin_roles` 역할 확인. `owner`·`operator`는 쓰기, `cs`·`viewer`는 읽기 전용.
- **공지 관리**: 목록(분류·상태·검색), 새 글/복제/수정/삭제, 템플릿(일반·업데이트·이벤트), 한·영·일 탭, 표지 이미지, 상단 고정.
- **미리보기**: 누르기 전 목록 줄과 눌러서 뜨는 팝업을 편집하면서 나란히 본다.
- **이미지 고르기**: 직접 올리기(Storage `notice-images`), 포가든 원본(배경·콘텐츠·아이템·재화, `catalog.json`), 홈페이지용 렐릭 원화(`catalog/web`). 전신·SD는 Puppet ZIP이라 아직 가져올 수 없다.
- 본문 서식: 빈 줄로 문단을 나누고, `![설명](https://…)` 한 줄은 이미지가 된다(https만).

## 어드민 계정 추가
Supabase 대시보드 Authentication에서 사용자를 만든 뒤 SQL로 역할을 준다.
`insert into admin_roles(user_id, role) values ('<uid>', 'operator');`

## 스키마
원본은 게임 저장소 `supabase/migrations`. 이 사이트가 쓰는 것은 `20261015180000_notice_admin.sql`까지.
