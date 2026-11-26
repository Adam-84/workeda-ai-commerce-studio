import test from 'node:test';
import assert from 'node:assert/strict';
import { automationCenter } from '../public/automation-ui.js';

// Exercise the controller through the UI adapter used by the application.
function element(tagName, attrs = {}, ...children) {
  return { tagName, ...attrs, children: children.flat(Infinity).filter(Boolean),
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this[name] = value; } };
}
const find = (el, predicate) => predicate(el) ? el : el.children?.filter((n) => typeof n === 'object').map((n) => find(n, predicate)).find(Boolean);

test('AI waits can be explicitly reconsidered even when the engine is not paused', async (t) => {
  const previous = globalThis.confirm; globalThis.confirm = () => true;
  t.after(() => { if (previous === undefined) delete globalThis.confirm; else globalThis.confirm = previous; });
  const sent = [];
  const root = automationCenter({ ui: { h: element, announce() {},
    get: async () => ({ status: { owner: true, paused: false, aiPaused: false }, rules: [], agents: [], templates: [], events: [] }),
    send: async (...args) => { sent.push(args); } } });
  await new Promise(setImmediate);
  const resume = find(root, (el) => el.tagName === 'button' && el.children.includes('Réexaminer les attentes IA'));
  assert.ok(resume, 'quota and concurrency waits need a recovery control without an engine error');
  await resume.onclick();
  assert.deepEqual(sent, [['POST', '/api/automations/ai-resume', { confirm: true }]]);
});
