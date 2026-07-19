import { describe, expect, it } from 'vitest';
import type { ApiActionContext } from '../src/api-handler';
import { actions } from '../src/actions/friend';

const getStrangerInfo = actions.find((action) => action.names[0] === 'get_stranger_info');
if (!getStrangerInfo) throw new Error('get_stranger_info action missing');

describe('get_stranger_info action', () => {
  it('returns an empty long_nick when no profile provider is available', async () => {
    const response = await getStrangerInfo.toHandler({} as ApiActionContext)({ user_id: 123456 });

    expect(response).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: {
        user_id: 123456,
        nickname: '',
        sex: 'unknown',
        age: 0,
        long_nick: '',
      },
    });
  });

  it('documents long_nick as a required string response field', () => {
    const schema = getStrangerInfo.describe().returnsSchema;

    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        long_nick: { type: 'string', description: '个性签名' },
      },
    });
    expect(schema?.required).toContain('long_nick');
  });
});
