import {
  ConnectionError,
  TimeoutError,
  ProtocolError,
  EvaluationError,
} from '../../src/webkit/errors';

describe('webkit error classes', () => {
  describe('ConnectionError', () => {
    it('is an instance of Error', () => {
      const err = new ConnectionError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ConnectionError);
    });

    it('preserves message and name', () => {
      const err = new ConnectionError('conn failed');
      expect(err.message).toBe('conn failed');
      expect(err.name).toBe('ConnectionError');
    });
  });

  describe('TimeoutError', () => {
    it('is an instance of Error', () => {
      const err = new TimeoutError('timed out');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(TimeoutError);
    });

    it('preserves message and name', () => {
      const err = new TimeoutError('op timed out after 5000ms');
      expect(err.message).toBe('op timed out after 5000ms');
      expect(err.name).toBe('TimeoutError');
    });
  });

  describe('ProtocolError', () => {
    it('is an instance of Error', () => {
      const err = new ProtocolError('method not found', -32601);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ProtocolError);
    });

    it('preserves message, name, and code', () => {
      const err = new ProtocolError('method not found', -32601);
      expect(err.message).toBe('method not found');
      expect(err.name).toBe('ProtocolError');
      expect(err.code).toBe(-32601);
    });

    it('accepts undefined code', () => {
      const err = new ProtocolError('no code');
      expect(err.code).toBeUndefined();
    });
  });

  describe('EvaluationError', () => {
    it('is an instance of Error', () => {
      const err = new EvaluationError('eval failed');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EvaluationError);
    });

    it('preserves message and name', () => {
      const err = new EvaluationError('Promise rejected');
      expect(err.message).toBe('Promise rejected');
      expect(err.name).toBe('EvaluationError');
    });
  });

  describe('re-exports from client and index', () => {
    it('errors are accessible from src/webkit/index', async () => {
      const mod = await import('../../src/webkit/index');
      expect(mod.ConnectionError).toBe(ConnectionError);
      expect(mod.TimeoutError).toBe(TimeoutError);
      expect(mod.ProtocolError).toBe(ProtocolError);
      expect(mod.EvaluationError).toBe(EvaluationError);
    });

    it('errors are accessible from src/webkit/client', async () => {
      const mod = await import('../../src/webkit/client');
      expect(mod.ConnectionError).toBe(ConnectionError);
      expect(mod.TimeoutError).toBe(TimeoutError);
      expect(mod.ProtocolError).toBe(ProtocolError);
      expect(mod.EvaluationError).toBe(EvaluationError);
    });
  });
});
