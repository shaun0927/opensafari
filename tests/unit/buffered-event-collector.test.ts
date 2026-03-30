import { BufferedEventCollector } from '../../src/utils/buffered-event-collector';

describe('BufferedEventCollector', () => {
  test('push ignored when not collecting', () => {
    const c = new BufferedEventCollector(5);
    c.push({ timestamp: 1 });
    expect(c.size).toBe(0);
  });
  test('collects and auto-rotates', () => {
    const c = new BufferedEventCollector(3);
    c.start();
    for (let i = 1; i <= 5; i++) c.push({ timestamp: i });
    expect(c.size).toBe(3);
    expect(c.get()[0].timestamp).toBe(3);
  });
  test('get returns copy', () => {
    const c = new BufferedEventCollector();
    c.start();
    c.push({ timestamp: 1 });
    c.get().push({ timestamp: 2 });
    expect(c.size).toBe(1);
  });
  test('clear and stop work', () => {
    const c = new BufferedEventCollector();
    c.start();
    c.push({ timestamp: 1 });
    c.stop();
    c.push({ timestamp: 2 });
    expect(c.size).toBe(1);
    c.clear();
    expect(c.size).toBe(0);
  });
  test('default maxSize is 500', () => {
    const c = new BufferedEventCollector();
    c.start();
    for (let i = 0; i < 600; i++) c.push({ timestamp: i });
    expect(c.size).toBe(500);
  });
});
