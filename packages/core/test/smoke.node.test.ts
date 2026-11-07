/**
 * 工具链冒烟测试：验证 Node 22 的 TypeScript type stripping + node:test 直跑。
 * 这不是业务测试，真实单测在后续阶段加入，可以删除本文件。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE_SCHEMA_VERSION } from '../src/index.ts';

interface SmokeCase {
  readonly name: string;
  readonly actual: number;
  readonly expected: number;
}

const cases: readonly SmokeCase[] = [
  { name: '2+2', actual: 2 + 2, expected: 4 },
  { name: 'schema_version', actual: CORE_SCHEMA_VERSION, expected: 1 },
];

for (const item of cases) {
  test(`smoke: ${item.name}`, () => {
    assert.equal(item.actual, item.expected);
  });
}

test('smoke: interface-only type is stripped, runtime unaffected', () => {
  const value: SmokeCase = { name: 'literal', actual: 1, expected: 1 };
  assert.equal(value.actual, value.expected);
});
