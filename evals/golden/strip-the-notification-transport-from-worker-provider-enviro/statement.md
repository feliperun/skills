fix(intent-factory): strip the notification transport from worker provider environments

The gate script built the provider environment from the controller's
ambient env, so PLAN_RUNNER_NOTIFY_BIN reached worker providers even
though the provider protocol carries no notification surface. Delete it
after the driver overlay so no driver can reintroduce it. Also widen the
Job.budgetStop type to include the wall_clock outcome the live loop
already produces.
