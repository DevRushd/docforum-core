import type { Request, Response } from 'express';
import * as doctorsService from '../services';
import { setVerificationStatusSchema, updateDoctorProfileSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';
import { expectedVersion, setVersionEtag } from '../../../middleware/optimistic-concurrency';

export async function getMe(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const profile = await doctorsService.getMyDoctorProfile(req.user.id);
  setVersionEtag(res, profile.version);
  res.status(200).json(profile);
}

export async function updateMe(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { fullName } = updateDoctorProfileSchema.parse(req.body);
  const profile = await doctorsService.updateMyDoctorProfile(req.user.id, expectedVersion(req), fullName);
  setVersionEtag(res, profile.version);
  res.status(200).json(profile);
}

export async function setVerification(req: Request, res: Response) {
  const { status } = setVerificationStatusSchema.parse(req.body);
  const doctorProfileId = getParam(req, 'doctorProfileId');
  const profile = await doctorsService.setVerificationStatus(auditActor(req), doctorProfileId, status);
  res.status(200).json(profile);
}
