// 정기 우편 구분별 기본값과 시간대 겹침 판정. 어드민 화면과 테스트가 같은 표를 읽는다.
//
// 식사 시간대는 모바일 게임의 통상 「식사 보급」 창을 따른다(한국 시간).
//   아침 07:00~10:00 · 점심 12:00~14:00 · 저녁 18:00~21:00 · 핫타임 21:00~23:00
// 창 사이에 빈 시간을 두어 한 우편이 다음 우편과 함께 받을 수 있는 상태로 남지 않게 한다.
// 예전 기본값(08·12·18시 + 6시간)은 아침이 14시까지 남아 점심(12시~)과 두 시간 겹쳤다.
export const SLOTS = {
  morning: { label: "아침", time: "07:00", name: "아침 푸시", title: "아침 식사 보급", body: "좋은 아침입니다! 든든한 아침 식사 보급품이 도착했어요.", hours: "3" },
  lunch: { label: "점심", time: "12:00", name: "점심 푸시", title: "점심 식사 보급", body: "점심 시간이에요! 잠깐 쉬어 가세요. 보급품이 도착했습니다.", hours: "2" },
  evening: { label: "저녁", time: "18:00", name: "저녁 푸시", title: "저녁 식사 보급", body: "하루 수고하셨습니다. 저녁 식사 보급품이 도착했어요.", hours: "3" },
  hottime: { label: "핫타임", time: "21:00", name: "핫타임 푸시", title: "핫타임 보상", body: "지금은 핫타임! 제한 시간 안에 받아 가세요.", hours: "2" },
  custom: { label: "기타", time: "09:00", name: "정기 우편", title: "", body: "", hours: "24" },
};

const minutes = (t) => {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
};

// 한 주(월요일 0시부터 분)를 기준으로, 발송 요일마다 [시작, 끝) 구간을 낸다. 보관 기간이 없으면 무제한.
function windows(mail) {
  const start = minutes(String(mail.send_time).slice(0, 5));
  const len = mail.valid_hours == null || mail.valid_hours === "" ? Infinity : Number(mail.valid_hours) * 60;
  return (mail.days || [1, 2, 3, 4, 5, 6, 7]).map((d) => [(d - 1) * 1440 + start, (d - 1) * 1440 + start + len]);
}

const WEEK = 7 * 1440;
const hit = ([a1, a2], [b1, b2]) => a1 < b2 && b1 < a2;

// 두 정기 우편이 동시에 받을 수 있는 상태로 남는 구간이 있는지. 주가 넘어가는 경우(일요일 밤 → 월요일)도 본다.
export function recurringOverlap(a, b) {
  for (const wa of windows(a))
    for (const wb of windows(b))
      for (const shift of [-WEEK, 0, WEEK]) if (hit(wa, [wb[0] + shift, wb[1] + shift])) return true;
  return false;
}
