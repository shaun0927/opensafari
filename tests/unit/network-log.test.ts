import { shouldCaptureBody } from '../../src/tools/network-log';

describe('network-log', () => {
  describe('shouldCaptureBody', () => {
    it('captures text/html', () => {
      expect(shouldCaptureBody('text/html')).toBe(true);
    });
    it('captures text/plain', () => {
      expect(shouldCaptureBody('text/plain')).toBe(true);
    });
    it('captures text/css', () => {
      expect(shouldCaptureBody('text/css')).toBe(true);
    });
    it('captures application/json', () => {
      expect(shouldCaptureBody('application/json')).toBe(true);
    });
    it('captures application/json with charset', () => {
      expect(shouldCaptureBody('application/json; charset=utf-8')).toBe(true);
    });
    it('rejects image/png', () => {
      expect(shouldCaptureBody('image/png')).toBe(false);
    });
    it('rejects application/octet-stream', () => {
      expect(shouldCaptureBody('application/octet-stream')).toBe(false);
    });
    it('rejects video/mp4', () => {
      expect(shouldCaptureBody('video/mp4')).toBe(false);
    });
    it('rejects empty string', () => {
      expect(shouldCaptureBody('')).toBe(false);
    });
  });
});
