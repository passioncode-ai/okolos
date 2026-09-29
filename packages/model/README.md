# @okolos/model

Getting the classifier's weights onto the device — the half of the classifier
work where this product's promises actually apply.

A model is tens of megabytes fetched from someone else's server: exactly the
quiet network traffic the extension exists to make visible. So nothing is
downloaded without the user saying yes, the download goes through the same
egress point as everything else and shows up in the audit log as a model
update, and the payload is rejected unless its digest matches the pinned value —
a model file is executable weight in every sense that matters.

A cached model costs no request at all. A version bump discards the old bytes
first: two versions of a classifier in one cache is a bug nobody notices until
its verdicts disagree with themselves.

The ONNX session that consumes these bytes is a thin adapter and lives
elsewhere (REQ-37). Which weights to ship is not a code decision — see the
brief's human steps: the obvious candidate is licence-gated, and gated weights
cannot sit in a public repository.
