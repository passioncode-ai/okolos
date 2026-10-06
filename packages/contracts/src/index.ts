export type {
  Action,
  Confidence,
  Evidence,
  EvidenceKind,
  Severity,
  SourceRef,
  Stage,
  SubjectKind,
  Verdict,
  VerdictCategory,
} from './verdict.js'

export { SEVERITY_ORDER, worstOf } from './verdict.js'

export type {
  CarrierKind,
  CharClass,
  ConcealmentTechnique,
  HiddenTextCandidate,
  PageCandidates,
} from './snapshot.js'

export type { ActionInput } from './policy.js'
export { decideAction } from './policy.js'

export type {
  AuditEntry,
  Envelope,
  FrameFinding,
  FrameLine,
  PasswordAnswer,
  Purpose,
  RpcError,
  RpcMap,
  RpcType,
} from './rpc.js'
export { isEnvelope } from './rpc.js'
export type {
  ActionKind,
  AgentAction,
  GateChoice,
  GateDecision,
  GateOutcome,
  GateReason,
  UnresolvedFinding,
} from './gate.js'

export type {
  BridgeError,
  BridgeRefusal,
  BridgeResult,
  BridgeVerb,
  TaskProfile,
  TaskScope,
} from './bridge.js'
export {
  BRIDGE_REFUSALS,
  BRIDGE_VERBS,
  REFUSAL_RETRYABLE,
  SCOPE_LIMITS,
  inScope,
  originOf,
  refuse,
  validateScope,
} from './bridge.js'
