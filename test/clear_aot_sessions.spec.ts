/* eslint-disable @typescript-eslint/no-require-imports -- tested module is a CommonJS CLI helper */
const {
  AOT_TITLE_ID,
  clearAotSessions,
  getMongoUri,
} = require('../clear_aot_sessions');

describe('clear_aot_sessions', () => {
  it('requires the same MONGO_URI setting used by XWS', () => {
    expect(getMongoUri({ MONGO_URI: 'mongodb://example/xenia' })).toBe(
      'mongodb://example/xenia',
    );
    expect(() => getMongoUri({})).toThrow('MONGO_URI is undefined!');
  });

  it('uses the URI-selected database and clears only Army of Two sessions', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 2 });
    const collection = jest.fn().mockReturnValue({ deleteMany });
    const db = jest.fn().mockReturnValue({ collection });
    const close = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue({ db, close });
    const log = jest.fn();

    await expect(
      clearAotSessions({
        mongoClient: { connect },
        mongoUri: 'mongodb://example/xenia',
        log,
      }),
    ).resolves.toBe(2);

    expect(connect).toHaveBeenCalledWith('mongodb://example/xenia');
    expect(db).toHaveBeenCalledWith();
    expect(collection).toHaveBeenCalledWith('sessions');
    expect(deleteMany).toHaveBeenCalledWith({ titleId: AOT_TITLE_ID });
    expect(close).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('deleted 454108D8 sessions:', 2);
  });

  it('closes the client when deletion fails', async () => {
    const failure = new Error('delete failed');
    const deleteMany = jest.fn().mockRejectedValue(failure);
    const collection = jest.fn().mockReturnValue({ deleteMany });
    const db = jest.fn().mockReturnValue({ collection });
    const close = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue({ db, close });

    await expect(
      clearAotSessions({
        mongoClient: { connect },
        mongoUri: 'mongodb://example/xenia',
        log: jest.fn(),
      }),
    ).rejects.toThrow('delete failed');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
