const { testSuite } = require('../bot');

describe('Status Bot', () => {
  beforeAll(async () => {
    await testSuite.initialize();
  });

  test('Database connection', async () => {
    await expect(testSuite.checkDatabase()).resolves.toBe(true);
  });

  test('Status check workflow', async () => {
    const result = await testSuite.simulateStatusCheck();
    expect(result.checksPerformed).toBeGreaterThan(0);
  });
});
