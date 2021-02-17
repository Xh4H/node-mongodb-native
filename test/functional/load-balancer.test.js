'use strict';
const { loadSpecTests } = require('../spec/index');
const { runUnifiedTest } = require('./unified-spec-runner/runner');
const { expect } = require('chai');

describe('Load Balancer Spec Unified Tests', function () {
  for (const loadBalancerTest of loadSpecTests('load-balancers')) {
    expect(loadBalancerTest).to.exist;
    context(String(loadBalancerTest.description), function () {
      for (const test of loadBalancerTest.tests) {
        it(String(test.description), {
          metadata: { sessions: { skipLeakTests: true } },
          test: async function () {
            await runUnifiedTest(this, loadBalancerTest, test);
          }
        });
      }
    });
  }
});
