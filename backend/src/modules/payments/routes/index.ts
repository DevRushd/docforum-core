import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import { idempotency } from '../../../middleware/idempotency';
import * as paymentsController from '../controllers';

export const paymentsRouter = Router();

// Facility manages its own payout wallet.
paymentsRouter.post(
  '/wallet-link',
  authenticate,
  requireRole('facility'),
  requireVerifiedEmail,
  paymentsController.linkWallet,
);
paymentsRouter.get('/wallet-link', authenticate, requireRole('facility'), paymentsController.getOwnWallet);

// v1 (custodial, admin-triggered — see docs/adr/0004-custodial-payments-v1.md
// "Consequences"): Phase 4/5 (Orders/Fulfillment) don't exist yet, so
// there's no automatic trigger to wire these to. Restricted to admin
// rather than exposed as an open action.
//
// Every money-moving route requires a verified address (Phase 8, issue
// #34) — including the admin-only ones, since an admin account that can't
// receive mail can't complete the account lifecycle (invites, deactivation
// notices) this phase adds either.
//
// The four intent mutations additionally opt into `idempotency()` (Phase 8,
// issue #48), after authentication so the key can be namespaced per user.
// This is the belt to §4.10's braces: a retried `fund`/`release`/`refund`
// replays its first answer instead of pushing a second Stellar transaction
// (the reconcile job that would have to clean that up is issue #24, still
// open). It does not replace the conditional status write in
// `commitTransition` — two *different* keys racing the same transition still
// get exactly one winner and a 409 from the row-level guarantee.
paymentsRouter.post('/intents', authenticate, requireRole('admin'), requireVerifiedEmail, idempotency(), paymentsController.createIntent);
paymentsRouter.get('/intents/:id', authenticate, requireRole('admin'), paymentsController.getIntent);
paymentsRouter.post(
  '/intents/:id/fund',
  authenticate,
  requireRole('admin'),
  requireVerifiedEmail,
  idempotency(),
  paymentsController.fundIntent,
);
paymentsRouter.post(
  '/intents/:id/release',
  authenticate,
  requireRole('admin'),
  requireVerifiedEmail,
  idempotency(),
  paymentsController.releaseIntent,
);
paymentsRouter.post(
  '/intents/:id/refund',
  authenticate,
  requireRole('admin'),
  requireVerifiedEmail,
  idempotency(),
  paymentsController.refundIntent,
);
