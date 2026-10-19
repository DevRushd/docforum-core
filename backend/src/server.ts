import { createApp } from './app';
import { config } from './config';
import { pruneLoginAttempts } from './modules/auth/services';
import { pruneIdempotencyKeys } from './middleware/idempotency';
import { startPatientExportJobs } from './jobs/patient-exports';

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`docforum-core backend listening on :${config.port}`);
});

// Login-throttle cleanup (Phase 8, issue #35). A plain interval, per
// ARCHITECTURE_ESSENTIALS.md ("keep jobs simple until a real job exists —
// don't pre-install a queue"); `unref()` so it never keeps the process
// alive on shutdown. Lives here rather than in app.ts so test suites, which
// only build the app, don't start a timer.
const pruneTimer = setInterval(() => {
  void pruneLoginAttempts()
    .then((removed) => {
      if (removed > 0) {
        // eslint-disable-next-line no-console
        console.log(`[jobs] pruned ${removed} stale login-throttle row(s)`);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[jobs] login-throttle prune failed:', err);
    });
}, config.loginThrottle.pruneIntervalSeconds * 1000);
pruneTimer.unref();

// Replay-window cleanup for `Idempotency-Key` rows (Phase 8, issue #48).
// Purely housekeeping: the middleware already treats anything past its TTL as
// absent, so a missed run costs storage, never correctness.
const idempotencyPruneTimer = setInterval(() => {
  void pruneIdempotencyKeys()
    .then((removed) => {
      if (removed > 0) {
        // eslint-disable-next-line no-console
        console.log(`[jobs] pruned ${removed} expired idempotency key row(s)`);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[jobs] idempotency prune failed:', err);
    });
}, config.idempotency.pruneIntervalSeconds * 1000);
idempotencyPruneTimer.unref();

// Patient data export worker + expiry cleanup (Phase 8, issue #40).
startPatientExportJobs();
