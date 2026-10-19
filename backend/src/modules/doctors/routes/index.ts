import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import { requireIfMatch } from '../../../middleware/optimistic-concurrency';
import * as doctorsController from '../controllers';

export const doctorsRouter = Router();

doctorsRouter.get('/me', authenticate, requireRole('doctor'), doctorsController.getMe);
doctorsRouter.patch('/me', authenticate, requireRole('doctor'), requireIfMatch, doctorsController.updateMe);
doctorsRouter.patch(
  '/:doctorProfileId/verification',
  authenticate,
  requireRole('admin'),
  doctorsController.setVerification,
);
