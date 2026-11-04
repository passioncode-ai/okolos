export {
  renderOverview,
  ATTENTION_SHOWN,
  type AreaId,
  type AreaRow,
  type AttentionItem,
  type OverviewHandlers,
  type OverviewState,
} from './dashboard/overview.js'
export {
  mountBanner,
  type BannerHandle,
  type BannerHandlers,
  type BannerProps,
  type BannerVariant,
} from './banner/banner.js'
export {
  mountInspector,
  type InspectorHandle,
  type InspectorHandlers,
  type InspectorProps,
} from './inspector/inspector.js'
export {
  renderExtensions,
  type ExtensionRow,
  type ExtensionsHandlers,
  type ExtensionsState,
} from './extensions/extensions.js'
export {
  renderTrusted,
  type TrustedDomain,
  type TrustedHandlers,
} from './trusted/trusted.js'
export { renderQueue, type QueueHandlers } from './queue/queue.js'
export { renderLeaks, hibpAttribution, type LeaksHandlers, type LeaksState } from './leaks/leaks.js'
export { renderRecovery, type RecoveryHandlers } from './recovery/recovery.js'
export {
  mountComparison,
  type ComparisonHandle,
  type ComparisonHandlers,
  type ComparisonProps,
} from './comparison/comparison.js'
export {
  renderInterstitial,
  type InterstitialHandlers,
  type InterstitialProps,
} from './interstitial/interstitial.js'
export {
  renderJournal,
  type JournalHandlers,
  type JournalMeta,
} from './journal/journal.js'
export {
  renderPopup,
  type PageVerdict,
  type PopupHandlers,
  type PopupState,
} from './popup/popup.js'
export { mountGate, type GateHandle, type GateHandlers, type GateProps } from './gate/gate.js'
export {
  renderFirstRun,
  type CheckRow,
  type CheckState,
  type FirstRunHandlers,
  type FirstRunProps,
} from './first-run/screen.js'
export {
  renderSelfAudit,
  type AuditWindow,
  type PanelHandlers,
  type PanelState,
} from './self-audit/panel.js'
export {
  renderDataControls,
  type DataControlsHandlers,
  type LeakKeyPanel,
  type WipeOutcome,
} from './settings/data-controls.js'
export { shadowMode } from './shadow.js'
export {
  renderIncidentPicker,
  INCIDENT_LABEL_KEY,
  PICK_ORDER,
  type PickerHandlers,
} from './recovery/picker.js'
export { createOverlayHost, type OverlayHost } from './host.js'
export {
  renderStorageProblem,
  type StorageProblemHandlers,
  type StorageProblemKind,
  type StorageProblemProps,
} from './storage/storage-problem.js'

/**
 * How a stored instant reaches a person. Exported from the root rather than behind its own
 * path: unlike `./words`, whose whole point is to stay out of the worker's graph, both
 * consumers of this are surfaces that already pull the graph in.
 */
export { exactInstant, shortDate, shortTime } from './when.js'
