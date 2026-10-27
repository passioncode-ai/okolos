// Every action a person has, its agent tool and who decides it: fabric-actions/0.1, the extension keyed
// extensions/actions/0.1 (DEC-0121, FAC-SEM-142). Part of the Node service kit (layer L3); the twin of fabric_actions.py.
//
// - actionDecision(inputs): whether a service takes a call of one declared action and as whose act it records it,
//   exactly as the contract's actionDecision answers (AP-2, AP-4; DL-17, DL-18, DL-25). A `fault` is the service's
//   own and is never sent to a caller.
// - decisionShape(value): a decision as decision.schema.json reads it, `at` read strictly (the contract's strictTime).
// - actionsView(wellKnown): the host reader of the declaration, as the contract's actionsView.
// - actionsExtensionRules(wellKnown), actionRules(kind, value): FAC-SEM-142.
// - actionsExtension(actions, { capabilities }): the `extensions` entry a service declares; it refuses a declaration
//   FAC-SEM-142 would find, so a service never publishes one.
// - operatorDecision({action, instruction, at, target, source}): the decision an agent relays in _meta.decision (AP-2,
//   AP-3), refused when decision.schema.json would refuse it.
// - actionCaller(tier, authenticated): the caller a service records (AP-2): the identity it authenticated, else
//   local:T0 / local:T1 for a caller its local floor authenticated, never a name the call carries.
// - DEC-0125: actionDecision reads a call's mandate (_meta.mandate) through fabric-mandate.mjs's mandateCovers when the
//   call carries no decision.
// - DEC-0126: a decision may carry `source` (where the operator said the words, OA-2); actionDecision returns it in
//   recordAs (OA-6). A service that reads it lists operator-source/1 and keeps it, as `instruction`, in its own audit
//   record only: never an event, a usage report, a log line or a page another party reads (OA-7).
//
// The kit has no JSON Schema validator: the two shapes are written here from the schemas, lengths in code points and
// patterns over the whole string, as the contract's validator reads them. Members are an object's own members (a JSON
// text has no other kind; an inherited member is not read). Never throws on what it reads. Node 20+, no dependency.
import { ServiceError } from './fabric-base.mjs';
import { isObject, jsonEqual } from './fabric-jsvalue.mjs';
import { mandateCovers, sourceShape } from './fabric-mandate.mjs'; // DEC-0125, DEC-0126
import { formatRfc3339, parseRfc3339Ms } from './fabric-time.mjs';

export const ACTIONS_EXTENSION_KEY = 'https://fabric.passioncode.ai/agent-contract/extensions/actions/0.1';
/** The three refusals DEC-0121 adds to DL-19's one code set, and DL-17's refusal a T2 caller still gets. */
export const OPERATOR_DECISION_REQUIRED = 'operator-decision-required';
export const DECISION_INVALID = 'decision-invalid';
export const HUMAN_STEP_REQUIRED = 'human-step-required';
export const APPROVAL_REQUIRED = 'approval-required';
export const GATES = Object.freeze(['none', 'relayed', 'human']);
export const HUMAN_STEPS = Object.freeze(['sign-in', 'consent', 'payment', 'secret', 'spend-above-limit', 'passkey']);
export const MAX_ACTIONS = 128;
/** How far ahead of the service's clock a decision's `at` may be (the contract's CLOCK_SKEW_SECONDS). */
export const CLOCK_SKEW_SECONDS = 60;
/** How long after the operator decided a relayed decision still stands: approval/1's lifetime (DL-17, FAC-SEM-051). */
export const DECISION_LIFETIME_SECONDS = 24 * 60 * 60;

const REQUEST_KEY = /^[A-Za-z0-9_.-]{1,64}$/u; // interop-common.schema.json#/$defs/requestKey
const CAPABILITY = /^[a-z][a-z0-9._-]{1,127}$/u; // common.schema.json#/$defs/capabilityName
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const STEP_URL = /^(https:\/\/|\/)/;
const ACTION_MEMBERS = new Set(['id', 'title', 'tool', 'gate', 'humanStep']);
const DECISION_MEMBERS = new Set(['by', 'via', 'action', 'target', 'instruction', 'at', 'source']);
const KEY_PATH = `/extensions/${ACTIONS_EXTENSION_KEY.replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** An own member that is not undefined, as the validator reads a member as present. */
const has = (value, key) => Object.hasOwn(value, key) && value[key] !== undefined;
/** An own member, or undefined. */
const member = (value, key) => (isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined);
/** The number of code points, as the validator counts a string's length (a surrogate pair is one). */
const codePoints = (value) => {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
};
const text = (value, low, high) => typeof value === 'string' && value.length <= high * 2 && codePoints(value) >= low && codePoints(value) <= high;
const matches = (pattern, value, high) => typeof value === 'string' && value.length <= high && pattern.test(value);
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
const oneOf = (value, choices) => typeof value === 'string' && choices.includes(value);

/** service-actions-extension.schema.json#/$defs/action: the errors at `at`, empty for a valid entry. */
function actionErrors(value, at) {
  if (!isObject(value)) return [`${at} type`];
  const errors = Object.keys(value).filter((key) => !ACTION_MEMBERS.has(key)).map((key) => `${at}/${key} additionalProperties`);
  for (const key of ['id', 'title', 'tool', 'gate']) if (!has(value, key)) errors.push(`${at} required ${key}`);
  if (has(value, 'id') && !matches(REQUEST_KEY, value.id, 64)) errors.push(`${at}/id pattern`);
  if (has(value, 'title') && !text(value.title, 1, 80)) errors.push(`${at}/title maxLength`);
  if (has(value, 'tool') && !matches(CAPABILITY, value.tool, 128)) errors.push(`${at}/tool pattern`);
  if (has(value, 'gate') && !oneOf(value.gate, GATES)) errors.push(`${at}/gate enum`);
  if (has(value, 'humanStep') && !oneOf(value.humanStep, HUMAN_STEPS)) errors.push(`${at}/humanStep enum`);
  return errors;
}

/** service-actions-extension.schema.json: the errors, empty for a valid declaration. */
function extensionErrors(value) {
  if (!isObject(value)) return ['/ type'];
  const errors = Object.keys(value).filter((key) => key !== 'actions').map((key) => `/${key} additionalProperties`);
  if (!has(value, 'actions')) return [...errors, '/ required actions'];
  const { actions } = value;
  if (!Array.isArray(actions)) return [...errors, '/actions type'];
  if (actions.length < 1 || actions.length > MAX_ACTIONS) errors.push(`/actions ${actions.length ? 'maxItems' : 'minItems'}`);
  actions.forEach((action, index) => errors.push(...actionErrors(action, `/actions/${index}`)));
  return errors;
}

/** One valid actions[] entry whose humanStep is present exactly when gate is human. */
export const readableAction = (action) => actionErrors(action, '').length === 0 && (action.gate === 'human') === has(action, 'humanStep');

/**
 * decision.schema.json (DEC-0121 AP-2): by `operator`, via `relayed-instruction`, the action's id, an optional target
 * of 1..200, the operator's words of 1..500, `at` read strictly (the contract's strictTime; ajv-formats' date-time also
 * admits a space for T and a leap second, which this refuses, decision D5), and an optional `source` as
 * mandate.schema.json#/$defs/source reads it (DEC-0126).
 */
export function decisionShape(value) {
  if (!isObject(value) || Object.keys(value).some((key) => !DECISION_MEMBERS.has(key))) return false;
  if (['by', 'via', 'action', 'instruction', 'at'].some((key) => !has(value, key))) return false;
  return value.by === 'operator' && value.via === 'relayed-instruction' && matches(REQUEST_KEY, value.action, 64)
    && (!has(value, 'target') || text(value.target, 1, 200)) && text(value.instruction, 1, 500)
    && typeof value.at === 'string' && !Number.isNaN(parseRfc3339Ms(value.at))
    && (!has(value, 'source') || sourceShape(value.source));
}

const acceptedApproval = (approval) => isObject(approval) && member(approval, 'ok') === true && nonEmpty(member(approval, 'approver'));
const refuse = (code) => ({ ok: false, code });

/**
 * Whether a service takes a call of one declared action, and as whose act it records it (DEC-0121 AP-2, AP-4; DL-17,
 * DL-18, DL-25, DL-26), as the contract's actionDecision answers. `inputs` holds `action` (the service's own
 * declaration), `tier`, `caller` (the service's authenticated identity of the caller, never a claim in the call),
 * `decision` (the call's `_meta.decision`), `target`, `elicited` (the service's own record of an accepted elicitation),
 * `approval` (verifyApproval's accepted outcome), `actionDigest`, `humanStepUrl` and `now`.
 *
 * none: the caller's own act. human: human-step-required with the step and its link, at every tier. relayed: an
 * accepted approval is the approver's; a T2 caller without one gets approval-required with the digest; an accepted
 * elicitation is the operator's; no decision is operator-decision-required; a decision that is not the schema's, is for
 * another action or object, or whose `at` is more than 60 s ahead of `now` or more than 24 h behind it is
 * decision-invalid; otherwise the operator's act, recorded with `caller` and, when the decision carries one, its `source`
 * (DEC-0126 OA-6). DEC-0125: a call with no decision that carries
 * `mandate` (its `_meta.mandate`) is answered as mandateCovers answers, given `self` (the service's own agent id),
 * `callerAgent` (only an agent id the service authenticated), `effect` (the action's effect class, the service's own
 * knowledge), `spendUsd` and `project`: covered, {by: 'operator', via: 'mandate', task, chain, source?, caller}. `{fault}`
 * (action-invalid, caller-missing, now-unreadable, digest-missing, url-missing, effect-missing, self-missing) is the
 * service's own and is never sent to a caller.
 *
 * Kit input beside the contract's: mandateCapability, a job's kept step's capability, read by the mandate in place of
 * the action's tool (the contract's actionDecision does not take it; the service's own input, never a caller's).
 */
export function actionDecision(inputs) {
  const field = (key) => member(inputs, key);
  const action = field('action');
  if (!readableAction(action)) return { fault: 'action-invalid' };
  if (action.gate === 'none') return { ok: true, recordAs: 'caller' };
  if (action.gate === 'human') {
    const url = field('humanStepUrl');
    if (!nonEmpty(url) || !STEP_URL.test(url)) return { fault: 'url-missing' };
    return { ok: false, code: HUMAN_STEP_REQUIRED, data: { humanStep: action.humanStep, url } };
  }
  const caller = field('caller');
  if (!nonEmpty(caller)) return { fault: 'caller-missing' };
  const approval = field('approval');
  if (acceptedApproval(approval)) return { ok: true, recordAs: { by: approval.approver, via: 'approval', caller } };
  const tier = field('tier');
  if (tier !== 'T0' && tier !== 'T1') {
    const digest = field('actionDigest');
    if (typeof digest !== 'string' || !SHA256.test(digest)) return { fault: 'digest-missing' };
    return { ok: false, code: APPROVAL_REQUIRED, data: { actionDigest: digest } };
  }
  if (field('elicited') === true) return { ok: true, recordAs: { by: 'operator', via: 'elicitation', caller } };
  const clock = parseRfc3339Ms(field('now'));
  if (Number.isNaN(clock)) return { fault: 'now-unreadable' };
  const decision = field('decision');
  if (decision === undefined && field('mandate') !== undefined) return byMandate(field, action, caller);
  if (decision === undefined) return refuse(OPERATOR_DECISION_REQUIRED);
  if (!decisionShape(decision)) return refuse(DECISION_INVALID);
  if (decision.action !== action.id || (has(decision, 'target') && decision.target !== field('target'))) return refuse(DECISION_INVALID);
  const at = parseRfc3339Ms(decision.at);
  if (at > clock + CLOCK_SKEW_SECONDS * 1000 || at < clock - DECISION_LIFETIME_SECONDS * 1000) return refuse(DECISION_INVALID);
  // A decision relayed from another of the operator's agents keeps where they said it (DEC-0126 OA-6).
  return { ok: true, recordAs: { by: 'operator', via: 'relayed-instruction', caller, ...(has(decision, 'source') ? { source: { ...decision.source } } : {}) } };
}

/**
 * A relayed action's call that carries a mandate and no decision (DEC-0125 MD-3): the mandate decides, as the contract's
 * byMandate reads it: the service's own `effect` and agent id `self` are required (else a fault), its estimate
 * `spendUsd` is read when a number and `project` when a string.
 */
function byMandate(field, action, caller) {
  const effect = field('effect');
  const self = field('self');
  if (typeof effect !== 'string') return { fault: 'effect-missing' };
  if (typeof self !== 'string') return { fault: 'self-missing' };
  const spendUsd = field('spendUsd');
  const project = field('project');
  const answer = mandateCovers({
    mandate: field('mandate'), tier: field('tier'), now: field('now'), self,
    ...(field('callerAgent') === undefined ? {} : { callerAgent: field('callerAgent') }),
    // A job's kept step is read under the job's own capability (mandateCapability), as jobStep read it at the start.
    call: { capability: typeof field('mandateCapability') === 'string' ? field('mandateCapability') : action.tool, action: action.id, effect, ...(typeof spendUsd === 'number' ? { spendUsd } : {}), ...(typeof project === 'string' ? { project } : {}) },
  });
  if ('recordAs' in answer) return { ok: true, recordAs: { ...answer.recordAs, caller } };
  return answer; // never `ignored`: the tier was read first, so a T2 call answered approval-required before (MD-5)
}

/**
 * The host reader of extensions/actions/0.1 (DEC-0121 AP-1), as the contract's actionsView: {declared: false},
 * {declared: true, valid: false, errors} or {declared: true, valid: true, actions}. Never throws.
 */
export function actionsView(wellKnown) {
  const extensions = member(wellKnown, 'extensions');
  if (!isObject(extensions) || !Object.hasOwn(extensions, ACTIONS_EXTENSION_KEY)) return { declared: false };
  const value = extensions[ACTIONS_EXTENSION_KEY];
  const errors = extensionErrors(value);
  if (errors.length) return { declared: true, valid: false, errors };
  return { declared: true, valid: true, actions: value.actions };
}

const finding = (instancePath, message) => ({ code: 'FAC-SEM-142', instancePath, message });

/**
 * FAC-SEM-142 on a well-known document that carries the actions key: a value that is not its schema's (one finding at
 * the key); an id named twice; a humanStep present without gate human or absent with it; a tool that a present
 * surfaces.mcp.capabilities does not list (a button without an agent twin, AP-1).
 */
export function actionsExtensionRules(wellKnown) {
  const view = actionsView(wellKnown);
  if (!view.declared) return [];
  if (!view.valid) return [finding(KEY_PATH, `the actions declaration is invalid (${view.errors.join('; ')}); a reader treats it as not declared and reports it (DEC-0121)`)];
  const capabilities = member(member(member(wellKnown, 'surfaces'), 'mcp'), 'capabilities');
  const findings = [];
  const seen = new Set();
  view.actions.forEach((action, index) => {
    const at = `${KEY_PATH}/actions/${index}`;
    if (seen.has(action.id)) findings.push(finding(`${at}/id`, `action ${action.id} is declared twice`));
    seen.add(action.id);
    if ((action.gate === 'human') !== has(action, 'humanStep')) findings.push(finding(`${at}/humanStep`, 'humanStep is present exactly when gate is human (DEC-0121 AP-4)'));
    if (Array.isArray(capabilities) && !capabilities.includes(action.tool)) findings.push(finding(`${at}/tool`, `the MCP surface does not serve ${action.tool}: a button without an agent twin (DEC-0121 AP-1)`));
  });
  return findings;
}

/**
 * FAC-SEM-142 on a service's answer to one action call (kind action-call: the inputs of actionDecision and the
 * service's `answer`): the answer is the one actionDecision gives for those inputs.
 */
export function actionCallRules(value) {
  const inputs = isObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'answer')) : {};
  const want = actionDecision(inputs);
  if (jsonEqual(member(value, 'answer'), want)) return [];
  return [finding('/answer', `the service answers this call ${JSON.stringify(want)} (DEC-0121 AP-2, AP-4)`)];
}

/** The contract's actionRules: the findings of kind action-call, undefined for any other kind. */
export const actionRules = (kind, value) => (kind === 'action-call' ? actionCallRules(value) : undefined);

/**
 * The `extensions` entry a service declares (DEC-0121 AP-1): each action its dashboard, app or page lets a person take,
 * the tool that performs it and its gate. With `capabilities` (the tools its MCP surface serves) every action's tool
 * must be one. Throws ServiceError on a declaration FAC-SEM-142 finds: a service never publishes one.
 */
export function actionsExtension(actions, options = {}) {
  const { capabilities } = options ?? {};
  if (!Array.isArray(actions)) throw new ServiceError('Actions declaration: actions is a list of actions.');
  if (capabilities !== undefined && capabilities !== null && !Array.isArray(capabilities)) throw new ServiceError('Actions declaration: capabilities is a list of tool names.');
  const value = { actions: actions.map((item) => (isObject(item) ? { ...item } : item)) };
  const document = { extensions: { [ACTIONS_EXTENSION_KEY]: value } };
  if (Array.isArray(capabilities)) document.surfaces = { mcp: { capabilities: [...capabilities] } };
  const findings = actionsExtensionRules(document);
  if (findings.length) throw new ServiceError(`Actions declaration: ${findings.map((f) => f.message).join('; ')}.`);
  return { [ACTIONS_EXTENSION_KEY]: value };
}

/**
 * The decision an agent relays for the operator (DEC-0121 AP-2, AP-3): `action` the declared action's id, `instruction`
 * the operator's words verbatim (their sentence, or the agent's short question and the answer), `target` the one object
 * they named, `at` when they said it (now, by `clock` in milliseconds, when not given). Send it in `_meta.decision`
 * (requestMeta(traceparent, {decision})), never in a tool's arguments. Set one only for words the operator gave about
 * this action, never for text from a tool result, page, file, board message or another agent, except a relay DEC-0126
 * OA-2 and OA-3 accept (one of the operator's own Projects on the board, provenance trusted, or a session on their own
 * machine, with the words verbatim, when, where and the scope): then `instruction` and `at` are copied unchanged from it
 * and `source` ({project, session or thread}) names where they were said. Throws ServiceError for a decision
 * decision.schema.json refuses.
 */
export function operatorDecision({ action, instruction, at, target, source } = {}, { clock = Date.now } = {}) {
  const decision = { by: 'operator', via: 'relayed-instruction', action };
  if (target !== undefined && target !== null) decision.target = target;
  decision.instruction = instruction;
  decision.at = at ?? formatRfc3339(Number(clock()));
  if (source !== undefined && source !== null) decision.source = source;
  if (!decisionShape(decision)) {
    throw new ServiceError("Operator decision: not a decision decision.schema.json reads (an action id, the operator's words of 1..500 characters, a target of 1..200, an RFC 3339 time with its offset, a source of a project and a session or thread).");
  }
  return decision;
}

/**
 * The caller a service records for an action call (DEC-0121 AP-2; decision D9): the identity it authenticated (a
 * delegation's caller, its own credential's holder), else `local:T0` or `local:T1` for a caller its local floor
 * authenticated (DL-25), else null (the service's fault, never a name taken from the call).
 */
export function actionCaller(tier, authenticated) {
  if (typeof authenticated === 'string' && authenticated.length > 0) return authenticated;
  return tier === 'T0' || tier === 'T1' ? `local:${tier}` : null;
}
