import { inferServices } from '../../src/tools/alert-service-hints';

describe('alert-service-hints inferServices', () => {
  test('detects location from Korean dialog text', () => {
    expect(inferServices(["'지도' 앱이 사용자의 위치를 사용하도록 허용하겠습니까?"])).toEqual(['location']);
  });

  test('detects photos from English dialog text', () => {
    expect(inferServices(['Allow access to your Photos'])).toEqual(['photos']);
  });

  test('detects photos from Japanese dialog text', () => {
    expect(inferServices(['写真へのアクセスを許可しますか？'])).toEqual(['photos']);
  });

  test('detects multiple services when both appear in texts', () => {
    const result = inferServices(['Location and Photos access']);
    expect(result).toContain('location');
    expect(result).toContain('photos');
    expect(result.indexOf('location')).toBeLessThan(result.indexOf('photos'));
  });

  test('returns empty array for empty input', () => {
    expect(inferServices([])).toEqual([]);
  });

  test('returns empty array when no service matches', () => {
    expect(inferServices(['Welcome to the app'])).toEqual([]);
  });

  test('detects contacts', () => {
    expect(inferServices(['Access your contacts'])).toEqual(['contacts']);
  });

  test('detects notifications', () => {
    expect(inferServices(['Allow notifications from this app'])).toEqual(['notifications']);
  });

  test('detects camera', () => {
    expect(inferServices(['Allow camera access'])).toEqual(['camera']);
  });

  test('detects microphone', () => {
    expect(inferServices(['Microphone access required'])).toEqual(['microphone']);
  });

  test('detects bluetooth', () => {
    expect(inferServices(['Allow Bluetooth access'])).toEqual(['bluetooth']);
  });

  test('detects calendars', () => {
    expect(inferServices(['Access your calendars'])).toEqual(['calendars']);
  });

  test('detects reminders', () => {
    expect(inferServices(['Access your reminders'])).toEqual(['reminders']);
  });

  test('detects tracking', () => {
    expect(inferServices(['Allow tracking across apps'])).toEqual(['tracking']);
  });

  test('result contains no duplicates across multiple input strings', () => {
    const result = inferServices(['location access', '위치 정보 허용']);
    expect(result.filter(s => s === 'location').length).toBe(1);
  });

  test('order is deterministic — matches SERVICE_HINTS order', () => {
    // location (index 0) before photos (index 1) before contacts (index 2)
    const result = inferServices(['location, photos, contacts']);
    expect(result).toEqual(['location', 'photos', 'contacts']);
  });
});
