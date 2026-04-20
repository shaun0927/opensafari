export type PermissionService =
  | 'location'
  | 'photos'
  | 'contacts'
  | 'notifications'
  | 'tracking'
  | 'camera'
  | 'microphone'
  | 'bluetooth'
  | 'calendars'
  | 'reminders';

export interface ServiceHint {
  regex: RegExp;
  service: PermissionService;
}

export const SERVICE_HINTS: ServiceHint[] = [
  { regex: /위치|\blocation\b|位置|位置情報/iu, service: 'location' },
  { regex: /사진|\bphoto(s)?\b|写真|照片/iu, service: 'photos' },
  { regex: /연락처|\bcontact(s)?\b|連絡先|联系人/iu, service: 'contacts' },
  { regex: /알림|\bnotification(s)?\b|通知/iu, service: 'notifications' },
  { regex: /추적|\btracking\b|トラッキング|跟踪/iu, service: 'tracking' },
  { regex: /카메라|\bcamera\b|カメラ|相机/iu, service: 'camera' },
  { regex: /마이크|\bmicrophone\b|マイク|麦克风/iu, service: 'microphone' },
  { regex: /블루투스|\bbluetooth\b|Bluetooth|蓝牙/iu, service: 'bluetooth' },
  { regex: /캘린더|\bcalendar(s)?\b|カレンダー|日历/iu, service: 'calendars' },
  { regex: /미리 알림|\breminder(s)?\b|リマインダー|提醒事项/iu, service: 'reminders' },
];

export function inferServices(texts: string[]): PermissionService[] {
  const seen = new Set<PermissionService>();
  const result: PermissionService[] = [];
  const combined = texts.join(' ');
  for (const hint of SERVICE_HINTS) {
    if (!seen.has(hint.service) && hint.regex.test(combined)) {
      seen.add(hint.service);
      result.push(hint.service);
    }
  }
  return result;
}
