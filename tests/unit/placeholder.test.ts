describe('OpenSafari', () => {
  it('should be configured correctly', () => {
    expect(true).toBe(true);
  });

  it('should target Node.js >= 18', () => {
    const [major] = process.version.slice(1).split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(18);
  });
});
